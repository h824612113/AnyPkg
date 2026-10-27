#!/usr/bin/env python3
"""
GPlay Downloader - Local Python Server
Downloads APKs from Google Play Store with direct browser downloads
Uses gpapi for proper protobuf parsing
"""

import os
# Fix protobuf compatibility issue with gpapi
os.environ['PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION'] = 'python'

import json
import base64
import re
from datetime import date
import logging
import threading
import time as time_module
import random
from flask import Flask, request, jsonify, send_file, Response

# Use gevent for parallel downloads (compatible with gunicorn gevent workers)
try:
    from gevent.pool import Pool as GeventPool
    HAS_GEVENT = True
except ImportError:
    HAS_GEVENT = False
from flask_cors import CORS
import requests
import cloudscraper

import partials  # 落盘断点：让重试/刷新后从断点续，而不是从 0 开始

# Thread-local scraper instances (thread-safe for concurrent requests)
_scraper_local = threading.local()


def get_scraper():
    """Get a thread-local HTTP session for fetching Play Store pages.

    cloudscraper 是为过 Cloudflare 挑战设计的，首次调用要做一轮挑战探测。
    实测 Play 网页版直接返回 200，这轮探测只会把 5s 的读超时吃满，
    所以换成普通 Session + 桌面浏览器 UA（代理由 run.sh 的环境变量负责）。
    """
    if not hasattr(_scraper_local, 'scraper'):
        session = requests.Session()
        session.headers.update({
            'User-Agent': ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                           'AppleWebKit/537.36 (KHTML, like Gecko) '
                           'Chrome/131.0.0.0 Safari/537.36'),
            'Accept-Language': 'en-US,en;q=0.9',
        })
        _scraper_local.scraper = session
    return _scraper_local.scraper


