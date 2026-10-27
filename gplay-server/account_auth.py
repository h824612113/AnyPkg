#!/usr/bin/env python3
"""
Personal Google account ("burner account") authentication.

Implements the same flow Aurora Store uses for personal accounts, so no
token dispenser is needed:

  1. The user signs in at https://accounts.google.com/EmbeddedSetup in a
     browser and copies the `oauth_token` cookie (starts with "oauth2_4/").
  2. That oauth_token is exchanged for a long-lived AAS token
     ("aas_et/...") at android.clients.google.com/auth
     (service=ac2dm, add_account=1, ACCESS_TOKEN=1 — see Aurora Store
     AC2DMTask.kt).
  3. The AAS token + a device profile produce a Play auth session:
     device checkin (gsfId), device config upload, then a token exchange
     for service=oauth2:https://www.googleapis.com/auth/googleplay
     (see Aurora gplayapi AuthHelper.build / GooglePlayApi.generateToken).

The result is a dict in the same shape a dispenser returns, so the rest
of the code (CLI and server) consumes it unchanged.

The AAS token is long-lived: store it and re-run step 3 whenever the
Play token expires.
"""

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.parse import quote

import requests

# Base URL is overridable so tests can run against a local mock server.
AUTH_BASE = os.environ.get('GPLAY_ACCOUNT_AUTH_BASE', 'https://android.clients.google.com/').rstrip('/') + '/'
AUTH_URL = AUTH_BASE + 'auth'

# Signature of the Play Store package, used by all Google auth clients.
CALLER_SIG = '38918a453d07199354f8b19af05ec6562ced5788'
PLAY_SERVICES_VERSION = 19629032
DEFAULT_DEVICE = os.environ.get('GPLAY_ACCOUNT_DEVICE', 'walleye')

# The page where the user signs in to obtain the oauth_token cookie.
EMBEDDED_SETUP_URL = 'https://accounts.google.com/EmbeddedSetup'

OAUTH_TOKEN_HELP = f"""To get an oauth_token for your (burner) Google account:
  1. Open {EMBEDDED_SETUP_URL} in a browser (use a private window).
  2. Sign in with the account. After sign-in you may see a blank or ToS page - that's fine.
  3. Open DevTools (F12) -> Application/Storage -> Cookies -> accounts.google.com
     and copy the value of the cookie named "oauth_token" (starts with oauth2_4/).
  4. The token is single-use and expires in minutes - exchange it right away.
"""


class AccountAuthError(Exception):
    """Raised when Google's auth endpoint rejects a request."""


def _noop_log(msg):
    pass


def _parse_kv_response(text):
    """Parse Google's key=value auth response body into a dict (keys lowercased)."""
    out = {}
    for line in text.split():
        if '=' in line:
            k, v = line.split('=', 1)
            out[k.strip().lower()] = v.strip()
    return out


def _post_auth(params, headers, proxies=None):
    resp = requests.post(AUTH_URL, data=params, headers=headers, timeout=30, proxies=proxies)
    data = _parse_kv_response(resp.text)
    if 'error' in data:
        raise AccountAuthError(f"Google auth error: {data['error']} (HTTP {resp.status_code})")
    return data


BROWSER_CANDIDATES = [
    'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    'brave-browser', 'microsoft-edge',
    # macOS 的浏览器不在 PATH 里，只能按 .app 包内路径找；不加这几条
    # find_browser() 在 Mac 上永远返回 None，browser 登录直接报错。
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]

# Aurora Store scrapes the signed-in account's email from the post-login page:
# <div data-profile-identifier data-email="user@gmail.com"> (GoogleLoginScreen.kt)
JS_PROFILE_EMAIL = """
(function() {
  var el = document.querySelector('[data-profile-identifier][data-email]');
  return el ? el.getAttribute('data-email') : null;
})()
"""


def find_browser():
    """Return the path of an installed Chromium-based browser, or None."""
    for name in BROWSER_CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