# Configure logging (INFO in production, DEBUG via env)
_log_level = os.environ.get('LOG_LEVEL', 'INFO').upper()
logging.basicConfig(level=getattr(logging, _log_level, logging.INFO), format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder='public', static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 1 * 1024 * 1024  # 1MB max request body

from werkzeug.middleware.proxy_fix import ProxyFix
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

_cors_origins = os.environ.get('CORS_ORIGINS', '')
if _cors_origins:
    CORS(app, origins=_cors_origins.split(','))


@app.after_request
def set_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
    csp = '; '.join([
        "default-src 'self'",
        f"script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net{_ANALYTICS_ORIGIN}",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https://play-lh.googleusercontent.com",
        f"connect-src 'self' https://*.google.com https://*.googleapis.com https://*.googleusercontent.com https://*.ggpht.com https://api.github.com{_ANALYTICS_ORIGIN}",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "worker-src 'self' blob:",
    ])
    response.headers['Content-Security-Policy'] = csp
    return response


# Import gpapi protobuf
try:
    from gpapi import googleplay_pb2
    HAS_GPAPI = True
except (ImportError, TypeError) as e:
    HAS_GPAPI = False
    print(f"Warning: gpapi not available ({e}). Using fallback parser.")

DISPENSER_URL = os.environ.get('DISPENSER_URL', '').strip()


def dispenser_config_error():
    """User-facing message if DISPENSER_URL is unusable, else None.

    A scheme-less URL would otherwise raise MissingSchema inside the token
    rotation loops and look like a transient per-token failure (PR #25).
    """
    if not DISPENSER_URL:
        return None  # no dispenser is a valid setup: Google account login works without one
    if not DISPENSER_URL.startswith(('http://', 'https://')):
        return (f"DISPENSER_URL is not a valid URL ({DISPENSER_URL!r}) - it must start with "
                "http:// or https://. Fix it, or unset it and sign in with a Google account.")
    return None


if not DISPENSER_URL:
    print("WARNING: DISPENSER_URL is not set. Sign in with a Google account (web UI top card or "
          "'gplay-downloader.py auth-account'), or configure a self-hosted dispenser. "
          "Do not use auroraoss.com (see issue #22).")
elif dispenser_config_error():
    print(f"WARNING: {dispenser_config_error()}")
FDFE_URL = 'https://android.clients.google.com/fdfe'
PURCHASE_URL = f'{FDFE_URL}/purchase'
DELIVERY_URL = f'{FDFE_URL}/delivery'
DETAILS_URL = f'{FDFE_URL}/details'

# Server-side auth cache files (per architecture)
from pathlib import Path
from contextlib import contextmanager
import fcntl

AUTH_CACHE_DIR = Path.home()
AUTH_CACHE_FILES = {
    'arm64-v8a': AUTH_CACHE_DIR / '.gplay-auth.json',  # Default for backward compat
    'armeabi-v7a': AUTH_CACHE_DIR / '.gplay-auth-armv7.json',
}


@contextmanager
def file_lock(file_path, exclusive=True):
    """Context manager for file locking (prevents race conditions)."""
    lock_path = Path(str(file_path) + '.lock')
    lock_fd = None
    try:
        lock_fd = open(lock_path, 'w')
        fcntl.flock(lock_fd, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield
    finally:
        if lock_fd:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            lock_fd.close()

# Import device profiles from centralized module
from device_profiles import (
    ARM64_PROFILES, ARMV7_PROFILES,
    DEFAULT_ARM64_PROFILE, DEFAULT_ARMV7_PROFILE,
    get_profile, get_all_profiles, get_priority_profiles,
)

# Legacy aliases for backward compatibility
DEVICE_ARM64 = DEFAULT_ARM64_PROFILE
DEVICE_ARMV7 = DEFAULT_ARMV7_PROFILE
DEFAULT_DEVICE = DEVICE_ARM64

SUPPORTED_ARCHS = ['arm64-v8a', 'armeabi-v7a']

# Blacklist: packages that are fully blocked from download, search, and app pages
BLACKLIST_FILE = Path(__file__).parent / 'public' / 'blacklist.json'

def _load_blacklist():
    try:
        data = json.loads(BLACKLIST_FILE.read_text())
        return set(data.get('packages', [])), data.get('message', 'This app is not available.')
    except (FileNotFoundError, json.JSONDecodeError):
        return set(), 'This app is not available.'

BLACKLISTED_PACKAGES, BLACKLIST_MESSAGE = _load_blacklist()


def is_blacklisted(pkg):
    """Return True if the package is blacklisted."""
    return pkg in BLACKLISTED_PACKAGES


def get_device_config(arch='arm64-v8a', profile_index=0):
    """Get device config for a specific architecture.

    Args:
        arch: 'arm64-v8a' or 'armeabi-v7a'
        profile_index: Index into the profile list (for fallback rotation)

    Returns:
        Device profile dict
    """
    if arch == 'armeabi-v7a':
        profiles = ARMV7_PROFILES
    else:
        profiles = ARM64_PROFILES

    # Use modulo to wrap around if index exceeds list length
    idx = profile_index % len(profiles)
    return profiles[idx][1].copy()


def get_priority_device_configs(arch='arm64-v8a'):
    """Get priority-ordered list of device profiles for an architecture.

    Returns profiles sorted by reliability (best first), with remaining
    profiles appended after.

    Args:
        arch: 'arm64-v8a' or 'armeabi-v7a'

    Returns:
        List of (profile_key, profile_dict) tuples
    """
    internal_arch = 'armv7' if arch == 'armeabi-v7a' else 'arm64'
    return get_priority_profiles(internal_arch)


def merge_apks(base_apk_bytes, split_apks_bytes_list):
    """Merge base APK with split APKs into a single installable APK.

    Uses APKEditor (REAndroid) for proper resource merging.

    Args:
        base_apk_bytes: Bytes of the base APK
        split_apks_bytes_list: List of (name, bytes) tuples for split APKs

    Returns:
        Bytes of the merged APK (unsigned)
    """
    import zipfile
    import io
    import subprocess
    import tempfile
    import shutil

    logger.info(f"merge_apks called with base ({len(base_apk_bytes)} bytes) and {len(split_apks_bytes_list)} splits")

    # Try APKEditor first (best results)
    apkeditor_jar = os.path.join(os.path.dirname(__file__), 'APKEditor.jar')
    if os.path.exists(apkeditor_jar):
        try:
            return merge_apks_with_apkeditor(base_apk_bytes, split_apks_bytes_list, apkeditor_jar)
        except Exception as e:
            logger.error(f"APKEditor merge failed: {e}, falling back to simple merge")
    else:
        logger.warning("APKEditor.jar not found, using simple merge")

    return merge_apks_simple(base_apk_bytes, split_apks_bytes_list)


def merge_apks_with_apkeditor(base_apk_bytes, split_apks_bytes_list, apkeditor_jar):
    """Use APKEditor to merge split APKs properly."""
    import subprocess
    import tempfile
    import shutil

    work_dir = tempfile.mkdtemp(prefix='apk_merge_')

    try:
        # Write base APK
        base_path = os.path.join(work_dir, 'base.apk')
        with open(base_path, 'wb') as f:
            f.write(base_apk_bytes)

        # Write split APKs
        for i, (name, data) in enumerate(split_apks_bytes_list):
            split_path = os.path.join(work_dir, f'split{i}.apk')
            with open(split_path, 'wb') as f:
                f.write(data)

        # Run APKEditor merge
        output_path = os.path.join(work_dir, 'merged.apk')
        result = subprocess.run(
            ['java', '-jar', apkeditor_jar, 'm', '-i', work_dir, '-o', output_path],
            capture_output=True, text=True, timeout=300
        )

        if result.returncode != 0:
            logger.error(f"APKEditor failed: {result.stderr}")
            raise Exception(f"APKEditor failed: {result.stderr}")

        if not os.path.exists(output_path):
            raise Exception("APKEditor did not produce output file")

        # Patch fused modules for asset pack splits (e.g. obbassets)
        from axml_patcher import get_asset_pack_split_names, patch_apk_fused_modules
        split_names = [name for name, _ in split_apks_bytes_list]
        asset_packs = get_asset_pack_split_names(split_names)
        if asset_packs:
            fused_value = ','.join(asset_packs)
            logger.info(f"Patching fused modules: {fused_value}")
            try:
                patch_apk_fused_modules(output_path, fused_value)
            except Exception as e:
                logger.warning(f"Fused modules patch failed: {e}")

        with open(output_path, 'rb') as f:
            merged_bytes = f.read()

        logger.info(f"APKEditor merge successful: {len(merged_bytes)} bytes")
        return merged_bytes

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def should_skip_meta_inf(name):
    """Skip signature files but keep META-INF/services and other important content."""
    if not name.startswith('META-INF/'):
        return False
    # Skip signature files
    if name.endswith(('.SF', '.RSA', '.DSA', '.EC', '.MF')):
        return True
    if name == 'META-INF/MANIFEST.MF':
        return True
    # Keep everything else (services, kotlin_module, version files, etc.)
    return False


def merge_apks_simple(base_apk_bytes, split_apks_bytes_list):
    """Simple merge without manifest patching."""
    import zipfile
    import io

    merged_files = {}

    with zipfile.ZipFile(io.BytesIO(base_apk_bytes), 'r') as base_zip:
        for name in base_zip.namelist():
            if should_skip_meta_inf(name):
                continue
            merged_files[name] = base_zip.read(name)

    for split_name, split_bytes in split_apks_bytes_list:
        with zipfile.ZipFile(io.BytesIO(split_bytes), 'r') as split_zip:
            for name in split_zip.namelist():
                if should_skip_meta_inf(name):
                    continue
                if name == 'AndroidManifest.xml':
                    continue
                if name.startswith('lib/') or name not in merged_files:
                    merged_files[name] = split_zip.read(name)

    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as merged_zip:
        for name, data in sorted(merged_files.items()):
            merged_zip.writestr(name, data)

    return output.getvalue()


def sign_apk(apk_bytes):
    """Sign an APK using apksigner with debug keystore.

    Returns signed APK bytes, or original bytes if signing fails.
    """
    import subprocess
    import tempfile
    import shutil

    keystore = Path.home() / '.android' / 'debug.keystore'
    if not keystore.exists():
        logger.warning("Debug keystore not found, returning unsigned APK")
        return apk_bytes

    # Check if apksigner is available
    if not shutil.which('apksigner'):
        logger.warning("apksigner not found, returning unsigned APK")
        return apk_bytes

    tmp_in_path = None
    tmp_out_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.apk', delete=False) as tmp_in:
            tmp_in.write(apk_bytes)
            tmp_in_path = tmp_in.name

        tmp_out_path = tmp_in_path + '.signed'

        # Sign with apksigner using debug keystore
        cmd = [
            'apksigner', 'sign',
            '--ks', str(keystore),
            '--ks-pass', 'pass:android',
            '--key-pass', 'pass:android',
            '--out', tmp_out_path,
            tmp_in_path
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

        if result.returncode == 0 and os.path.exists(tmp_out_path):
            with open(tmp_out_path, 'rb') as f:
                signed_bytes = f.read()
            logger.info("APK signed successfully")
            return signed_bytes
        else:
            logger.warning(f"apksigner failed: {result.stderr}")
            return apk_bytes

    except Exception as e:
        logger.error(f"APK signing failed: {e}")
        return apk_bytes
    finally:
        # Cleanup temp files
        for path in [tmp_in_path, tmp_out_path]:
            try:
                os.unlink(path)
            except Exception:
                pass


def format_size(bytes_size):
    if not bytes_size:
        return 'Unknown'
    units = ['B', 'KB', 'MB', 'GB']
    i = 0
    size = float(bytes_size)
    while size >= 1024 and i < len(units) - 1:
        size /= 1024
        i += 1
    return f'{size:.2f} {units[i]}'


def sanitize_filename(name):
    """Sanitize a filename for use in Content-Disposition headers."""
    name = name.replace('/', '_').replace('\\', '_').replace('\0', '')
    name = re.sub(r'[\r\n"]', '', name)
    name = os.path.basename(name)
    return name or 'download.apk'


# Valid Android package name: segments of [a-zA-Z][a-zA-Z0-9_]* separated by dots, max 255 chars
_PKG_RE = re.compile(r'^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$')


def validate_package_name(pkg):
    """Return True if pkg is a valid Android package name."""
    return bool(pkg and len(pkg) <= 255 and _PKG_RE.match(pkg))


def _require_valid_pkg(pkg):
    """Return a 400 JSON response if pkg is invalid or blacklisted, else None."""
    if not validate_package_name(pkg):
        return jsonify({'error': 'Invalid package name'}), 400
    if is_blacklisted(pkg):
        return jsonify({'error': BLACKLIST_MESSAGE}), 403
    return None


def get_cached_auth(arch='arm64-v8a'):
    """Load cached auth from server-side auth file for specific architecture (thread-safe)."""
    cache_file = AUTH_CACHE_FILES.get(arch, AUTH_CACHE_FILES['arm64-v8a'])
    if not cache_file.exists():
        return None

    try:
        with file_lock(cache_file, exclusive=False):  # Shared lock for reads
            with open(cache_file) as f:
                auth = json.load(f)
        if auth.get('authToken') and auth.get('gsfId'):
            logger.info(f"Using cached auth token for {arch}")
            return auth
    except Exception as e:
        logger.warning(f"Failed to load cached auth for {arch}: {e}")
    return None


def save_cached_auth(auth_data, arch='arm64-v8a'):
    """Save auth data to server-side cache file for specific architecture (thread-safe, atomic)."""
    cache_file = AUTH_CACHE_FILES.get(arch, AUTH_CACHE_FILES['arm64-v8a'])
    tmp_file = cache_file.with_suffix('.tmp')

    try:
        with file_lock(cache_file, exclusive=True):  # Exclusive lock for writes
            # Write to temp file first (atomic write pattern)
            tmp_file.write_text(json.dumps(auth_data, indent=2))
            os.chmod(str(tmp_file), 0o600)  # Restrict permissions before rename
            # Atomic rename
            tmp_file.replace(cache_file)
        logger.info(f"Auth saved to: {cache_file}")
        return True
    except Exception as e:
        logger.error(f"Failed to save auth: {e}")
        # Clean up temp file if it exists
        if tmp_file.exists():
            try:
                tmp_file.unlink()
            except Exception:
                pass
        return False


def refresh_personal_auth(arch='arm64-v8a'):
    """Rebuild a personal-account session from the stored long-lived AAS token.

    Personal sessions can go stale (details/delivery start returning empty);
    a rebuild takes a few seconds and needs no sign-in.
    """
    cached = get_cached_auth(arch)
    if not (cached and cached.get('accountType') == 'personal' and cached.get('aasToken')):
        return None
    import account_auth
    from device_profiles import NEWEST_ARMV7_PROFILE
    profile = NEWEST_ARMV7_PROFILE if arch == 'armeabi-v7a' else DEFAULT_ARM64_PROFILE
    try:
        logger.info(f'Refreshing personal-account session for {arch}...')
        auth = account_auth.build_auth_data(
            cached['email'], cached['aasToken'], device=profile,
            log=lambda m: logger.info(f'[google-refresh] {m}'))
        save_cached_auth(auth, arch)
        return auth
    except Exception as e:
        logger.warning(f'Personal auth refresh failed for {arch}: {e}')
        return None


def test_auth_token(auth, strict=False):
    """Test if an auth token works by making a simple API request.

    Args:
        auth: Auth data dict
        strict: If True, test against a stricter app (Chase) that requires better tokens
    """
    try:
        headers = get_auth_headers(auth)
        headers['Accept'] = 'application/x-protobuf'

        # Use a stricter test app - banking apps like Chase require better tokens
        # than simple apps like YouTube. If strict=True or default, use Chase.
        test_app = 'com.chase.sig.android' if strict else 'com.google.android.youtube'

        resp = requests.get(f'{DETAILS_URL}?doc={test_app}', headers=headers, timeout=10)
        if resp.status_code == 200:
            wrapper = googleplay_pb2.ResponseWrapper()
            wrapper.ParseFromString(resp.content)
            # Check if we got valid version info (not 0)
            vc = wrapper.payload.detailsResponse.docV2.details.appDetails.versionCode
            if vc > 0:
                logger.info(f"Auth token validated ({test_app} versionCode={vc})")
                return True
            else:
                logger.warning(f"Auth test returned versionCode=0 for {test_app}")
        else:
            logger.warning(f"Auth token test failed: status={resp.status_code}")
        return False
    except Exception as e:
        logger.warning(f"Auth token test error: {e}")
        return False


def get_auth_from_request(arch='arm64-v8a'):
    # Always prefer cached CLI auth since AuroraOSS dispenser tokens have limited permissions
    cached = get_cached_auth(arch)
    if cached:
        return cached

    # Fall back to request auth if no cached auth available
    auth_header = request.headers.get('Authorization', '')
    if auth_header:
        try:
            token = auth_header.replace('Bearer ', '')
            auth_data = json.loads(base64.b64decode(token).decode('utf-8'))
            if auth_data.get('authToken'):
                return auth_data
        except Exception:
            pass
    return None


def get_auth_headers(auth, accept_language='en-US'):
    """
    Build headers for Google Play API requests.
    Enhanced with additional headers from Aurora Store for better compatibility.
    """
    device_info = auth.get('deviceInfoProvider', {})
    locale = accept_language.replace('-', '_')

    headers = {
        'Authorization': f"Bearer {auth.get('authToken', '')}",
        'User-Agent': device_info.get('userAgentString', 'Android-Finsky/41.2.29-23 [0] [PR] 639844241 (api=3,versionCode=84122900,sdk=34,device=lynx,hardware=lynx,product=lynx,platformVersionRelease=14,model=Pixel%207a,buildId=UQ1A.231205.015,isWideScreen=0,supportedAbis=arm64-v8a;armeabi-v7a;armeabi)'),
        'X-DFE-Device-Id': auth.get('gsfId', ''),
        'Accept-Language': accept_language,
        'X-DFE-Encoded-Targets': 'CAESN/qigQYC2AMBFfUbyA7SM5Ij/CvfBoIDgxXrBPsDlQUdMfOLAfoFrwEHgAcBrQYhoA0cGt4MKK0Y2gI',
        'X-DFE-Phenotype': 'H4sIAAAAAAAAAB3OO3KjMAAA0KRNuWXukBkBQkAJ2MhgAZb5u2GCwQZbCH_EJ77QHmgvtDtbv-Z9_H63zXXU0NVPB1odlyGy7751Q3CitlPDvFd8lxhz3tpNmz7P92CFw73zdHU2Ie0Ad2kmR8lxhiErTFLt3RPGfJQHSDy7Clw10bg8kqf2owLokN4SecJTLoSwBnzQSd652_MOf2d1vKBNVedzg4ciPoLz2mQ8efGAgYeLou-l-PXn_7Sna1MfhHuySxt-4esulEDp8Sbq54CPPKjpANW-lkU2IZ0F92LBI-ukCKSptqeq1eXU96LD9nZfhKHdtjSWwJqUm_2r6pMHOxk01saVanmNopjX3YxQafC4iC6T55aRbC8nTI98AF_kItIQAJb5EQxnKTO7TZDWnr01HVPxelb9A2OWX6poidMWl16K54kcu_jhXw-JSBQkVcD_fPsLSZu6joIBAAA',
        'X-DFE-Client-Id': 'am-android-google',
        'X-DFE-Network-Type': '4',
        'X-DFE-Content-Filters': '',
        'X-Limit-Ad-Tracking-Enabled': 'false',
        'X-Ad-Id': '',
        'X-DFE-UserLanguages': locale,
        'X-DFE-Request-Params': 'timeoutMs=4000',
        'X-DFE-Cookie': auth.get('dfeCookie', ''),
        'X-DFE-No-Prefetch': 'true',
    }

    # Add optional tokens if available in auth data
    if auth.get('deviceCheckInConsistencyToken'):
        headers['X-DFE-Device-Checkin-Consistency-Token'] = auth['deviceCheckInConsistencyToken']
    if auth.get('deviceConfigToken'):
        headers['X-DFE-Device-Config-Token'] = auth['deviceConfigToken']
    if device_info.get('mccMnc'):
        headers['X-DFE-MCCMNC'] = device_info['mccMnc']

    return headers


def get_download_info(pkg, auth):
    """Get download info using proper protobuf parsing."""
    if not HAS_GPAPI:
        return {'error': 'gpapi library not installed'}

    headers = {
        **get_auth_headers(auth),
        'Content-Type': 'application/x-protobuf',
        'Accept': 'application/x-protobuf',
    }

    # Step 1: Get app details
    details_resp = requests.get(f'{DETAILS_URL}?doc={pkg}', headers=headers, timeout=(5, 15))
    if details_resp.status_code == 404:
        # 404 是「这个应用不在账号所属的商店区里」，换 token / 重登都没用
        return {'error': 'not_found'}
    if details_resp.status_code != 200:
        return {'error': f'http_{details_resp.status_code}'}

    # Parse details response with protobuf
    try:
        details_wrapper = googleplay_pb2.ResponseWrapper()
        details_wrapper.ParseFromString(details_resp.content)

        if not details_wrapper.payload.detailsResponse.docV2.docid:
            return {'error': 'not_found'}

        app = details_wrapper.payload.detailsResponse.docV2
        version_code = app.details.appDetails.versionCode
        version_string = app.details.appDetails.versionString
        title = app.title

        logger.info(f"Details for {pkg}: title={title}, versionCode={version_code}, versionString={version_string}")

        # Detect paid apps before attempting purchase/delivery
        for offer in app.offer:
            if offer.offerType == 1:
                logger.info(f"Offer for {pkg}: micros={offer.micros}, formatted=\"{offer.formattedAmount}\"")
                if offer.micros > 0:
                    logger.warning(f"Paid app detected: {pkg} costs {offer.formattedAmount} ({offer.micros} micros)")
                    return {'error': 'paid_app', 'formattedAmount': offer.formattedAmount or 'paid'}

        # versionCode=0 with a resolvable title means Play has no version
        # compatible with the registered (virtual) device. On a fresh session
        # this is a real incompatibility; on a stale session everything
        # returns 0, which the callers handle by refreshing once first.
        if version_code == 0:
            return {'error': 'incompatible',
                    'message': f'No compatible version of {title or pkg} for this device profile/architecture'}

    except Exception as e:
        return {'error': f'Failed to parse app details: {str(e)}'}

    # Step 2: Purchase (acquire free app)
    purchase_headers = {**headers, 'Content-Type': 'application/x-www-form-urlencoded'}
    purchase_data = f'doc={pkg}&ot=1&vc={version_code}'

    try:
        logger.info(f"Attempting purchase for {pkg} (vc={version_code})")
        purchase_resp = requests.post(PURCHASE_URL, headers=purchase_headers, data=purchase_data, timeout=(5, 15))
        logger.info(f"Purchase response status: {purchase_resp.status_code}")
        if purchase_resp.status_code not in [200, 204]:
            logger.warning(f"Purchase returned non-success status: {purchase_resp.status_code}")
            logger.debug(f"Purchase response content: {purchase_resp.content[:500]}")
    except Exception as e:
        logger.error(f"Purchase request failed: {type(e).__name__}: {e}")
        # Continue anyway - app might already be "purchased" or free

    # Step 3: Get delivery URL
    logger.info(f"Requesting delivery URL for {pkg}")
    delivery_resp = requests.get(
        f'{DELIVERY_URL}?doc={pkg}&ot=1&vc={version_code}',
        headers=headers,
        timeout=(5, 15)
    )

    logger.info(f"Delivery response status: {delivery_resp.status_code}")
    if delivery_resp.status_code != 200:
        logger.error(f"Delivery failed with status {delivery_resp.status_code}")
        logger.debug(f"Delivery response: {delivery_resp.content[:500]}")
        return {'error': f'Failed to get download URL: {delivery_resp.status_code}'}

    # Parse delivery response with protobuf
    try:
        delivery_wrapper = googleplay_pb2.ResponseWrapper()
        delivery_wrapper.ParseFromString(delivery_resp.content)

        delivery_data = delivery_wrapper.payload.deliveryResponse.appDeliveryData

        if not delivery_data.downloadUrl:
            logger.error(f"No downloadUrl in delivery response for {pkg}")
            logger.debug(f"Delivery data fields: downloadSize={delivery_data.downloadSize}, splits={len(delivery_data.split)}")
            # 这里是「应用层」失败：token 是好的，只是这个包在账号所属区拿不到
            # （下架 / 区域限制 / 需要先付费 / 与虚拟设备不兼容）。
            # 必须和「token 失效」区分开，否则上层会白重建一次会话再报一句误导的话。
            return {'error': 'no_delivery'}

        download_url = delivery_data.downloadUrl
        download_size = delivery_data.downloadSize

        # Get cookies
        cookies = []
        for cookie in delivery_data.downloadAuthCookie:
            cookies.append({'name': cookie.name, 'value': cookie.value})

        # Get split APKs
        splits = []
        for i, split in enumerate(delivery_data.split):
            if split.downloadUrl:
                splits.append({
                    'name': split.name or f'split{i}',
                    'downloadUrl': split.downloadUrl,
                    'size': split.size,
                })

        return {
            'docid': pkg,
            'title': title,
            'versionCode': version_code,
            'versionString': version_string,
            'downloadUrl': download_url,
            'downloadSize': download_size,
            'cookies': cookies,
            'splits': splits,
            'filename': f'{pkg}-{version_code}.apk'
        }

    except Exception as e:
        return {'error': f'Failed to parse delivery data: {str(e)}'}


SITE_URL = os.environ.get('SITE_URL', '').rstrip('/')
UMAMI_SCRIPT = os.environ.get('UMAMI_SCRIPT', '')
UMAMI_REPLAY_SCRIPT = os.environ.get('UMAMI_REPLAY_SCRIPT', '')
_ANALYTICS_ORIGIN = ''
if UMAMI_SCRIPT:
    _m = re.search(r'src="(https?://[^"/]+)', UMAMI_SCRIPT)
    if _m:
        _ANALYTICS_ORIGIN = ' ' + _m.group(1)


# Routes
@app.route('/')
def index():
    with open(os.path.join(app.static_folder, 'index.html'), 'r') as f:
        html = f.read()
    if SITE_URL:
        html = html.replace('__SITE_URL__', SITE_URL)
    else:
        # Strip SEO tags that need a domain
        import re
        html = re.sub(r'<link rel="canonical"[^>]*>\n?', '', html)
        html = re.sub(r'<meta property="og:url"[^>]*>\n?', '', html)
        html = re.sub(r'<meta property="og:image"[^>]*>\n?', '', html)
        html = re.sub(r'<meta name="twitter:image"[^>]*>\n?', '', html)
        html = re.sub(r'<script type="application/ld\+json">[^<]*__SITE_URL__[^<]*</script>\n?', '', html)
    if UMAMI_SCRIPT:
        html = html.replace('</head>', f'  {UMAMI_SCRIPT}\n</head>')
    if UMAMI_REPLAY_SCRIPT:
        html = html.replace('</head>', f'  {UMAMI_REPLAY_SCRIPT}\n</head>')
    return Response(html, content_type='text/html')


_DISABLE_APP_PAGES = os.environ.get('DISABLE_APP_PAGES', '') == '1'

if not _DISABLE_APP_PAGES:
    @app.route('/apps')
    @app.route('/apps/')
    def apps_browse():
        from app_pages import render_browse_page
        html = render_browse_page()
        if SITE_URL:
            html = html.replace('__SITE_URL__', SITE_URL)
        else:
            html = re.sub(r'<link rel="canonical"[^>]*>\n?', '', html)
            html = re.sub(r'<meta property="og:url"[^>]*>\n?', '', html)
            html = re.sub(r'<script type="application/ld\+json">[^<]*__SITE_URL__[^<]*</script>\n?', '', html)
        if UMAMI_SCRIPT:
            html = html.replace('</head>', f'  {UMAMI_SCRIPT}\n</head>')
        if UMAMI_REPLAY_SCRIPT:
            html = html.replace('</head>', f'  {UMAMI_REPLAY_SCRIPT}\n</head>')
        return Response(html, content_type='text/html')

    @app.route('/app/<path:pkg>')
    def app_page(pkg):
        if not re.match(r'^[a-zA-Z][a-zA-Z0-9_.]*$', pkg):
            return Response('Invalid package name', status=400, content_type='text/plain')
        if is_blacklisted(pkg):
            return Response('App not found. <a href="/">Try searching for it</a>.', status=404, content_type='text/html')
        from app_pages import render_app_page
        html = render_app_page(pkg)
        if not html:
            return Response('App not found. <a href="/">Try searching for it</a>.', status=404, content_type='text/html')
        if UMAMI_SCRIPT:
            html = html.replace('</head>', f'  {UMAMI_SCRIPT}\n</head>')
        if UMAMI_REPLAY_SCRIPT:
            html = html.replace('</head>', f'  {UMAMI_REPLAY_SCRIPT}\n</head>')
        return Response(html, content_type='text/html')


@app.route('/robots.txt')
def robots():
    with open(os.path.join(app.static_folder, 'robots.txt'), 'r') as f:
        txt = f.read()
    if SITE_URL:
        txt = txt.replace('__SITE_URL__', SITE_URL)
    else:
        txt = txt.replace('Sitemap: __SITE_URL__/sitemap.xml\n', '')
    return Response(txt, content_type='text/plain')


@app.route('/sitemap.xml')
def sitemap():
    if not SITE_URL:
        return Response('', status=404)
    with open(os.path.join(app.static_folder, 'sitemap.xml'), 'r') as f:
        xml = f.read().replace('__SITE_URL__', SITE_URL)
    # Inject cached app pages into sitemap
    if not _DISABLE_APP_PAGES:
        try:
            from app_pages import _load_meta
            meta = _load_meta()
            app_urls = ''.join(
                f'  <url><loc>{SITE_URL}/app/{pkg}</loc><lastmod>{date.today().isoformat()}</lastmod></url>\n'
                for pkg in meta
                if pkg not in BLACKLISTED_PACKAGES
                and re.match(r'^[a-zA-Z][a-zA-Z0-9_.]*$', pkg)
            )
            if app_urls:
                xml = xml.replace('</urlset>', app_urls + '</urlset>')
        except Exception:
            pass
    return Response(xml, content_type='application/xml')


@app.route('/health')
def health_check():
    """Health check endpoint for monitoring and load balancers."""
    import psutil

    try:
        # Check disk space for temp storage
        disk = psutil.disk_usage(str(TEMP_APK_DIR))
        disk_ok = disk.percent < 90

        # Check memory
        mem = psutil.virtual_memory()
        mem_ok = mem.percent < 90

        # Count active temp files
        with TEMP_APK_LOCK:
            temp_count = len(TEMP_APK_REGISTRY)
            temp_size = sum(m.get('size', 0) for m in TEMP_APK_REGISTRY.values())

        # Get semaphore availability
        download_slots = download_semaphore._value
        merge_slots = merge_semaphore._value

        status = {
            'status': 'healthy' if (disk_ok and mem_ok) else 'degraded',
            'gpapi_available': HAS_GPAPI,
            'temp_files': temp_count,
            'temp_size_mb': round(temp_size / 1024 / 1024, 2),
            'disk_percent': disk.percent,
            'memory_percent': mem.percent,
            'download_slots_available': download_slots,
            'download_slots_max': MAX_CONCURRENT_DOWNLOADS,
            'merge_slots_available': merge_slots,
            'merge_slots_max': MAX_CONCURRENT_MERGES,
        }

        code = 200 if status['status'] == 'healthy' else 503
        return jsonify(status), code

    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return jsonify({
            'status': 'error',
            'error': 'Health check failed'
        }), 500


@app.route('/api/stats')
def stats():
    """Return download count for the UI."""
    return jsonify({'downloads': get_download_count()})


# Per-worker rate limit cache; with ProxyFix, request.remote_addr is now the
# real client IP (via Cloudflare's X-Forwarded-For). Each gunicorn worker
# tracks independently; worst case is N workers allow N increments in 10s.
_last_increment = {}

@app.route('/api/stats/increment', methods=['POST'])
def stats_increment():
    """Increment download counter (for client-side installs like ADB)."""
    ip = request.remote_addr
    now = time_module.time()
    if ip in _last_increment and now - _last_increment[ip] < 10:
        return jsonify({'downloads': get_download_count()}), 429
    _last_increment[ip] = now
    # Periodic cleanup: remove stale entries to prevent unbounded growth
    if len(_last_increment) > 1000:
        stale = [k for k, v in _last_increment.items() if now - v > 60]
        for k in stale:
            del _last_increment[k]
    count = increment_download_count()
    return jsonify({'downloads': count})


@app.route('/api/auth', methods=['POST'])
def auth():
    # First check if we have a valid cached token - use strict validation (Chase test)
    cached = get_cached_auth()
    if cached and test_auth_token(cached, strict=True):
        logger.info("Using existing valid cached token (passed Chase test)")
        return jsonify({'success': True, 'authenticated': True, 'cached': True})

    # If we have a cached token that at least works for simple apps, use it
    # but warn that some apps may not work
    if cached and test_auth_token(cached, strict=False):
        logger.warning("Cached token works for simple apps (may have limited functionality)")
        return jsonify({'success': True, 'authenticated': True, 'cached': True, 'warning': 'Token may not work for all apps'})

    return jsonify({'error': 'No valid cached token. Use the streaming auth endpoint.'}), 400


@app.route('/api/auth/stream', methods=['GET'])
def auth_stream():
    """SSE endpoint that tries tokens with timeout protection."""
    def generate():
        start_time = time_module.time()

        # First check if we have a valid cached token
        cached = get_cached_auth()
        if cached and test_auth_token(cached, strict=True):
            logger.info("Using existing valid cached token (passed Chase test)")
            yield f"data: {json.dumps({'type': 'success', 'authenticated': True, 'cached': True, 'attempt': 0})}\n\n"
            return

        attempt = 0
        # Get priority-ordered profiles for rotation
        profiles = get_priority_device_configs('arm64-v8a')
        profile_count = len(profiles)
        max_attempts = profile_count * MAX_PROFILE_CYCLES

        _cfg_err = dispenser_config_error()
        if not DISPENSER_URL or _cfg_err:
            _msg = _cfg_err or 'Token failed and no dispenser is configured. Sign in with a Google account (top card) and try again.'
            yield f"data: {json.dumps({'type': 'error', 'message': _msg})}\n\n"
            return

        while True:
            # Check timeout
            if time_module.time() - start_time > SSE_MAX_DURATION:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Timeout - please try again'})}\n\n"
                return

            attempt += 1

            if attempt > max_attempts:
                yield f"data: {json.dumps({'type': 'error', 'message': f'Failed after trying all {profile_count} profiles {MAX_PROFILE_CYCLES} times'})}\n\n"
                return

            # Rotate through profiles
            profile_key, profile = profiles[(attempt - 1) % profile_count]
            profile_name = profile.get('UserReadableName', profile_key)

            # Send progress update
            yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Trying token #{attempt} ({profile_name})...'})}\n\n"

            scraper = None
            try:
                scraper = cloudscraper.create_scraper()  # Fresh scraper each attempt
                response = scraper.post(
                    DISPENSER_URL,
                    headers={
                        'User-Agent': 'com.aurora.store-4.6.1-70',
                        'Content-Type': 'application/json',
                    },
                    json=profile,
                    timeout=(5, 30)
                )

                if not response.ok:
                    logger.warning(f"Dispenser returned {response.status_code}, attempt {attempt} ({profile_name})")
                    yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} ({profile_name}) - dispenser error ({response.status_code})'})}\n\n"
                    time_module.sleep(1)
                    continue

                auth_data = response.json()

                # Send validation progress
                yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} ({profile_name}) - validating...'})}\n\n"

                # Test with strict validation (Chase) - this ensures token works for all apps
                if test_auth_token(auth_data, strict=True):
                    # Save the working token
                    save_cached_auth(auth_data)
                    logger.info(f"Token #{attempt} ({profile_name}) validated with Chase and saved")
                    yield f"data: {json.dumps({'type': 'success', 'authenticated': True, 'cached': False, 'attempt': attempt})}\n\n"
                    return
                else:
                    logger.warning(f"Token #{attempt} ({profile_name}) failed Chase validation")
                    yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} ({profile_name}) - failed validation, retrying...'})}\n\n"

            except requests.exceptions.ConnectionError as e:
                logger.warning(f"Connection error on auth attempt {attempt}: {e}")
                yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} - retrying connection...'})}\n\n"
                time_module.sleep(get_backoff_delay(attempt, base=2.0))
            except requests.exceptions.Timeout as e:
                logger.warning(f"Timeout on auth attempt {attempt}: {e}")
                yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} - request timeout, retrying...'})}\n\n"
                time_module.sleep(get_backoff_delay(attempt))
            except Exception as e:
                logger.warning(f"Auth attempt {attempt} failed: {e}")
                yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} - retrying...'})}\n\n"
                time_module.sleep(get_backoff_delay(attempt, base=0.5))
            finally:
                if scraper:
                    scraper.close()

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',  # Disable nginx buffering
        }
    )


def _build_personal_auth_armv7(email, token, log):
    """Register a second virtual device (ARMv7) so both arches can download."""
    import account_auth
    try:
        log('Registering a second virtual device for ARMv7 downloads...')
        from device_profiles import NEWEST_ARMV7_PROFILE
        return account_auth.build_auth_data(email, token,
                                            device=NEWEST_ARMV7_PROFILE, log=log)
    except Exception as e:
        log(f'ARMv7 device registration failed ({e}) - ARM64 downloads still work')
        return None


# Email + long-lived AAS token from the last successful browser sign-in,
# kept so retries and re-logins don't need the browser (or 2FA) again.
_google_login_state = {}


@app.route('/api/auth/google', methods=['POST'])
def auth_google():
    """Sign in with a personal (burner) Google account — no dispenser needed.

    Body: {"email": ..., "aasToken": "aas_et/..."} or {"email": ..., "oauthToken": "oauth2_4/..."}
    Streams SSE-format progress events (consumed via fetch + ReadableStream).
    """
    import queue as queue_module
    import account_auth

    payload = request.get_json(silent=True) or {}
    email = (payload.get('email') or '').strip()
    aas_token = (payload.get('aasToken') or '').strip()
    oauth_token = (payload.get('oauthToken') or '').strip()
    use_browser = bool(payload.get('browser'))
    # 只是把邮箱预填进登录页，省一次手输；不改变「必须登录一次」这件事
    login_hint = (payload.get('loginHint') or '').strip() or None
    # 账号密码直登：不弹浏览器，直接走 ac2dm 换 token
    password = payload.get('password') or ''

    if password and not email:
        return jsonify({'error': 'password requires email'}), 400
    if not use_browser and not password and (not email or not (aas_token or oauth_token)):
        return jsonify({'error': 'email plus aasToken / oauthToken / password is required (or set browser: true)'}), 400
    if use_browser and not account_auth.find_browser():
        return jsonify({'error': 'No Chromium-based browser found on the server machine. '
                                 'Browser sign-in only works when the server runs on your own computer; '
                                 'use the manual oauth_token flow instead.'}), 400

    def generate():
        q = queue_module.Queue()
        result = {}

        def log(msg):
            logger.info(f"[google-login] {msg}")
            q.put({'type': 'progress', 'message': msg})

        def worker():
            try:
                acct_email = email
                token = aas_token
                otoken = oauth_token
                if password and email and not token and not otoken:
                    # 有密码就不需要窗口；这条和浏览器登录拿的是同一种长期 token
                    token = account_auth.login_with_password(email, password, log=log)
                    _google_login_state.update({'email': email, 'aasToken': token})
                if use_browser and not token and not otoken:
                    # A long-lived AAS token from an earlier sign-in lets us skip
                    # the browser (and any 2-step verification) entirely.
                    # 指定了账号时不走缓存——否则登进去的是上一次那个号。
                    if not login_hint and not _google_login_state.get('aasToken'):
                        prev = get_cached_auth()
                        if prev and prev.get('accountType') == 'personal' and prev.get('aasToken'):
                            _google_login_state.update({'email': prev['email'], 'aasToken': prev['aasToken']})
                    if not login_hint and _google_login_state.get('aasToken'):
                        try:
                            log(f"Found AAS token from a previous sign-in ({_google_login_state['email']}) - retrying without the browser")
                            result['auth'] = account_auth.build_auth_data(
                                _google_login_state['email'], _google_login_state['aasToken'], log=log)
                            result['auth_armv7'] = _build_personal_auth_armv7(
                                _google_login_state['email'], _google_login_state['aasToken'], log)
                            result['email'] = _google_login_state['email']
                            return
                        except account_auth.AccountAuthError as e:
                            log(f"Stored AAS token no longer works ({e}) - opening browser sign-in")
                            _google_login_state.clear()
                    scraped_email, otoken = account_auth.capture_oauth_token_via_browser(
                        log=log, login_hint=login_hint)
                    acct_email = acct_email or scraped_email
                    if not acct_email:
                        raise account_auth.AccountAuthError(
                            'Could not detect the account email automatically - '
                            'fill in the email field and try again')
                if not token:
                    token = account_auth.exchange_oauth_token(acct_email, otoken, log=log)
                    # Keep the long-lived token so a failure later in the flow
                    # (or a future re-login) does not need another sign-in.
                    _google_login_state.update({'email': acct_email, 'aasToken': token})
                result['auth'] = account_auth.build_auth_data(acct_email, token, log=log)
                result['auth_armv7'] = _build_personal_auth_armv7(acct_email, token, log)
                result['email'] = acct_email
            except Exception as e:
                result['error'] = str(e)
            finally:
                q.put(None)

        threading.Thread(target=worker, daemon=True).start()
        while True:
            item = q.get()
            if item is None:
                break
            yield f"data: {json.dumps(item)}\n\n"

        if 'auth' in result:
            auth_data = result['auth']
            save_cached_auth(auth_data)
            if result.get('auth_armv7'):
                save_cached_auth(result['auth_armv7'], 'armeabi-v7a')
            yield f"data: {json.dumps({'type': 'progress', 'message': 'Auth saved. Validating token against Play API...'})}\n\n"
            valid = test_auth_token(auth_data)
            yield f"data: {json.dumps({'type': 'success', 'authenticated': True, 'email': result.get('email', email), 'validated': bool(valid), 'aasToken': auth_data.get('aasToken', '')})}\n\n"
        else:
            yield f"data: {json.dumps({'type': 'error', 'message': result.get('error', 'unknown error')})}\n\n"

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/api/auth/status')
def auth_status():
    auth = get_auth_from_request()
    resp = {'authenticated': bool(auth and auth.get('authToken'))}
    if auth and auth.get('accountType') == 'personal':
        resp['accountType'] = 'personal'
        resp['email'] = auth.get('email', '')
    return jsonify(resp)