class _CdpClient:
    """Tiny Chrome DevTools Protocol client over websocket-client."""

    def __init__(self, ws_url):
        import websocket
        self.ws = websocket.create_connection(ws_url, timeout=10)
        self._id = 0

    def call(self, method, params=None):
        self._id += 1
        self.ws.send(json.dumps({'id': self._id, 'method': method, 'params': params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == self._id:
                if 'error' in msg:
                    raise AccountAuthError(f"CDP {method} failed: {msg['error']}")
                return msg.get('result', {})
            # else: async event, ignore

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def _free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


# Chrome 自己的沙箱在受限宿主里起不来（典型是 IDE/Agent 的进程沙箱）：
#   sandbox initialization failed: Operation not permitted
# 然后 GPU / network 子进程反复退出，最后 FATAL: GPU process isn't usable. Goodbye.
# 用户看到的就是 macOS 的「Google Chrome 意外退出」弹窗。关掉 Chrome 的沙箱和 GPU
# 就能正常跑；这个窗口只用来登 accounts.google.com，profile 是临时的，风险可控。
SANDBOX_BUSTERS = ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
                   '--disable-dev-shm-usage']


def _host_is_sandboxed():
    """宿主是否处在进程沙箱里。WorkBuddy / CodeBuddy 会留下这两个变量之一。"""
    return bool(os.environ.get('CODEBUDDY_TOYBOX_SANDBOX_PROFILE')
                or os.environ.get('SANDBOX_CENTER_UID'))


def _wait_devtools(port, proc, tries=50, delay=0.2):
    """等 CDP 端口起来。进程中途死掉就立刻返回 None，不要傻等 10 秒。"""
    for _ in range(tries):
        if proc.poll() is not None:
            return None
        try:
            return requests.get(f'http://127.0.0.1:{port}/json/version',
                                timeout=2, proxies={'http': None, 'https': None}
                                ).json()['webSocketDebuggerUrl']
        except Exception:
            time.sleep(delay)
    return None


def _launch(browser, profile_dir, url, extra_flags, headless, profile_directory=None):
    port = _free_port()
    args = [
        browser,
        f'--remote-debugging-port={port}',
        f'--user-data-dir={profile_dir}',
        '--no-first-run', '--no-default-browser-check',
        '--remote-allow-origins=*',
        '--disable-blink-features=AutomationControlled',
        '--window-size=480,720',
        *extra_flags,
    ]
    if profile_directory:
        # 复用本机浏览器时必须点名是哪个 profile，否则会落到它的 Default
        args.append(f'--profile-directory={profile_directory}')
    if headless:
        args.append('--headless=new')
    args.append(url)
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return proc, port


def capture_oauth_token_via_browser(log=_noop_log, timeout=900, headless=False,
                                    browser_path=None, url=EMBEDDED_SETUP_URL,
                                    cookie_domain='google.com', page_match='accounts.google.com',
                                    login_hint=None):
    """Launch a local browser window on the sign-in page and capture the
    oauth_token cookie (and the account email) automatically via the
    Chrome DevTools Protocol.

    Returns (email_or_None, oauth_token). Only works when a Chromium-based
    browser is installed on the machine running this code.

    ``login_hint`` 只是把邮箱预填进登录页（省得手输），不改变「必须登录一次」
    这个事实。为什么不直接复用本机浏览器已经登录的会话：试过了，不行——

    1. Chrome 136+ 拒绝在默认 user-data-dir 上开远程调试
       （"DevTools remote debugging requires a non-default data directory"），
       符号链接也会被 realpath 掉，所以没法用 CDP 盯着真实 profile 抓 cookie。
    2. 把 Cookies 库复制到别的 profile 里起浏览器，SID/LSID/OSID 都在，
       照样跳到 v3/signin——Google 的 EmbeddedSetup 不认桌面会话，要重新认证。
    3. oauth_token 是 session cookie，Chrome 退出前不会落盘，关掉再读库也没有。

    所以这里只做「预填邮箱 + 正常登录」。
    """
    browser = browser_path or find_browser()
    if not browser:
        raise AccountAuthError(
            'No Chromium-based browser found (tried: %s). '
            'Use the manual oauth_token flow instead.' % ', '.join(BROWSER_CANDIDATES))

    if login_hint:
        # Google 认 login_hint，页面上会直接把邮箱填好
        sep = '&' if '?' in url else '?'
        url = f'{url}{sep}login_hint={quote(login_hint)}'

    # Persistent profile: Google remembers the "device" across sign-ins, so
    # 2-step verification is usually only needed the first time.
    profile_dir = os.path.join(tempfile.gettempdir() if headless else str(os.path.expanduser('~')),
                               '.gplay-login-profile')
    os.makedirs(profile_dir, exist_ok=True)

    # 先按常规参数起；如果宿主有沙箱就先直接带上破沙箱参数，省掉一次必然的崩溃
    # （崩一次就会弹一次系统的「意外退出」对话框，很吓人）。
    attempts = [SANDBOX_BUSTERS] if _host_is_sandboxed() else [[], SANDBOX_BUSTERS]

    proc = None
    ws_url = None
    port = None
    for i, flags in enumerate(attempts):
        log(f"Opening browser window for Google sign-in ({os.path.basename(browser)})"
            + (f" for {login_hint}" if login_hint else '')
            + ('...' if not flags else ' [sandbox-bypass]...'))
        proc, port = _launch(browser, profile_dir, url, flags, headless)
        ws_url = _wait_devtools(port, proc)
        if ws_url:
            break
        if proc.poll() is None:
            proc.terminate()
        if i + 1 < len(attempts):
            log('Browser exited during startup; retrying with its sandbox disabled '
                '(restricted host).', 'dim')

    cdp = None
    try:
        if not ws_url:
            raise AccountAuthError(
                '浏览器启动后立刻退出了（DevTools 端口没起来）。'
                '常见原因是本机进程沙箱不允许 Chrome 自己的沙箱初始化：'
                '报错形如 "sandbox initialization failed: Operation not permitted"。'
                '可以在终端里直接跑 python gplay-server/server.py 重试，'
                '或改用下面的「手动填 Token」。')

        cdp = _CdpClient(ws_url)
        log('Browser ready. Sign in with your (burner) Google account in the new window '
            '(complete 2-step verification if asked); the token is captured when sign-in completes.')

        deadline = time.time() + timeout
        while time.time() < deadline:
            if proc.poll() is not None:
                raise AccountAuthError(
                    '浏览器窗口在登录完成前退出了（Chrome 崩溃或被手动关闭）。'
                    '如果反复崩溃，用「手动填 Token」那条路。')
            try:
                cookies = cdp.call('Storage.getCookies').get('cookies', [])
            except AccountAuthError as e:
                # websocket 断了：Chrome 进程多半已经没了，别把底层报错直接甩给用户
                if proc.poll() is not None:
                    raise AccountAuthError('浏览器进程已退出（Chrome 崩溃），登录没有完成。') from e
                raise
            token = next((c['value'] for c in cookies
                          if c['name'] == 'oauth_token' and cookie_domain in c.get('domain', '')), None)
            if token:
                log(f"Captured oauth_token cookie ({token[:12]}...)")
                email = _scrape_email(port, page_match)
                if email:
                    log(f"Detected signed-in account: {email}")
                return email, token
            time.sleep(1)
        raise AccountAuthError(f'Timed out after {timeout}s waiting for sign-in')
    finally:
        if cdp:
            try:
                cdp.call('Browser.close')
            except Exception:
                pass
            cdp.close()
        if proc and proc.poll() is None:
            proc.terminate()


def _scrape_email(port, page_match='accounts.google.com'):
    """Read the signed-in email from the EmbeddedSetup page via CDP, if visible."""
    try:
        tabs = requests.get(f'http://127.0.0.1:{port}/json/list', timeout=5).json()
        page = next((t for t in tabs
                     if t.get('type') == 'page' and page_match in t.get('url', '')), None)
        if not page:
            return None
        cdp = _CdpClient(page['webSocketDebuggerUrl'])
        try:
            result = cdp.call('Runtime.evaluate',
                              {'expression': JS_PROFILE_EMAIL, 'returnByValue': True})
            return result.get('result', {}).get('value')
        finally:
            cdp.close()
    except Exception:
        return None


def exchange_oauth_token(email, oauth_token, proxies=None, log=_noop_log):
    """Exchange a browser oauth_token cookie for a long-lived AAS token.

    Mirrors Aurora Store's AC2DMTask.getAC2DMResponse().
    Returns the AAS token string ("aas_et/...").
    """
    log(f"Exchanging oauth_token for AAS token ({email}) at {AUTH_URL}")
    params = {
        'lang': 'en-US',
        'google_play_services_version': PLAY_SERVICES_VERSION,
        'sdk_version': 28,
        'device_country': 'us',
        'Email': email,
        'service': 'ac2dm',
        'get_accountid': 1,
        'ACCESS_TOKEN': 1,
        'callerPkg': 'com.google.android.gms',
        'add_account': 1,
        'Token': oauth_token,
        'callerSig': CALLER_SIG,
        'droidguard_results': 'null',
    }
    headers = {
        'app': 'com.google.android.gms',
        'User-Agent': '',
        'Content-Type': 'application/x-www-form-urlencoded',
    }
    data = _post_auth(params, headers, proxies=proxies)
    token = data.get('token')
    if not token:
        raise AccountAuthError(f"No Token in AAS exchange response (got keys: {sorted(data)})")
    log(f"Got AAS token ({token[:12]}..., {len(token)} chars) - this token is long-lived, keep it safe")
    return token


def login_with_password(email, password, proxies=None, log=_noop_log):
    """用 Google 账号密码换 AAS token —— 不开浏览器。

    走的是和 oauth_token 完全相同的 ac2dm 端点，区别只是把 `Token` 换成
    `EncryptedPasswd`（gpapi 内置的 Google RSA 公钥，纯本地计算，不联网）。

    为什么需要这条路：桌面浏览器的登录态不能直接给 Android 用，
    EmbeddedSetup 会强制重新认证一次，于是每次都要弹一个空窗口让人重输密码。
    有密码就能直接换 token，窗口完全不用出现。
    """
    from gpapi.googleplay import GooglePlayAPI

    encrypted = GooglePlayAPI.encryptPassword(None, email, password)
    if isinstance(encrypted, bytes):
        encrypted = encrypted.decode('utf-8')

    log(f"Signing in as {email} with the password (no browser window)...")
    params = {
        'lang': 'en-US',
        'google_play_services_version': PLAY_SERVICES_VERSION,
        'sdk_version': 28,
        'device_country': 'us',
        'Email': email,
        'EncryptedPasswd': encrypted,
        'service': 'ac2dm',
        'add_account': 1,
        'callerPkg': 'com.google.android.gms',
        'callerSig': CALLER_SIG,
    }
    headers = {
        'app': 'com.google.android.gms',
        'User-Agent': '',
        'Content-Type': 'application/x-www-form-urlencoded',
    }
    try:
        data = _post_auth(params, headers, proxies=proxies)
    except AccountAuthError as e:
        msg = str(e)
        raw = msg.replace('Google auth error: ', '').strip()
        low = msg.lower()
        # 只记长度和错误码：长度能看出是不是少打了字符，内容一个字都不落盘
        log(f"[google-login] Google 拒绝：{raw} (email={email}, 密码 {len(password)} 位)")
        # Google 的风控错误码翻成人话，前端才知道下一步该干嘛；原始码留在括号里方便排查
        if 'needsbrowser' in low or 'captcharequired' in low:
            raise AccountAuthError(
                'Google 要求浏览器验证（新设备或异地登录）。请用「浏览器登录」一次，'
                f'通过后这枚 token 长期有效，之后不用再登。（{raw}）')
        if 'notverified' in low:
            raise AccountAuthError(f'这个账号还没完成 Google 的验证，先在网页上登录一次。（{raw}）')
        if 'badauthentication' in low:
            # 关键：BadAuthentication 不等于「密码打错了」。Google 对可疑的密码登录
            # （机房代理 IP、新设备、账号开了两步验证）也回同一个码，故意不给细节。
            # 如果照字面写成「密码不对」，用户会一直重输正确的密码，越试越怀疑自己。
            raise AccountAuthError(
                'Google 拒绝了这次密码登录（BadAuthentication）。这个码有两种含义：'
                '① 密码确实不对；② 密码是对的，但 Google 认为这次登录可疑——'
                '用代理/机房 IP、或者账号开了两步验证时几乎必然如此，它不会告诉你真正原因。'
                f'你这次提交了 {len(password)} 位密码，如果和实际长度对不上，就是少了字符；'
                '对得上就别再试了，回到上一屏点「借 Chrome 的登录状态」，一次就过。'
                f'（{raw}）')
        raise

    token = data.get('token')
    if not token:
        raise AccountAuthError(
            f"密码登录没拿到 token（返回字段：{sorted(data)}）")
    log(f"Got AAS token ({token[:12]}..., {len(token)} chars) - long-lived, no browser needed")
    return token


def _default_auth_params(email, gsf_id_hex=None):
    """Common params for token exchanges (Aurora ParamProvider.getDefaultAuthParams)."""
    params = {
        'sdk_version': 28,
        'Email': email,
        'google_play_services_version': PLAY_SERVICES_VERSION,
        'device_country': 'us',
        'lang': 'en',
        'callerSig': CALLER_SIG,
    }
    if gsf_id_hex:
        params['androidId'] = gsf_id_hex
    return params


def _exchange_aas_token(email, aas_token, service, gsf_id_hex=None, app=None,
                        header_app='com.android.vending', proxies=None):
    """Exchange the AAS token for a service token (Aurora GooglePlayApi.generateToken)."""
    params = _default_auth_params(email, gsf_id_hex)
    params.update({
        'client_sig': CALLER_SIG,
        'callerPkg': 'com.google.android.gms',
        'Token': aas_token,
        'oauth2_foreground': '1',
        'token_request_options': 'CAA4AVAB',
        'check_email': '1',
        'system_partition': '1',
        'service': service,
    })
    if app:
        params['app'] = app
    headers = {
        'app': header_app,
        'User-Agent': 'GoogleAuth/1.4',
        'Content-Type': 'application/x-www-form-urlencoded',
    }
    data = _post_auth(params, headers, proxies=proxies)
    token = data.get('auth') or data.get('token')
    if not token:
        raise AccountAuthError(f"No Auth token in exchange response for {service} (got keys: {sorted(data)})")
    return token


def _unescape_prop(value):
    r"""Undo java-properties escapes (\: and \=) in Aurora profile values."""
    return value.replace('\\:', ':').replace('\\=', '=')


def _aurora_device_builder(profile, locale='en_US', timezone=None):
    """Build a gpapi DeviceBuilder from one of this repo's Aurora device
    profiles (profiles/*.properties) so the registered virtual device is a
    modern phone, not gpapi's bundled 2018-era hardware.

    Aurora keys map 1:1 to gpapi's lowercased keys (Build.FINGERPRINT ->
    build.fingerprint etc.); gpapi's 'walleye' entry fills any gaps.
    """
    from gpapi.config import DeviceBuilder
    builder = DeviceBuilder('walleye')
    builder.device.update({k.lower(): _unescape_prop(v) for k, v in profile.items()})
    builder.setLocale(locale)
    tz = timezone or builder.device.get('timezone') or 'America/New_York'
    builder.setTimezone(tz)
    return builder


def _resolve_device(device):
    """Resolve the device argument to (aurora_profile_dict_or_None, gpapi_codename_or_None, name)."""
    if isinstance(device, dict):
        return device, None, device.get('UserReadableName', 'custom profile')
    if device:
        from gpapi.config import getDevicesCodenames
        if device in getDevicesCodenames():
            return None, device, device
        import device_profiles
        entry = device_profiles.ALL_PROFILES.get(device)
        if entry:
            return entry['profile'], None, entry['name']
        raise AccountAuthError(f"Unknown device '{device}' (not a gpapi codename or a profiles/*.properties name)")
    import device_profiles
    profile = device_profiles.DEFAULT_ARM64_PROFILE
    return profile, None, profile.get('UserReadableName', 'default profile')


def _accept_tos(api, auth_token, gsf_id_hex, log=_noop_log):
    """GET fdfe/toc and accept the ToS if asked; returns the dfeCookie.

    Mirrors the end of Aurora gplayapi AuthHelper.build() / GooglePlayApi.toc().
    """
    from gpapi import googleplay_pb2

    headers = {
        'Authorization': f'Bearer {auth_token}',
        'User-Agent': api.deviceBuilder.getUserAgent(),
        'X-DFE-Device-Id': gsf_id_hex,
        'Accept-Language': 'en-US',
    }
    resp = requests.get(AUTH_BASE + 'fdfe/toc', headers=headers, timeout=30,
                        proxies=api.proxies_config)
    wrapper = googleplay_pb2.ResponseWrapper.FromString(resp.content)
    toc = wrapper.payload.tocResponse

    if toc.tosContent and toc.tosToken:
        r2 = requests.post(AUTH_BASE + 'fdfe/acceptTos',
                           data={'tost': toc.tosToken, 'toscme': 'false'},
                           headers=headers, timeout=30, proxies=api.proxies_config)
        googleplay_pb2.ResponseWrapper.FromString(r2.content)
        log("Step 5/5: terms of service accepted")
    if toc.cookie:
        log(f"Step 5/5: got dfeCookie ({toc.cookie[:12]}...)")
        return toc.cookie
    log("Step 5/5: no dfeCookie in toc response (ok)")
    return ''


def build_auth_data(email, aas_token, device=None, locale='en_US',
                    timezone='America/New_York', proxies=None, log=_noop_log):
    """Build a dispenser-format auth dict from an email + AAS token.

    Mirrors Aurora gplayapi AuthHelper.build(): checkin -> gsfId,
    upload device config, exchange AAS token for the Play auth token.
    """
    from gpapi.googleplay import GooglePlayAPI
    from gpapi import googleplay as gp

    # Point gpapi at the same (overridable) base URL used for token exchanges.
    gp.CHECKIN_URL = AUTH_BASE + 'checkin'
    gp.UPLOAD_URL = AUTH_BASE + 'fdfe/uploadDeviceConfig'
    gp.AUTH_URL = AUTH_URL

    aurora_profile, codename, device_name = _resolve_device(device)
    log(f"Building auth session for {email} using device profile '{device_name}'")
    api = GooglePlayAPI(locale=locale, timezone=timezone,
                        device_codename=codename or 'walleye')
    if aurora_profile is not None:
        api.deviceBuilder = _aurora_device_builder(aurora_profile, locale, timezone)
    api.proxies_config = proxies

    # 1. AC2DM token (needed to attach the account during checkin)
    log("Step 1/5: exchanging AAS token for AC2DM token...")
    ac2dm_token = _exchange_aas_token(email, aas_token, 'ac2dm', proxies=proxies)
    log("Step 1/5: AC2DM token OK")

    # 2. Device checkin -> gsfId (android id)
    log("Step 2/5: device checkin (registering virtual device, getting gsfId)...")
    try:
        gsf_id = api.checkin(email, ac2dm_token)
    except Exception as e:
        raise AccountAuthError(f'Device checkin failed: {e}')
    gsf_id_hex = '{0:x}'.format(gsf_id)
    api.gsfId = gsf_id
    log(f"Step 2/5: checkin OK, gsfId={gsf_id_hex}")

    # 3. Play Store auth token (needed as Authorization for the config upload)
    log("Step 3/5: exchanging AAS token for Play Store auth token...")
    auth_token = _exchange_aas_token(
        email, aas_token, 'oauth2:https://www.googleapis.com/auth/googleplay',
        gsf_id_hex=gsf_id_hex, app='com.android.vending',
        header_app='com.google.android.gms', proxies=proxies)
    api.setAuthSubToken(auth_token)
    log(f"Step 3/5: Play auth token OK ({auth_token[:12]}...)")

    # 4. Upload device config (improves compatibility; not fatal if it fails)
    log("Step 4/5: uploading device configuration...")
    try:
        api.uploadDeviceConfig()
        log("Step 4/5: device config uploaded")
    except Exception as e:
        log(f"Step 4/5: device config upload failed ({e}) - continuing without it")

    # 5. Terms of service + dfeCookie (Aurora AuthHelper ends with api.toc();
    # without accepted ToS, delivery responses come back without download URLs)
    log("Step 5/5: fetching Play terms of service / session cookie...")
    dfe_cookie = ''
    try:
        dfe_cookie = _accept_tos(api, auth_token, gsf_id_hex, log=log)
    except Exception as e:
        log(f"Step 5/5: ToS handling failed ({e}) - continuing without dfeCookie")

    device_props = api.deviceBuilder.device
    auth_data = {
        'email': email,
        'aasToken': aas_token,
        'authToken': auth_token,
        'gsfId': gsf_id_hex,
        'ac2dmToken': ac2dm_token,
        'deviceCheckInConsistencyToken': api.deviceCheckinConsistencyToken or '',
        'deviceConfigToken': api.device_config_token or '',
        'dfeCookie': dfe_cookie,
        'accountType': 'personal',
        'deviceInfoProvider': {
            'userAgentString': api.deviceBuilder.getUserAgent(),
            'mccMnc': device_props.get('celloperator', ''),
            'device': device_name,
        },
    }
    return auth_data