@app.route('/api/auth/google/logout', methods=['POST'])
def auth_google_logout():
    """Sign out: remove cached personal-account auth and the stored AAS token."""
    _google_login_state.clear()
    removed = []
    for arch, cache_file in AUTH_CACHE_FILES.items():
        try:
            if cache_file.exists():
                auth = json.loads(cache_file.read_text())
                if auth.get('accountType') == 'personal':
                    cache_file.unlink()
                    removed.append(arch)
        except Exception as e:
            logger.warning(f'Logout: could not remove {cache_file}: {e}')
    logger.info(f'[google-login] Signed out (cleared: {removed or "nothing"})')
    return jsonify({'success': True, 'cleared': removed})


_search_rate = {}  # {ip: [timestamps]}
SEARCH_RATE_LIMIT = 10  # max searches per minute per IP
SEARCH_RATE_WINDOW = 60  # seconds

@app.route('/api/search')
def search():
    query = request.args.get('q', '')
    if not query:
        return jsonify({'error': 'Query required'}), 400
    if len(query) > 200:
        return jsonify({'error': 'Query too long (max 200 characters)'}), 400

    # Per-IP search rate limit
    ip = request.remote_addr
    now = time_module.time()
    timestamps = [t for t in _search_rate.get(ip, []) if now - t < SEARCH_RATE_WINDOW]
    if len(timestamps) >= SEARCH_RATE_LIMIT:
        return jsonify({'error': 'Too many searches, please wait'}), 429
    timestamps.append(now)
    _search_rate[ip] = timestamps
    # Periodic cleanup
    if len(_search_rate) > 5000:
        stale_ips = [k for k, v in _search_rate.items() if not any(now - t < SEARCH_RATE_WINDOW for t in v)]
        for k in stale_ips:
            del _search_rate[k]

    # Normalize query for better cache hits
    normalized_query = normalize_search_query(query)

    # Check cache first (6 hour TTL)
    cached_results = get_cached_search(normalized_query)
    if cached_results is not None:
        return jsonify({'results': cached_results, 'cached': True})

    try:
        response = get_scraper().get(
            'https://play.google.com/store/search',
            params={'q': query, 'c': 'apps'},
            timeout=(15, 40)
        )
        html = response.text

        results = []
        seen = set()

        def decode_html(text):
            return text.replace('&amp;', '&').replace('&#39;', "'").replace('&quot;', '"')

        def decode_json(text):
            return text.replace('\\u0026', '&').replace("\\u0027", "'").replace('\\u003d', '=')

        def upgrade_icon(url):
            url = re.sub(r'=s\d+', '=s128', url)
            url = re.sub(r'=w\d+', '=s128', url)
            return url

        # Method 1: Try HTML patterns first (some pages use these)
        # Featured app (class="vWM94c" for title)
        featured = re.search(
            r'href="/store/apps/details\?id=([^"&]+)"[^>]*>.*?'
            r'<img[^>]*src="(https://play-lh\.googleusercontent\.com/[^"]+)"[^>]*>.*?'
            r'<div class="vWM94c">([^<]+)</div>',
            html, re.DOTALL
        )
        if featured:
            pkg, icon, title = featured.groups()
            if pkg not in seen:
                seen.add(pkg)
                results.append({
                    'package': pkg,
                    'title': decode_html(title),
                    'icon': upgrade_icon(icon)
                })

        # Related apps (class="Epkrse" for title)
        for match in re.finditer(
            r'href="/store/apps/details\?id=([^"&]+)"[^>]*>.*?'
            r'<img[^>]*src="(https://play-lh\.googleusercontent\.com/[^"=]+=[sw]\d+[^"]*)"[^>]*>.*?'
            r'class="Epkrse\s*">([^<]+)</div>',
            html, re.DOTALL
        ):
            pkg, icon, title = match.groups()
            if pkg not in seen and len(results) < 10:
                seen.add(pkg)
                results.append({
                    'package': pkg,
                    'title': decode_html(title),
                    'icon': upgrade_icon(icon)
                })

        # Method 2: If HTML patterns didn't work, try embedded JSON data
        if len(results) < 3:
            # Find packages in JSON format: [["com.package.name",7],[null,2,...
            packages = re.findall(r'\[\["(com\.[a-zA-Z0-9_.]+)",7\],\[null,2', html)
            for pkg in packages:
                if pkg in seen or len(results) >= 10:
                    continue

                # Find title: package...],..."Title",[rating
                title_pattern = rf'\[\["{re.escape(pkg)}",7\].*?\],"([^"]+)",\["[0-9.]+",\s*[0-9.]+'
                title_match = re.search(title_pattern, html)

                # Find icon right after package: [["pkg",7],[null,2,null/[size],[null,null,"URL"]
                icon_pattern = rf'\[\["{re.escape(pkg)}",7\],\[null,2,(?:null|\[[0-9]+,[0-9]+\]),\[null,null,"(https://play-lh\.googleusercontent\.com/[^"]+)"\]'
                icon_match = re.search(icon_pattern, html)

                if title_match:
                    seen.add(pkg)
                    title = decode_json(title_match.group(1))
                    icon = None
                    if icon_match:
                        icon = decode_json(icon_match.group(1))
                        icon = upgrade_icon(icon)
                    results.append({
                        'package': pkg,
                        'title': title,
                        'icon': icon
                    })

        # Filter out blacklisted packages before finalizing
        results = [r for r in results if not is_blacklisted(r.get('package', ''))]
        final_results = results[:5]
        # Cache the results for future requests
        cache_search(normalized_query, final_results)

        # Trigger catalog enrichment for all search results
        if not _DISABLE_APP_PAGES:
            try:
                from app_pages import on_download_success
                for r in final_results:
                    on_download_success(r['package'], r.get('title', r['package']), r.get('icon'))
            except Exception:
                pass

        return jsonify({'results': final_results})
    except Exception as e:
        logger.error(f"Search failed for '{query}': {e}")
        return jsonify({'error': 'Search failed, please try again'}), 500


@app.route('/api/info/<path:pkg>')
def info(pkg):
    err = _require_valid_pkg(pkg)
    if err:
        return err

    # Trigger catalog enrichment early
    if not _DISABLE_APP_PAGES:
        try:
            from app_pages import on_download_success
            on_download_success(pkg, pkg)
        except Exception:
            pass

    try:
        response = get_scraper().get(
            f'https://play.google.com/store/apps/details?id={pkg}&hl=en',
            timeout=(5, 30)
        )

        if response.status_code == 404:
            return jsonify({'error': 'App not found'}), 404

        html = response.text

        # 标题优先取 og:title：页面正文里的 h1 现在套了一层 span，
        # 老正则 `<h1[^>]*>([^<]+)</h1>` 匹配不到，结果只能退回包名
        from html import unescape
        title = ''
        og = re.search(r'<meta property="og:title" content="([^"]+)"', html)
        if og:
            title = unescape(og.group(1))
            title = re.sub(r'\s*-\s*Apps on Google Play\s*$', '', title).strip()
        if not title:
            h1 = re.search(r'<h1[^>]*>(.*?)</h1>', html, re.S)
            if h1:
                title = unescape(re.sub(r'<[^>]+>', '', h1.group(1))).strip()

        dev_match = re.search(r'<a[^>]*href="/store/apps/developer[^"]*"[^>]*>([^<]+)</a>', html)

        return jsonify({
            'package': pkg,
            'title': title or pkg,
            'developer': unescape(dev_match.group(1)) if dev_match else 'Unknown',
            'playStoreUrl': f'https://play.google.com/store/apps/details?id={pkg}'
        })
    except Exception as e:
        logger.error(f"Info lookup failed for {pkg}: {e}")
        return jsonify({'error': 'Failed to get app info'}), 500


@app.route('/api/download-info/<path:pkg>')
def download_info(pkg):
    err = _require_valid_pkg(pkg)
    if err:
        return err

    # Trigger catalog enrichment early, before download attempt
    if not _DISABLE_APP_PAGES:
        try:
            from app_pages import on_download_success
            on_download_success(pkg, pkg)
        except Exception:
            pass

    auth = get_auth_from_request()
    if not auth:
        return jsonify({'error': 'Not authenticated'}), 401

    try:
        info = get_download_info(pkg, auth)
        if 'error' in info:
            return jsonify(info), 400

        total_size = info['downloadSize'] + sum(s.get('size', 0) for s in info['splits'])
        return jsonify({
            'success': True,
            'filename': info['filename'],
            'title': info['title'],
            'version': info['versionString'],
            'versionCode': info['versionCode'],
            'size': format_size(total_size),
            'downloadUrl': info['downloadUrl'],
            'cookies': info['cookies'],
            'splits': [{
                'filename': f"{pkg}-{info['versionCode']}-{s['name']}.apk",
                'name': s['name'],
                'downloadUrl': s['downloadUrl'],
                'size': s.get('size', 0),
            } for s in info['splits']]
        })
    except Exception as e:
        logger.error(f"Download info failed for {pkg}: {e}")
        return jsonify({'error': 'Failed to get download info'}), 500


@app.route('/api/download-info-stream/<path:pkg>')
def download_info_stream(pkg):
    """SSE endpoint that tries tokens until download URL is obtained (with timeout protection)."""
    err = _require_valid_pkg(pkg)
    if err:
        return err

    # Trigger catalog enrichment early, before download attempt
    if not _DISABLE_APP_PAGES:
        try:
            from app_pages import on_download_success
            on_download_success(pkg, pkg)
        except Exception:
            pass

    # Get architecture from query parameter
    arch = request.args.get('arch', 'arm64-v8a')
    if arch not in SUPPORTED_ARCHS:
        arch = 'arm64-v8a'

    # Get priority-ordered profiles for this architecture
    profiles = get_priority_device_configs(arch)
    profile_count = len(profiles)

    def generate():
        start_time = time_module.time()
        attempt = 0
        max_attempts = profile_count * MAX_PROFILE_CYCLES

        # Try cached token, then (once) a refreshed personal-account session
        cached = get_cached_auth(arch)
        refresh_allowed = True
        while cached:
            yield f"data: {json.dumps({'type': 'progress', 'attempt': 0, 'message': 'Trying cached token...'})}\n\n"
            try:
                info = get_download_info(pkg, cached)
                if info.get('error') == 'paid_app':
                    price = info.get('formattedAmount', 'paid')
                    logger.warning(f"Paid app fast-fail: {pkg} ({price})")
                    yield f"data: {json.dumps({'type': 'error', 'message': f'This app is not free ({price}). Only free apps can be downloaded.'})}\n\n"
                    return
                if 'error' not in info:
                    logger.info(f"Cached token worked for {pkg}")
                    total_size = info['downloadSize'] + sum(s.get('size', 0) for s in info['splits'])
                    result = {
                        'type': 'success',
                        'attempt': 0,
                        'filename': info['filename'],
                        'title': info['title'],
                        'version': info['versionString'],
                        'versionCode': info['versionCode'],
                        'size': format_size(total_size),
                        'downloadUrl': info['downloadUrl'],
                        'cookies': info['cookies'],
                        'splits': [{
                            'filename': f"{pkg}-{info['versionCode']}-{s['name']}.apk",
                            'name': s['name'],
                            'downloadUrl': s['downloadUrl'],
                            'size': s.get('size', 0),
                        } for s in info['splits']]
                    }
                    yield f"data: {json.dumps(result)}\n\n"
                    return
                else:
                    if refresh_allowed:
                        refresh_allowed = False
                        cached = refresh_personal_auth(arch)
                        if cached:
                            yield f"data: {json.dumps({'type': 'progress', 'attempt': 0, 'message': 'Cached token failed - refreshed Google account session, retrying...'})}\n\n"
                            continue
                    if info.get('error') == 'incompatible':
                        # Session is fresh (already refreshed) and Play still
                        # reports no version for this device: a real incompatibility
                        yield f"data: {json.dumps({'type': 'error', 'message': info.get('message', 'App is not available for this device/architecture')})}\n\n"
                        return
                    _errname = info.get('error', 'unknown error')
                    yield f"data: {json.dumps({'type': 'progress', 'attempt': 0, 'message': 'Cached token failed (' + str(_errname) + '), trying new tokens...'})}\n\n"
                    break
            except Exception as e:
                logger.warning(f"Cached token error for {pkg}: {e}")
                if refresh_allowed:
                    refresh_allowed = False
                    cached = refresh_personal_auth(arch)
                    if cached:
                        yield f"data: {json.dumps({'type': 'progress', 'attempt': 0, 'message': 'Cached token error - refreshed Google account session, retrying...'})}\n\n"
                        continue
                yield f"data: {json.dumps({'type': 'progress', 'attempt': 0, 'message': 'Cached token error, trying new tokens...'})}\n\n"
                break

        _cfg_err = dispenser_config_error()
        if not DISPENSER_URL or _cfg_err:
            _msg = _cfg_err or 'Token failed and no dispenser is configured. Sign in with a Google account (top card) and try again.'
            yield f"data: {json.dumps({'type': 'error', 'message': _msg})}\n\n"
            return

        while True:
            # Check timeout
            if time_module.time() - start_time > SSE_MAX_DURATION:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Timeout - please try again'})}\n\n"
                return

            attempt += 1

            if attempt > max_attempts:
                yield f"data: {json.dumps({'type': 'error', 'message': f'Failed after trying all {profile_count} profiles {MAX_PROFILE_CYCLES} times'})}\n\n"
                return

            # Rotate through profiles
            profile_key, profile = profiles[(attempt - 1) % profile_count]
            profile_name = profile.get('UserReadableName', profile_key)

            yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Trying token #{attempt} ({profile_name})...'})}\n\n"

            scraper = None
            try:
                # Get a fresh token from dispenser with profile rotation
                scraper = cloudscraper.create_scraper()  # Fresh scraper each attempt
                response = scraper.post(
                    DISPENSER_URL,
                    headers={
                        'User-Agent': 'com.aurora.store-4.6.1-70',
                        'Content-Type': 'application/json',
                    },
                    json=profile,
                    timeout=(5, 30)
                )

                if not response.ok:
                    logger.warning(f"Dispenser returned {response.status_code}, attempt {attempt} ({profile_name})")
                    yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} ({profile_name}) - dispenser error ({response.status_code})'})}\n\n"
                    time_module.sleep(1)
                    continue

                auth_data = response.json()

                yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} ({profile_name}) - getting download info...'})}\n\n"

                # Try to get download info with this token
                info = get_download_info(pkg, auth_data)

                if 'error' in info:
                    if info['error'] == 'paid_app':
                        price = info.get('formattedAmount', 'paid')
                        logger.warning(f"Paid app fast-fail: {pkg} ({price})")
                        yield f"data: {json.dumps({'type': 'error', 'message': f'This app is not free ({price}). Only free apps can be downloaded.'})}\n\n"
                        return
                    error_msg = info['error'][:50]
                    logger.warning(f"Token #{attempt} ({profile_name}) failed for {pkg}: {info['error']}")
                    yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} ({profile_name}) - {error_msg}'})}\n\n"
                    time_module.sleep(0.5)
                    continue

                # Success! Save the working token for this arch and return info
                save_cached_auth(auth_data, arch)
                logger.info(f"Token #{attempt} ({profile_name}) worked for {pkg}")

                total_size = info['downloadSize'] + sum(s.get('size', 0) for s in info['splits'])
                result = {
                    'type': 'success',
                    'attempt': attempt,
                    'filename': info['filename'],
                    'title': info['title'],
                    'version': info['versionString'],
                    'versionCode': info['versionCode'],
                    'size': format_size(total_size),
                    'downloadUrl': info['downloadUrl'],
                    'cookies': info['cookies'],
                    'splits': [{
                        'filename': f"{pkg}-{info['versionCode']}-{s['name']}.apk",
                        'name': s['name'],
                        'downloadUrl': s['downloadUrl'],
                        'size': s.get('size', 0),
                    } for s in info['splits']]
                }
                yield f"data: {json.dumps(result)}\n\n"
                return

            except requests.exceptions.ConnectionError as e:
                logger.warning(f"Connection error on attempt {attempt}: {e}")
                yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} - retrying connection...'})}\n\n"
                time_module.sleep(get_backoff_delay(attempt, base=2.0))
            except requests.exceptions.Timeout as e:
                logger.warning(f"Timeout on attempt {attempt}: {e}")
                yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} - request timeout, retrying...'})}\n\n"
                time_module.sleep(get_backoff_delay(attempt))
            except Exception as e:
                logger.warning(f"Download info attempt {attempt} failed: {e}")
                yield f"data: {json.dumps({'type': 'progress', 'attempt': attempt, 'message': f'Token #{attempt} - retrying...'})}\n\n"
                time_module.sleep(get_backoff_delay(attempt, base=0.5))
            finally:
                if scraper:
                    scraper.close()

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        }
    )


@app.route('/download/<path:pkg>')
@app.route('/download/<path:pkg>/<int:split_index>')
def download(pkg, split_index=None):
    """Proxy download for when direct download fails."""
    err = _require_valid_pkg(pkg)
    if err:
        return err
    arch = request.args.get('arch', 'arm64-v8a')
    if arch not in SUPPORTED_ARCHS:
        arch = 'arm64-v8a'
    auth = get_auth_from_request(arch)
    if not auth:
        return jsonify({'error': 'Not authenticated'}), 401

    try:
        info = get_download_info(pkg, auth)
        if 'error' in info:
            return jsonify(info), 400

        if split_index is not None and info['splits'] and split_index < len(info['splits']):
            url = info['splits'][split_index]['downloadUrl']
            filename = f"{pkg}-{info['versionCode']}-{info['splits'][split_index]['name']}.apk"
        else:
            url = info['downloadUrl']
            filename = info['filename']

        # Build cookie header
        cookie_header = '; '.join([f"{c['name']}={c['value']}" for c in info.get('cookies', [])])
        headers = {'Cookie': cookie_header} if cookie_header else {}

        # Stream the download
        resp = requests.get(url, headers=headers, stream=True, timeout=60)

        def generate():
            try:
                for chunk in resp.iter_content(chunk_size=8192):
                    yield chunk
            finally:
                resp.close()

        return Response(
            generate(),
            content_type='application/vnd.android.package-archive',
            headers={'Content-Disposition': f'attachment; filename="{sanitize_filename(filename)}"'}
        )
    except Exception as e:
        logger.error(f"Proxy download failed for {pkg}: {e}")
        return jsonify({'error': 'Download failed'}), 500


import tempfile
import uuid

# =============================================================================
# Download Counter (persistent, file-based)
# =============================================================================

DOWNLOAD_COUNTER_FILE = Path.home() / '.gplay-download-count'


def get_download_count():
    """Read the current download count."""
    try:
        with file_lock(DOWNLOAD_COUNTER_FILE, exclusive=False):
            return int(DOWNLOAD_COUNTER_FILE.read_text().strip())
    except Exception:
        return 0


def increment_download_count():
    """Atomically increment the download counter (safe across gunicorn workers)."""
    try:
        with file_lock(DOWNLOAD_COUNTER_FILE, exclusive=True):
            try:
                count = int(DOWNLOAD_COUNTER_FILE.read_text().strip()) + 1
            except Exception:
                count = 1
            DOWNLOAD_COUNTER_FILE.write_text(str(count))
            return count
    except Exception as e:
        logger.warning(f"Failed to update download counter: {e}")
        return get_download_count()


# =============================================================================
# Disk-Based Temporary APK Storage (Production-Ready)
# =============================================================================

# Configuration
TEMP_APK_DIR = Path(tempfile.gettempdir()) / 'gplay_apks'
TEMP_APK_TTL = 600  # 10 minutes
MAX_TEMP_STORAGE_MB = 2048  # 2GB max temp storage
TEMP_APK_DIR.mkdir(exist_ok=True)

# Per-worker registry for temp files (lightweight metadata only).
# Cross-worker access is handled by disk fallback in consume_temp_apk().
TEMP_APK_REGISTRY = {}  # {file_id: {'path': Path, 'filename': str, 'created': float, 'size': int}}
TEMP_APK_LOCK = threading.Lock()

# Concurrency limits (prevents resource exhaustion under high load)
MAX_CONCURRENT_DOWNLOADS = 10
MAX_CONCURRENT_MERGES = 3
DOWNLOAD_QUEUE_TIMEOUT = 30  # seconds to wait for a slot

download_semaphore = threading.Semaphore(MAX_CONCURRENT_DOWNLOADS)
merge_semaphore = threading.Semaphore(MAX_CONCURRENT_MERGES)

# SSE timeout protection (prevents infinite connection holding)
SSE_MAX_DURATION = 300  # 5 minutes max for any SSE stream
MAX_PROFILE_CYCLES = 3  # Max times to cycle through all profiles before giving up

# Per-worker search cache (reduces latency for repeated queries).
# Each gunicorn worker maintains its own cache; duplicate fetches across workers are acceptable.
SEARCH_CACHE = {}  # {query: (results, timestamp)}
SEARCH_CACHE_TTL = 21600  # 6 hours - search results rarely change
SEARCH_CACHE_LOCK = threading.Lock()


def normalize_search_query(query):
    """Normalize query for better cache hit rate."""
    # Lowercase, strip whitespace, collapse multiple spaces
    normalized = ' '.join(query.lower().split())
    return normalized


def get_cached_search(query):
    """Get cached search results if still valid."""
    with SEARCH_CACHE_LOCK:
        if query in SEARCH_CACHE:
            results, ts = SEARCH_CACHE[query]
            if time_module.time() - ts < SEARCH_CACHE_TTL:
                return results
            del SEARCH_CACHE[query]
    return None


def cache_search(query, results):
    """Cache search results with TTL."""
    now = time_module.time()
    with SEARCH_CACHE_LOCK:
        # Purge expired entries first
        expired = [k for k, (_, ts) in SEARCH_CACHE.items() if now - ts >= SEARCH_CACHE_TTL]
        for k in expired:
            del SEARCH_CACHE[k]
        # If still over limit, remove oldest entries
        if len(SEARCH_CACHE) > 1000:
            oldest = sorted(SEARCH_CACHE.items(), key=lambda x: x[1][1])[:100]
            for k, _ in oldest:
                del SEARCH_CACHE[k]
        SEARCH_CACHE[query] = (results, now)


def get_backoff_delay(attempt, base=1.0, max_delay=30.0):
    """Exponential backoff with jitter to prevent thundering herd."""
    delay = min(base * (2 ** min(attempt, 5)), max_delay)  # Cap exponent at 5
    jitter = delay * 0.2 * random.random()
    return delay + jitter


def download_splits_parallel(splits, headers, max_workers=4, key_prefix=None):
    """Download multiple splits in parallel for faster downloads.

    Uses gevent Pool when available (compatible with gunicorn gevent workers),
    falls back to sequential downloads otherwise.

    key_prefix 给的是落盘断点的前缀：每个 split 存成 `<key_prefix>-sN`。
    主包已经下完、卡在 split 上重试时，这一步就是从盘上直接读回来。
    """
    if not splits:
        return []

    results = {}
    errors = []

    def download_one(item):
        idx, split = item
        label = split.get('name') or f'split{idx}'
        part = None
        if key_prefix:
            part = partials.PartialDownload(f'{key_prefix}-s{idx}', label=label)
            done = part.completed_bytes()
            if done is not None:
                logger.info('%s 已在盘上，跳过下载（%s）', label, format_size(len(done)))
                return split['name'], done, None
        try:
            if part is not None:
                content = partials.download_to_part(
                    split['downloadUrl'], headers, part, expected=split.get('size', 0))
            else:
                resp = requests.get(split['downloadUrl'], headers=headers, timeout=(10, 120))
                resp.raise_for_status()
                content = resp.content
                if 'content-length' in resp.headers:
                    expected = int(resp.headers['content-length'])
                    if len(content) != expected:
                        raise ValueError(f"Size mismatch for {label}: got {len(content)}, expected {expected}")
            if part is not None:
                # 校一次总长：断点续传拼接出来的长度对不上就是错位的信号
                want = split.get('size', 0)
                if want and len(content) < want * 0.98:
                    raise ValueError(f'incomplete: {format_size(len(content))} / {format_size(want)}')
            return split['name'], content, None
        except Exception as e:
            return split['name'], None, str(e)

    items = list(enumerate(splits))
    if HAS_GEVENT:
        # Use gevent pool (greenlet-based, compatible with gevent workers)
        pool = GeventPool(size=min(max_workers, len(splits)))
        results_list = pool.map(download_one, items)
        for name, content, error in results_list:
            if error:
                errors.append(f"{name}: {error}")
            else:
                results[name] = content
    else:
        # Fallback to sequential downloads
        for item in items:
            name, content, error = download_one(item)
            if error:
                errors.append(f"{name}: {error}")
            else:
                results[name] = content

    if errors:
        raise ValueError(f"Failed to download splits: {'; '.join(errors)}")

    return [(s['name'], results[s['name']]) for s in splits]


def _short_error(e, limit=120):
    """把异常压成一句人能读的话。

    Play 的报错里嵌着 500 多字符的 token URL，原样透给前端会把队列那一行撑爆，
    而且 token 对用户没有任何意义。传输类错误统一归成一句话，别让人去猜
    「UNEXPECTED_EOF_WHILE_READING」是不是自己操作错了。
    """
    raw = str(e)
    if 'SSL' in raw or 'Max retries exceeded' in raw or 'Connection' in raw or 'timed out' in raw:
        return '与 Play 的连接被中断（网络或代理不稳定）'
    raw = re.sub(r'https?://\S+', '<url>', raw).replace('\n', ' ').strip()
    return raw[:limit] or type(e).__name__


def validate_download(response, name="file"):
    """Validate downloaded content matches Content-Length header."""
    content = response.content
    if 'content-length' in response.headers:
        expected = int(response.headers['content-length'])
        actual = len(content)
        if actual != expected:
            raise ValueError(f"Download size mismatch for {name}: got {actual}, expected {expected}")
    return content


# 单连接被限速的线路上，多连接能叠加带宽（本机实测 40 KB/s × 4 ≈ 160 KB/s）。
# 小文件切块反而亏在握手和 Range 开销上，所以设个下限。可用环境变量关掉。
DOWNLOAD_PARTS = max(1, min(8, int(os.environ.get('GPLAY_DOWNLOAD_PARTS', '4') or 4)))
PARALLEL_MIN_BYTES = 6 * 1024 * 1024
# 重试策略：不是「试 N 次就放弃」，而是「只要还在前进就一直续」。
# 实测这条线路到 play.googleapis.com 单连接 ~40KB/s，而且每 30~40 秒被掐一次
# （ChunkedEncodingError: IncompleteRead）——208MB 的包要断四十多次，
# 固定 4 次重试等于必然失败。真正的失败信号是「连续几次一个字节都没进来」。
STREAM_MAX_RETRIES = max(1, min(200, int(os.environ.get('GPLAY_STREAM_RETRIES', '40') or 40)))
SEG_MAX_RETRIES = max(1, min(200, int(os.environ.get('GPLAY_SEG_RETRIES', '60') or 60)))
STALL_LIMIT = 4  # 连续 4 次重连都没推进，才认为这条路真的不通了
PAR_ROUNDS = 3   # 分段模式整轮失败后重开几轮（每轮都从断点继续，不是从零）


def probe_range_size(url, headers, attempts=3):
    """问一次 CDN 支不支持 Range：支持就返回总字节数，不支持就返回 0。

    探测失败必须重试：这里的一次 TLS 抖动如果直接当成「不支持分段」，
    后面就退回单流——208MB 的包单流要多花三倍时间。实测 play.googleapis.com
    会在代理切节点时吐 `SSL: UNEXPECTED_EOF_WHILE_READING`，几秒后自己就好了。
    只有「明确回了非 206」才是不支持分段，那种情况不重试。
    """
    last = None
    for i in range(attempts):
        try:
            h = dict(headers or {})
            h['Range'] = 'bytes=0-0'
            # 必须禁掉压缩：带 Accept-Encoding: gzip 时 Range 是按压缩后的字节切的，
            # requests 又会拿半截 gzip 去解压（直接报 incorrect header check）
            h['Accept-Encoding'] = 'identity'
            with requests.get(url, headers=h, timeout=(10, 30), stream=True) as r:
                if r.status_code != 206:
                    return 0
                m = re.search(r'/(\d+)\s*$', r.headers.get('Content-Range') or '')
                if m:
                    return int(m.group(1))
                return int(r.headers.get('Content-Length') or 0)
        except Exception as e:
            last = e
            if i < attempts - 1:
                time_module.sleep(0.6 * (i + 1))
    logger.warning('Range 探测连续失败（%d 次）：%s；本次退回单流', attempts, last)
    return 0


def fetch_parallel(url, headers, total, step, current, total_files, label, interval, state=None,
                   part=None):
    """分段并发拉一个文件，边拉边 yield SSE 进度，最后 return 完整 bytes。

    每个线程只往自己那段 slice 里写（预分配的 bytearray），区域互不重叠，
    所以不用最后再拼一次——大包也只有一份内存，和单流时一样。
    注意 slice 赋值在 bytearray 上长度不等会触发扩容，那样会打乱别的线程，
    所以下面先按边界截断，保证每次赋值长度严格相等。

    state 是给调用方复用的：整轮失败后重来时，buf 和每段的 pos 都还在里面，
    直接从断点继续，不用把已经下好的几十 MB 扔掉重下。实测这条链路上一段
    跑几分钟就会被掐，没有这个「接着上次继续」，208MB 的包永远下不完。

    part 是跨请求的那一层：每块除了写内存，还 pwrite 到盘上的 `.part`。下一次
    SSE（用户点了重试）从这里把区间读回来，就不用再下那 137MB 了。
    """
    if state is None:
        state = {}
    reuse = (
        state.get('total') == total
        and isinstance(state.get('buf'), bytearray)
        and len(state['buf']) == total
        and state.get('segs')
    )
    if reuse:
        buf = state['buf']
        segs = state['segs']
        state.update({
            'error': '',
            'stop': False,
            'bytes': sum(max(0, s['pos'] - s['start']) for s in segs),
        })
    else:
        chunk = (total + DOWNLOAD_PARTS - 1) // DOWNLOAD_PARTS
        layout = []
        for i in range(DOWNLOAD_PARTS):
            start = i * chunk
            if start >= total:
                break
            layout.append({'start': start, 'end': min(total, start + chunk) - 1})

        resumed = bool(part and part.resume_parts(layout, total))
        if part and not resumed:
            part.start_parts(layout, total)

        buf = bytearray(total)
        if resumed:
            segs = part.segs
            # 把盘上已经收到的区间读回内存（[start,pos) 之外还是空的，末段不够会被 r.read 截短）
            with open(part.path, 'rb') as f:
                for s in segs:
                    if s['pos'] > s['start']:
                        f.seek(s['start'])
                        buf[s['start']:s['pos']] = f.read(s['pos'] - s['start'])
        else:
            segs = [{'start': s['start'], 'end': s['end'], 'pos': s['start']} for s in layout]
        state.clear()
        state.update({'buf': buf, 'segs': segs, 'total': total,
                      'bytes': sum(max(0, s['pos'] - s['start']) for s in segs),
                      'error': '', 'stop': False})
        if part:
            # part.segs 和 state['segs'] 是同一个 list，progress 里 flush 就能读到最新 pos
            part.segs = segs
            if resumed:
                got = state['bytes']
                logger.info('%s 从断点续传：已收 %s / %s，跳过重下', label,
                            format_size(got), format_size(total))
                yield f"data: {json.dumps({'type': 'progress', 'step': step, 'current': current, 'total': total_files, 'bytes': got, 'bytesTotal': total, 'message': f'继续上次的下载（已收 {format_size(got)} / {format_size(total)}）...'})}\n\n"

    lock = threading.Lock()

    def worker(seg):
        """拉一段。断了就在已到达的位置接着拉（Range 从 seg.pos 开始）。

        判「放弃」的条件不是重连次数，而是**连续 STALL_LIMIT 次没有前进**：
        这条线路上每段要断几十次，但只要每次都能接上往前挪，就应该继续。
        """
        start, end = seg['start'], seg['end']
        attempt = 0
        stall = 0
        while seg['pos'] <= end:
            pos_before = seg['pos']
            h = dict(headers or {})
            h['Range'] = f'bytes={seg["pos"]}-{end}'
            # 同 probe：分块必须按未压缩的字节切，否则 range 和内容对不上
            h['Accept-Encoding'] = 'identity'
            try:
                with requests.get(url, headers=h, timeout=(10, 90), stream=True) as r:
                    # 并发模式下只认 206：服务器如果忽略 Range 回了整包，
                    # 写进去就会把别人那段覆盖成同样开头的内容
                    if r.status_code != 206:
                        raise ValueError(f'HTTP {r.status_code}')
                    for piece in r.iter_content(256 * 1024):
                        if not piece:
                            continue
                        with lock:
                            if state['stop']:
                                return
                            pos = seg['pos']
                            if pos + len(piece) > end + 1:
                                piece = piece[: end + 1 - pos]
                            buf[pos:pos + len(piece)] = piece
                            # 先落盘再推进 pos：这样 json 里的进度永远不超前于盘上的数据
                            if part is not None:
                                part.pwrite(pos, piece)
                            seg['pos'] += len(piece)
                            state['bytes'] += len(piece)
                        if seg['pos'] > end:
                            return
                if seg['pos'] > end:
                    return
                raise ValueError('connection closed early')
            except Exception as e:
                with lock:
                    if state['stop']:
                        return
                stall = 0 if seg['pos'] > pos_before else stall + 1
                attempt += 1
                if stall >= STALL_LIMIT or attempt >= SEG_MAX_RETRIES:
                    with lock:
                        state['error'] = f'{start}-{end}: {e}'
                    return
                # 有进展就别等——这条链路本来就断断续续，等只会白耗时间
                if stall:
                    time_module.sleep(min(5.0, 0.8 * stall))

    threads = []
    for seg in segs:
        if seg['pos'] > seg['end']:
            continue
        t = threading.Thread(target=worker, args=(seg,), daemon=True)
        t.start()
        threads.append(t)

    try:
        last = 0.0
        while any(t.is_alive() for t in threads):
            time_module.sleep(0.25)
            now = time_module.time()
            if now - last < interval:
                continue
            last = now
            with lock:
                got, err = state['bytes'], state['error']
            if err:
                raise ValueError(err)
            if part is not None:
                # 节流在 PartialDownload 里；这里只管推一下，让断点跟着进度走
                part.flush_meta()
            msg = f'Downloading {label} ({format_size(got)} / {format_size(total)})...'
            yield f"data: {json.dumps({'type': 'progress', 'step': step, 'current': current, 'total': total_files, 'bytes': got, 'bytesTotal': total, 'message': msg})}\n\n"
        with lock:
            got, err = state['bytes'], state['error']
        if err:
            raise ValueError(err)
        if got != total:
            raise ValueError(f'incomplete: got {got}, expected {total}')
        if part is not None:
            # 下完也要落盘：后面合并/签名/存盘任何一步失败，重试都能直接读盘，
            # 不用把这 208MB 再下一遍
            part.flush_meta(force=True)
        return bytes(buf)
    finally:
        # 客户端断开时生成器会被 close()，这时候让线程尽早收手，别继续吃带宽
        with lock:
            state['stop'] = True
        if part is not None:
            # 断开也要把进度写下去：客户端掐断时通常还没到下一个 progress tick，
            # 不在这里补一次，盘上数据是有的、但「下到哪了」不知道，等于白存
            part.flush_meta(force=True)


def sse_stream_download(url, headers, expected=0, step='download', current=1,
                        total_files=1, label='base APK', interval=0.6, part=None):
    """流式下一个文件，边下边 yield SSE 进度，最后 return 完整 bytes。

    requests.get 默认一口气把响应体读完，中途一个回调点都没有，
    前端就只能盯着一个百分比干等（65MB 的包要等两分钟）。
    这里改成 iter_content 自己攒，按 interval 秒报一次字节数。

    慢线路（本机实测单连接被压到 ~40 KB/s）上再加一层：先探一次 Range，
    CDN 支持就切成 DOWNLOAD_PARTS 段并发拉——实测 4 条并发能跑到 ~160 KB/s，
    55MB 的包从半小时降到七八分钟。不支持 Range 或探不通就老老实实单流。

    part 给的是跨请求的断点（见 partials.py）：Play 的下载地址每次都现签，
    HTTP 层的 Range 续不了下一次请求，只能把字节落到盘上再按偏移跳过。
    """
    cl = 0
    total = expected
    if DOWNLOAD_PARTS > 1 and (expected or 0) >= PARALLEL_MIN_BYTES:
        probed = probe_range_size(url, headers)
        if probed:
            # 复用同一份 state：整轮失败重来时接着断点走，不把几十 MB 扔掉重下
            par_state = {}
            for round_no in range(PAR_ROUNDS):
                try:
                    return (yield from fetch_parallel(
                        url, headers, probed, step, current, total_files, label, interval,
                        state=par_state, part=part))
                except Exception as e:
                    got = par_state.get('bytes') or 0
                    if round_no < PAR_ROUNDS - 1:
                        logger.warning('分段下载整轮中断（第 %d 轮）：%s；已下 %s，从断点重开一轮',
                                       round_no + 1, e, format_size(got))
                        time_module.sleep(1.0 * (round_no + 1))
                        continue
                    # 一个字节都没下到就退回单流；已经下了很多就别丢——
                    # 重下 208MB 比直接报错更糟，让用户点重试也比从零开始强
                    if got < PARALLEL_MIN_BYTES:
                        logger.warning('Parallel download failed for %s: %s; falling back to single stream',
                                       label, e)
                        if part is not None:
                            # 分段模式和单流模式的文件布局不一样（前者预分配成整包长度），
                            # 混用会拼出坏包，所以退回单流前先把断点丢掉
                            part.discard()
                        total = expected
                    else:
                        raise
                    break

    # 单流也要扛得住中途断线。208MB 的包在 40KB/s 的线路上要跑一小时，期间会被掐几十次。
    # 原来一次异常就直接判死，用户点「重试」只能从 0 再来；现在用 Range 从已收到的续，
    # 只要还在前进就继续，连续 STALL_LIMIT 次一字节未进才认输。
    buf = bytearray()
    if part is not None:
        resumed = part.resume_stream(expected)
        if resumed:
            buf = bytearray(part.read_bytes(resumed))
            total = part.total or expected
            logger.info('%s 从断点续传：已收 %s / %s', label, format_size(resumed),
                        format_size(total))
            yield f"data: {json.dumps({'type': 'progress', 'step': step, 'current': current, 'total': total_files, 'bytes': resumed, 'bytesTotal': total, 'message': f'继续上次的下载（已收 {format_size(resumed)} / {format_size(total)}）...'})}\n\n"
    last = 0.0
    attempt = 0
    stall = 0
    while True:
        start = len(buf)
        h = dict(headers or {})
        if start:
            h['Range'] = f'bytes={start}-'
        try:
            with requests.get(url, headers=h, timeout=(10, 120), stream=True) as resp:
                if not resp.ok:
                    raise ValueError(f'HTTP {resp.status_code}')
                # 上游不认 Range 会回 200 + 全量，这时候只能丢掉已收的从头写，否则文件会拼坏
                if start and resp.status_code != 206:
                    buf = bytearray()
                    start = 0
                # 校验只认 content-length（Play 报的 downloadSize 是估算，可能和实际不符）；
                # 它缺失时才退回 expected，而且那个值只用来显示进度，不拿来卡校验
                cl = int(resp.headers.get('content-length') or 0)
                total = (cl + start) if cl else (expected or 0)
                if part is not None:
                    part.begin_stream(total)
                for piece in resp.iter_content(256 * 1024):
                    if not piece:
                        continue
                    if part is not None:
                        part.pwrite(len(buf), piece)
                    buf += piece
                    if part is not None:
                        part.set_stream_pos(len(buf), total)
                    now = time_module.time()
                    if now - last >= interval:
                        last = now
                        msg = f'Downloading {label} ({format_size(len(buf))} / {format_size(total)})...' if total \
                            else f'Downloading {label} ({format_size(len(buf))})...'
                        yield f"data: {json.dumps({'type': 'progress', 'step': step, 'current': current, 'total': total_files, 'bytes': len(buf), 'bytesTotal': total, 'message': msg})}\n\n"
                if cl and len(buf) - start < cl:
                    raise ValueError(f'只收到 {format_size(len(buf) - start)} / {format_size(cl)}')
                return bytes(buf)
        except Exception as e:
            stall = 0 if len(buf) > start else stall + 1
            attempt += 1
            if stall >= STALL_LIMIT or attempt >= STREAM_MAX_RETRIES:
                raise
            if stall:
                wait = min(5.0, 0.8 * stall)
                logger.warning('%s 第 %d 次中断：%s；%.1fs 后从 %s 处续传',
                               label, attempt, e, wait, format_size(len(buf)))
                time_module.sleep(wait)
            else:
                logger.warning('%s 第 %d 次中断：%s；已收 %s，立刻续传',
                               label, attempt, e, format_size(len(buf)))


def cleanup_temp_apks():
    """Background cleanup of expired temp APKs."""
    while True:
        try:
            now = time_module.time()
            expired = []

            with TEMP_APK_LOCK:
                for file_id, meta in list(TEMP_APK_REGISTRY.items()):
                    if now - meta['created'] > TEMP_APK_TTL:
                        expired.append(file_id)

                # Remove expired entries
                for file_id in expired:
                    meta = TEMP_APK_REGISTRY.pop(file_id, None)
                    if meta and meta['path'].exists():
                        try:
                            meta['path'].unlink()
                            logger.info(f"Cleaned up expired temp APK: {file_id}")
                        except Exception as e:
                            logger.warning(f"Failed to clean temp file: {e}")

            # Also clean orphaned files not in registry
            try:
                if TEMP_APK_DIR.exists():
                    for f in TEMP_APK_DIR.iterdir():
                        try:
                            if f.is_file() and f.stat().st_mtime < now - TEMP_APK_TTL:
                                f.unlink()
                                logger.debug(f"Cleaned orphaned temp file: {f.name}")
                        except Exception:
                            pass
            except Exception as e:
                logger.warning(f"Orphaned file cleanup error: {e}")

            # Clean stale apk_merge_* dirs orphaned by OOM-killed workers (older than 1h)
            try:
                import shutil
                tmp_dir = Path(tempfile.gettempdir())
                for d in tmp_dir.glob('apk_merge_*'):
                    try:
                        if d.is_dir() and d.stat().st_mtime < now - 3600:
                            shutil.rmtree(d, ignore_errors=True)
                            logger.info(f"Cleaned stale apk_merge dir: {d.name}")
                    except Exception:
                        pass
            except Exception as e:
                logger.warning(f"apk_merge cleanup error: {e}")

            # 落盘断点放在 ~/.cache，不归 /tmp 那套清，得自己按 TTL / 总量收
            try:
                partials.cleanup()
            except Exception as e:
                logger.warning(f"partials cleanup error: {e}")

        except Exception as e:
            logger.error(f"Cleanup error: {e}")

        time_module.sleep(60)  # Run every minute


def save_temp_apk(apk_bytes, filename):
    """Save APK to disk and return file_id."""
    file_id = str(uuid.uuid4())
    file_path = TEMP_APK_DIR / f"{file_id}.apk"
    meta_path = TEMP_APK_DIR / f"{file_id}.meta"

    # Check storage limit
    with TEMP_APK_LOCK:
        total_size = sum(m.get('size', 0) for m in TEMP_APK_REGISTRY.values())
        if total_size + len(apk_bytes) > MAX_TEMP_STORAGE_MB * 1024 * 1024:
            raise MemoryError("Temp storage limit exceeded, try again later")

    # Write APK to disk
    with open(file_path, 'wb') as f:
        f.write(apk_bytes)

    # Write metadata file (for cross-worker access)
    with open(meta_path, 'w') as f:
        f.write(filename)

    with TEMP_APK_LOCK:
        TEMP_APK_REGISTRY[file_id] = {
            'path': file_path,
            'filename': filename,
            'created': time_module.time(),
            'size': len(apk_bytes)
        }

    logger.info(f"Saved temp APK: {file_id} ({len(apk_bytes)} bytes)")
    return file_id


def get_temp_apk(file_id):
    """Get temp APK metadata, or None if not found/expired."""
    with TEMP_APK_LOCK:
        meta = TEMP_APK_REGISTRY.get(file_id)
        if not meta:
            return None
        if time_module.time() - meta['created'] > TEMP_APK_TTL:
            # Expired
            TEMP_APK_REGISTRY.pop(file_id, None)
            if meta['path'].exists():
                try:
                    meta['path'].unlink()
                except Exception:
                    pass
            return None
        return meta.copy()


def _is_valid_file_id(file_id):
    """Validate file_id is a strict UUID to prevent path traversal."""
    try:
        uuid.UUID(file_id)
        return True
    except (ValueError, AttributeError):
        return False


def consume_temp_apk(file_id):
    """Get temp APK metadata for serving. Does NOT delete — cleanup thread handles that.

    With multiple gunicorn workers, the registry may not have the entry
    if a different worker saved the file. Fall back to disk check.
    Files persist until the cleanup thread removes them after TEMP_APK_TTL,
    allowing Cloudflare retries and Android download manager to complete.
    """
    if not _is_valid_file_id(file_id):
        return None

    with TEMP_APK_LOCK:
        meta = TEMP_APK_REGISTRY.get(file_id)
        if meta:
            if time_module.time() - meta['created'] > TEMP_APK_TTL:
                TEMP_APK_REGISTRY.pop(file_id, None)
                return None
            return meta.copy()

    # If not in registry (different worker saved it), check disk directly
    file_path = TEMP_APK_DIR / f"{file_id}.apk"
    meta_path = TEMP_APK_DIR / f"{file_id}.meta"
    # Defense-in-depth: verify path didn't escape temp dir
    if file_path.resolve().parent != TEMP_APK_DIR.resolve():
        logger.warning(f"Path traversal attempt blocked: {file_id}")
        return None
    if file_path.exists():
        # Check TTL on disk file
        try:
            mtime = file_path.stat().st_mtime
            if time_module.time() - mtime > TEMP_APK_TTL:
                return None
        except OSError:
            return None
        # Try to read original filename from metadata file
        filename = f"{file_id}.apk"
        if meta_path.exists():
            try:
                filename = meta_path.read_text().strip()
            except Exception:
                pass
        try:
            size = file_path.stat().st_size
        except OSError:
            return None
        meta = {
            'path': file_path,
            'filename': filename,
            'created': mtime,
            'size': size
        }
        return meta

    return None


# Start cleanup thread (daemon so it dies when main process exits)
_cleanup_thread = threading.Thread(target=cleanup_temp_apks, daemon=True)
_cleanup_thread.start()
logger.info(f"Temp APK storage initialized: {TEMP_APK_DIR}")

# Warm connection pool on worker startup (pre-establish TLS to Google Play)
def _warm_connection_pool():
    """Pre-establish connections to reduce first-request latency."""
    try:
        scraper = get_scraper()
        # HEAD request is faster than GET, just establishes connection
        scraper.head('https://play.google.com', timeout=(5, 5))
        logger.info("Connection pool warmed for play.google.com")
    except Exception as e:
        logger.debug(f"Connection warming failed (non-critical): {e}")

_warm_connection_pool()

# APKEditor.jar integrity check (warning-only)
APKEDITOR_EXPECTED_SHA256 = os.environ.get('APKEDITOR_SHA256', '')

def _verify_apkeditor():
    jar_path = os.path.join(os.path.dirname(__file__), 'APKEditor.jar')
    if not os.path.exists(jar_path):
        logger.warning("APKEditor.jar not found")
        return
    if not APKEDITOR_EXPECTED_SHA256:
        logger.info("APKEDITOR_SHA256 not set, skipping integrity check")
        return
    import hashlib
    h = hashlib.sha256()
    with open(jar_path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    actual = h.hexdigest()
    if actual != APKEDITOR_EXPECTED_SHA256:
        logger.warning(f"APKEditor.jar SHA256 mismatch! Expected {APKEDITOR_EXPECTED_SHA256}, got {actual}")
    else:
        logger.info("APKEditor.jar integrity verified")

_verify_apkeditor()


@app.route('/api/download-merged-stream/<path:pkg>')
def download_merged_stream(pkg):
    """SSE endpoint that downloads, merges, signs APKs with progress updates."""
    err = _require_valid_pkg(pkg)
    if err:
        return err

    # Trigger catalog enrichment early, before download attempt
    if not _DISABLE_APP_PAGES:
        try:
            from app_pages import on_download_success
            on_download_success(pkg, pkg)
        except Exception:
            pass

    arch = request.args.get('arch', 'arm64-v8a')
    if arch not in SUPPORTED_ARCHS:
        arch = 'arm64-v8a'

    # Get priority-ordered profiles for this architecture
    profiles = get_priority_device_configs(arch)
    profile_count = len(profiles)

    def generate():
        # Try to acquire a download slot (prevents resource exhaustion)
        if not download_semaphore.acquire(timeout=DOWNLOAD_QUEUE_TIMEOUT):
            yield f"data: {json.dumps({'type': 'error', 'message': 'Server busy, please try again later'})}\n\n"
            return

        try:
            # Try to get a working token
            yield f"data: {json.dumps({'type': 'progress', 'step': 'auth', 'message': 'Getting auth token...'})}\n\n"

            auth_data = None
            info = None
            # 应用层错误：token 是好的，只是这个包在当前商店区拿不到。
            # 换 token、重登、轮换设备指纹都改变不了结果，只会白花 8 秒重建一次会话
            APP_LEVEL = ('not_found', 'no_delivery', 'paid_app', 'incompatible')
            app_error = None

            # Try cached token for this architecture
            cached = get_cached_auth(arch)
            if cached:
                try:
                    info = get_download_info(pkg, cached)
                    if 'error' not in info:
                        auth_data = cached
                    elif info.get('error') in APP_LEVEL:
                        app_error = info
                except Exception:
                    pass

            if not auth_data and not app_error:
                refreshed = refresh_personal_auth(arch)
                if refreshed:
                    yield f"data: {json.dumps({'type': 'progress', 'step': 'auth', 'message': 'Refreshed Google account session, retrying...'})}\n\n"
                    try:
                        info = get_download_info(pkg, refreshed)
                        if 'error' not in info:
                            auth_data = refreshed
                        elif info.get('error') in APP_LEVEL:
                            app_error = info
                    except Exception:
                        pass

            if not auth_data and not app_error:
                scraper = get_scraper()  # Reuse scraper across attempts
                max_attempts = profile_count * MAX_PROFILE_CYCLES
                if not DISPENSER_URL or dispenser_config_error():
                    max_attempts = 0  # no usable dispenser: skip token rotation entirely
                for attempt in range(max_attempts):
                    # Rotate through profiles
                    profile_key, profile = profiles[attempt % profile_count]
                    profile_name = profile.get('UserReadableName', profile_key)

                    yield f"data: {json.dumps({'type': 'progress', 'step': 'auth', 'message': f'Trying token #{attempt+1} ({profile_name})...'})}\n\n"
                    try:
                        response = scraper.post(
                            DISPENSER_URL,
                            headers={
                                'User-Agent': 'com.aurora.store-4.6.1-70',
                                'Content-Type': 'application/json',
                            },
                            json=profile,
                            timeout=(5, 30)
                        )

                        if not response.ok:
                            time_module.sleep(get_backoff_delay(attempt))
                            continue

                        auth_data = response.json()
                        info = get_download_info(pkg, auth_data)

                        if 'error' not in info:
                            save_cached_auth(auth_data, arch)
                            logger.info(f"Token #{attempt+1} ({profile_name}) worked for {pkg}")
                            break
                        elif info.get('error') in APP_LEVEL:
                            # 换了指纹还是「这个区没有」，再换也是白换
                            app_error = info
                            auth_data = None
                            break
                        else:
                            auth_data = None
                            time_module.sleep(0.5)

                    except requests.exceptions.ConnectionError as e:
                        time_module.sleep(get_backoff_delay(attempt, base=2.0))
                    except requests.exceptions.Timeout as e:
                        time_module.sleep(get_backoff_delay(attempt))
                    except Exception as e:
                        time_module.sleep(get_backoff_delay(attempt, base=0.5))

            if not info or 'error' in info:
                src = info if (info and 'error' in info) else (app_error or {})
                err = src.get('error') or 'failed_download_info'
                if err == 'paid_app':
                    msg = f"这个应用不是免费的（{src.get('formattedAmount', 'paid')}），只能下免费应用。"
                elif err == 'incompatible':
                    msg = src.get('message') or 'Play 没有适配当前设备/架构的版本。'
                elif err == 'no_delivery':
                    msg = ('Google Play 没给这个包下载链接：它在你 Google 账号所在的区拿不到'
                           '（已下架、区域限制，或与虚拟设备不兼容）。换一个所在区的账号，'
                           '或者回到卡片点 APKPure / 应用宝 的直链。')
                elif err == 'not_found':
                    msg = ('Google Play 上没有这个包——不在你账号所属的商店区上架。'
                           '换区账号，或者回到卡片点 APKPure / 应用宝 的直链。')
                elif not auth_data:
                    msg = f'Google Play 登录态失效（{err}），在顶部重新连接 Google 账号。'
                else:
                    msg = f'获取下载信息失败：{err}'
                yield f"data: {json.dumps({'type': 'error', 'code': err, 'message': msg})}\n\n"
                return

            splits = info.get('splits', [])
            total_files = 1 + len(splits)
            base_size = info.get('downloadSize', 0)
            total_size = base_size + sum(s.get('size', 0) for s in splits)

            # 落盘断点：key 带 pkg + versionCode + 架构，版本一变旧断点自然作废。
            # 同一个包被两个请求同时下时，claim 会给第二个另一个 key，免得互相覆盖。
            part_key, part_owned = partials.claim(
                partials.safe_key(pkg, info.get('versionCode'), arch))
            base_part = partials.PartialDownload(part_key, label='base APK')

            peek = base_part.peek() or {}
            have = 0
            if peek.get('mode') == 'parts':
                have = sum(max(0, int(s.get('pos', 0)) - int(s['start']))
                           for s in (peek.get('segs') or []))
            elif peek.get('mode') == 'stream':
                have = min(int(peek.get('pos') or 0), int(peek.get('size') or 0))

            if have > 0:
                yield f"data: {json.dumps({'type': 'progress', 'step': 'download', 'message': f'继续上次的下载（已收 {format_size(have)} / {format_size(base_size)}）...', 'current': 1, 'total': total_files, 'bytes': have, 'bytesTotal': base_size})}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'progress', 'step': 'download', 'message': f'Downloading base APK ({format_size(base_size)})...', 'current': 1, 'total': total_files})}\n\n"

            cookie_header = '; '.join([f"{c['name']}={c['value']}" for c in info.get('cookies', [])])
            headers = {'Cookie': cookie_header} if cookie_header else {}

            try:
                # 主包几十兆，用流式下载把字节数实时报给前端
                base_apk = yield from sse_stream_download(
                    info['downloadUrl'], headers, expected=base_size,
                    step='download', current=1, total_files=total_files, label='base APK',
                    part=base_part,
                )

                # If no splits, return original APK without merging/signing
                if not splits:
                    try:
                        file_id = save_temp_apk(base_apk, info['filename'])
                        partials.discard_group(part_key)  # 成品已经落盘，断点没用了
                        count = increment_download_count()
                        yield f"data: {json.dumps({'type': 'success', 'download_id': file_id, 'filename': info['filename'], 'original': True, 'downloads': count})}\n\n"
                    except MemoryError as e:
                        logger.warning(f"Temp storage error for {pkg}: {e}")
                        yield f"data: {json.dumps({'type': 'error', 'message': 'Server storage full, try again later'})}\n\n"
                    return

                # Download splits in parallel for faster downloads
                splits_size = sum(s.get('size', 0) for s in splits)
                yield f"data: {json.dumps({'type': 'progress', 'step': 'download', 'message': f'Downloading {len(splits)} splits ({format_size(splits_size)})...', 'current': 2, 'total': total_files})}\n\n"
                try:
                    splits_data = download_splits_parallel(splits, headers, key_prefix=part_key)
                except Exception as e:
                    logger.error(f"Failed to download splits for {pkg}: {e}")
                    # 主包还在盘上：重试时跳过这 208MB，只补 splits
                    yield f"data: {json.dumps({'type': 'error', 'message': 'Failed to download split APKs（主包已保存，重试会跳过）'})}\n\n"
                    return

                # Acquire merge slot (limited to prevent CPU exhaustion)
                if not merge_semaphore.acquire(timeout=DOWNLOAD_QUEUE_TIMEOUT):
                    yield f"data: {json.dumps({'type': 'error', 'message': 'Merge queue full, try again later'})}\n\n"
                    return

                try:
                    yield f"data: {json.dumps({'type': 'progress', 'step': 'merge', 'message': 'Merging APKs...'})}\n\n"
                    merged_apk = merge_apks(base_apk, splits_data)

                    # Report fused modules patching to UI
                    from axml_patcher import get_asset_pack_split_names
                    asset_packs = get_asset_pack_split_names([name for name, _ in splits_data])
                    del base_apk, splits_data
                    if asset_packs:
                        fused_value = ','.join(asset_packs)
                        yield f"data: {json.dumps({'type': 'progress', 'step': 'merge', 'message': f'Patched fused modules: {fused_value}'})}\n\n"

                    yield f"data: {json.dumps({'type': 'progress', 'step': 'sign', 'message': 'Signing APK...'})}\n\n"
                    signed_apk = sign_apk(merged_apk)
                    del merged_apk

                    # Save to disk-based temp storage
                    merged_filename = f"{pkg}-{info['versionCode']}-merged.apk"
                    try:
                        file_id = save_temp_apk(signed_apk, merged_filename)
                        del signed_apk
                        partials.discard_group(part_key)  # 成品已经落盘，断点没用了
                        count = increment_download_count()
                        yield f"data: {json.dumps({'type': 'success', 'download_id': file_id, 'filename': merged_filename, 'downloads': count})}\n\n"
                    except MemoryError as e:
                        logger.warning(f"Temp storage error for {pkg}: {e}")
                        yield f"data: {json.dumps({'type': 'error', 'message': 'Server storage full, try again later'})}\n\n"
                finally:
                    merge_semaphore.release()

            except Exception as e:
                logger.error(f"Download/merge failed for {pkg}: {e}")
                # 原来这里只有一句 Download failed, please try again：用户看不出是网络断了、
                # 包本身有问题、还是存储满了，也不知道重试有没有意义
                yield f"data: {json.dumps({'type': 'error', 'code': 'transfer', 'message': 'Play 下载中断：' + _short_error(e)})}\n\n"

            finally:
                # 断点文件留着（下次重试要用），只放开并发占位
                partials.release(part_key, part_owned)

        finally:
            download_semaphore.release()

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        }
    )


@app.route('/api/download-temp/<file_id>')
def download_temp(file_id):
    """Download a temporary merged APK (streams from disk)."""
    if not _is_valid_file_id(file_id):
        return jsonify({'error': 'Invalid file ID'}), 400

    meta = consume_temp_apk(file_id)
    if not meta:
        return jsonify({'error': 'File not found or expired'}), 404

    def generate():
        """Stream file from disk. Cleanup is handled by the cleanup thread."""
        try:
            f = open(meta['path'], 'rb')
        except FileNotFoundError:
            return
        with f:
            while True:
                chunk = f.read(65536)  # 64KB chunks
                if not chunk:
                    break
                yield chunk

    return Response(
        generate(),
        content_type='application/vnd.android.package-archive',
        headers={
            'Content-Disposition': f'attachment; filename="{sanitize_filename(meta["filename"])}"',
            'Content-Length': str(meta['size'])
        }
    )


@app.route('/api/download-merged/<path:pkg>')
def download_merged(pkg):
    """Download and merge all APKs into a single installable APK (non-streaming fallback)."""
    err = _require_valid_pkg(pkg)
    if err:
        return err

    # Get architecture from query parameter
    arch = request.args.get('arch', 'arm64-v8a')
    if arch not in SUPPORTED_ARCHS:
        arch = 'arm64-v8a'
    # Try to get a working token and download info
    auth_data = None
    info = None

    # Try cached token for this architecture
    cached = get_cached_auth(arch)
    if cached:
        try:
            info = get_download_info(pkg, cached)
            if 'error' not in info:
                auth_data = cached
        except Exception:
            pass

    # If cached didn't work, try new tokens with profile rotation
    if not auth_data:
        _cfg_err = dispenser_config_error()
        if not DISPENSER_URL or _cfg_err:
            msg = _cfg_err or ('No working auth. Sign in with a Google account '
                               '(web UI top card) or configure DISPENSER_URL.')
            logger.error(msg)
            return jsonify({'error': msg}), 503
        profiles = get_priority_device_configs(arch)
        profile_count = len(profiles)
        max_attempts = profile_count * MAX_PROFILE_CYCLES
        scraper = get_scraper()  # Reuse scraper across attempts
        for attempt in range(max_attempts):
            profile_key, profile = profiles[attempt % profile_count]
            try:
                response = scraper.post(
                    DISPENSER_URL,
                    headers={
                        'User-Agent': 'com.aurora.store-4.6.1-70',
                        'Content-Type': 'application/json',
                    },
                    json=profile,
                    timeout=(5, 30)
                )

                if not response.ok:
                    time_module.sleep(get_backoff_delay(attempt))
                    continue

                auth_data = response.json()
                info = get_download_info(pkg, auth_data)

                if 'error' not in info:
                    save_cached_auth(auth_data, arch)
                    break
                else:
                    auth_data = None
                    time_module.sleep(get_backoff_delay(attempt, base=0.5))

            except requests.exceptions.ConnectionError as e:
                logger.warning(f"Connection error on attempt {attempt}: {e}")
                time_module.sleep(get_backoff_delay(attempt, base=2.0))
            except requests.exceptions.Timeout as e:
                logger.warning(f"Timeout on attempt {attempt}: {e}")
                time_module.sleep(get_backoff_delay(attempt))
            except Exception as e:
                logger.warning(f"Merge download attempt {attempt} failed: {e}")
                time_module.sleep(get_backoff_delay(attempt, base=0.5))

    if not info or 'error' in info:
        return jsonify({'error': 'Failed to get download info after multiple attempts'}), 500

    # Build cookie header for downloads
    cookie_header = '; '.join([f"{c['name']}={c['value']}" for c in info.get('cookies', [])])
    headers = {'Cookie': cookie_header} if cookie_header else {}

    try:
        # Download base APK with validation
        logger.info(f"Downloading base APK for {pkg}")
        base_resp = requests.get(info['downloadUrl'], headers=headers, timeout=(10, 120))
        if not base_resp.ok:
            return jsonify({'error': f'Failed to download base APK: {base_resp.status_code}'}), 500
        base_apk = validate_download(base_resp, "base APK")

        # If no splits, just return base APK
        if not info['splits']:
            return Response(
                base_apk,
                content_type='application/vnd.android.package-archive',
                headers={'Content-Disposition': f'attachment; filename="{sanitize_filename(info["filename"])}"'}
            )

        # Download all splits in parallel
        logger.info(f"Downloading {len(info['splits'])} splits in parallel")
        splits_data = download_splits_parallel(info['splits'], headers)

        # Acquire merge semaphore to limit concurrent merges
        if not merge_semaphore.acquire(timeout=DOWNLOAD_QUEUE_TIMEOUT):
            return jsonify({'error': 'Server busy, please try again'}), 503

        try:
            # Merge APKs
            logger.info(f"Merging {len(splits_data) + 1} APKs")
            merged_apk = merge_apks(base_apk, splits_data)
            del base_apk, splits_data

            # Sign the merged APK
            logger.info("Signing merged APK")
            signed_apk = sign_apk(merged_apk)
            del merged_apk
        finally:
            merge_semaphore.release()

        merged_filename = f"{pkg}-{info['versionCode']}-merged.apk"
        return Response(
            signed_apk,
            content_type='application/vnd.android.package-archive',
            headers={'Content-Disposition': f'attachment; filename="{sanitize_filename(merged_filename)}"'}
        )

    except Exception as e:
        logger.error(f"Merge download failed for {pkg}: {e}")
        return jsonify({'error': 'Download failed, please try again'}), 500


if __name__ == '__main__':

    debug = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    host = os.environ.get('HOST', '0.0.0.0')
    port = int(os.environ.get('PORT', '5000'))

    print(f'Starting GPlay Downloader on http://{host}:{port}')
    print(f'gpapi available: {HAS_GPAPI}')
    print(f'Debug mode: {debug}')

    if debug:
        app.run(host=host, port=port, debug=True)
    else:
        print('For production, use: gunicorn -c gunicorn.conf.py server:app')
        app.run(host=host, port=port, debug=False, threaded=True)
