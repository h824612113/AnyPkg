#!/usr/bin/env python3
"""Play 下载的「落盘断点」——让续传能跨请求。

为什么需要这个：

Play 的 downloadUrl 是每次请求现签的 token，绑在那一次请求上。所以 HTTP 层的
Range 续传跨不了请求——用户点「重试」就是一条全新的 SSE，上一个请求攒在内存里的
buf 也跟着生成器一起没了，于是一个 208MB 的包断在第 137MB，重试还是从 0 开始。
本机这条线路单连接只有 ~40KB/s、每 30~40 秒被掐一次，从 0 重来等于永远下不完。

这里把字节按**绝对偏移**写到 `.part`（`os.pwrite`），进度写进同名 `.json`：

- pwrite 在锁内、且在更新 pos**之前**完成，所以 json 里的 pos 永远不超前于盘上的数据。
  反过来（盘上比 json 新）只是多下几百 KB，无害；而空洞是致命的——合并出来的 APK 会坏。
- 只按偏移写，不要求顺序，正好对上分段并发：4 条流各写各的区间，互不覆盖。
- 目录放 `~/.cache` 而不是 /tmp：/tmp 重启就清，而「昨天没下完」恰恰是常见场景。

key 用 `pkg|versionCode|arch`，版本一变就自然废弃旧断点，不会把两个版本的字节拼在一起。
"""

import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

PARTIAL_DIR = Path(os.environ.get('GPLAY_PARTIAL_DIR')
                   or (Path.home() / '.cache' / 'gplay-partials'))
PARTIAL_TTL = max(600, int(os.environ.get('GPLAY_PARTIAL_TTL', str(6 * 3600)) or 6 * 3600))
PARTIAL_MAX_BYTES = max(0, int(os.environ.get('GPLAY_PARTIAL_MAX_MB', '3072') or 3072)) * 1024 * 1024
META_MIN_INTERVAL = 1.0  # 进度写盘的节流间隔；每 256KB 写一次 JSON 纯属浪费


def _fmt(n):
    n = float(n or 0)
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return f'{n:.0f} {unit}' if unit == 'B' else f'{n:.1f} {unit}'
        n /= 1024
    return f'{n:.1f} GB'


def safe_key(*parts):
    """把包名等拼成一个能当文件名的 key，末尾加短哈希防截断撞名。"""
    raw = '|'.join('' if p is None else str(p) for p in parts)
    slug = re.sub(r'[^A-Za-z0-9._-]+', '_', raw).strip('._')[:100] or 'pkg'
    return f'{slug}-{hashlib.sha1(raw.encode()).hexdigest()[:8]}'


# 同一个包同时被两个请求下（双击、两个标签页）时，第二个必须用独立的断点文件，
# 否则两条流往同一个 .part 的同一段写，进度和内容都会互相踩。
# 记时间戳而不是布尔值：万一某个请求在 release 之前就被杀掉（客户端在 yield 处断开，
# 生成器直接 GC），占位会永远悬着，之后这个包就再也续不上——超过 CLAIM_STALE 自动作废。
_ACTIVE = {}
_ACTIVE_LOCK = threading.Lock()
CLAIM_STALE = 900


def claim(key):
    """占用一个 key。返回 (实际使用的 key, 是否由本次请求独占)。"""
    with _ACTIVE_LOCK:
        ts = _ACTIVE.get(key)
        if ts is not None and time.time() - ts < CLAIM_STALE:
            return f'{key}-x{uuid.uuid4().hex[:8]}', False
        _ACTIVE[key] = time.time()
        return key, True


def release(key, owned=True):
    if not owned:
        return
    with _ACTIVE_LOCK:
        _ACTIVE.pop(key, None)


class PartialDownload:
    """一个文件下到一半的状态：数据在 `.part`，进度在同名 `.json`。"""

    def __init__(self, key, label=''):
        self.key = key
        self.label = label or key
        self.path = PARTIAL_DIR / f'{key}.part'
        self.meta_path = PARTIAL_DIR / f'{key}.json'
        self.fd = -1
        self.mode = ''      # 'parts'（分段并发）| 'stream'（单流）
        self.total = 0
        self.pos = 0        # 仅 stream 用；parts 模式看 segs
        self.segs = []      # 仅 parts 用，和 fetch_parallel 共享同一份 list
        self._last_flush = 0.0
        self._broken = False  # 写盘失败过一次就彻底关掉持久化，别每 256KB 报一次警

    # ---------- 文件与元数据 ----------

    def _open(self):
        if self.fd >= 0:
            return
        try:
            PARTIAL_DIR.mkdir(parents=True, exist_ok=True)
            self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        except Exception as e:
            logger.warning('打开断点文件失败 %s：%s；本次下载继续，只是不保留断点', self.key, e)
            self._broken = True

    def _read_meta(self):
        try:
            with open(self.meta_path) as f:
                meta = json.load(f)
            return meta if isinstance(meta, dict) else None
        except Exception:
            return None

    def flush_meta(self, force=False):
        """把进度写盘。tmp + rename，避免读到半截 JSON。"""
        if self.fd < 0 or self._broken:
            return
        now = time.time()
        if not force and now - self._last_flush < META_MIN_INTERVAL:
            return
        self._last_flush = now
        meta = {
            'key': self.key,
            'mode': self.mode,
            'total': self.total,
            'pos': self.pos,
            'segs': self.segs,
            'updated': now,
        }
        tmp = self.meta_path.with_name(self.meta_path.name + '.tmp')
        try:
            with open(tmp, 'w') as f:
                json.dump(meta, f)
            os.replace(tmp, self.meta_path)
        except Exception as e:
            logger.warning('写断点进度失败 %s：%s', self.key, e)

    def pwrite(self, offset, data):
        if self.fd < 0 or self._broken or not data:
            return
        try:
            os.pwrite(self.fd, data, offset)
        except Exception as e:
            logger.warning('断点写盘失败 %s @%d：%s；本次继续，只是不再保留断点',
                           self.key, offset, e)
            self._broken = True
            try:
                os.close(self.fd)
            except Exception:
                pass
            self.fd = -1

    def read_bytes(self, size=None):
        try:
            with open(self.path, 'rb') as f:
                return f.read(size)
        except FileNotFoundError:
            return b''

    def discard(self):
        """丢掉断点（下完了、或者布局对不上）。"""
        if self.fd >= 0:
            try:
                os.close(self.fd)
            except Exception:
                pass
        self.fd = -1
        for p in (self.path, self.meta_path):
            try:
                p.unlink()
            except FileNotFoundError:
                pass
            except Exception as e:
                logger.warning('删除断点文件失败 %s：%s', p, e)

    def peek(self):
        """不打开文件，只看看盘上有什么。"""
        meta = self._read_meta()
        if not meta:
            return None
        try:
            size = self.path.stat().st_size
        except OSError:
            size = 0
        return {
            'mode': meta.get('mode') or '',
            'total': int(meta.get('total') or 0),
            'pos': int(meta.get('pos') or 0),
            'segs': meta.get('segs') or [],
            'size': size,
        }

    # ---------- 分段模式 ----------

    def resume_parts(self, layout, total):
        """layout 是这次打算切的 [{start,end}]；区间和总量都对得上才续。

        布局变了（比如 GPLAY_DOWNLOAD_PARTS 改过）就不能续：盘上的字节是按旧布局
        写的，按新布局去算「哪些位置已经有效」会算出错位的区间，合并出来就是坏包。
        """
        info = self.peek()
        if not info or info['mode'] != 'parts' or info['total'] != total:
            return False
        old = info['segs']
        if len(old) != len(layout):
            return False
        for a, b in zip(old, layout):
            try:
                if int(a['start']) != b['start'] or int(a['end']) != b['end']:
                    return False
                if not (b['start'] <= int(a.get('pos', b['start'])) <= b['end'] + 1):
                    return False
            except Exception:
                return False
        if info['size'] != total:
            return False
        self._open()
        if self.fd < 0:
            return False
        self.mode = 'parts'
        self.total = total
        self.segs = [{'start': b['start'], 'end': b['end'],
                      'pos': int(a.get('pos', b['start']))}
                     for a, b in zip(old, layout)]
        return True

    def start_parts(self, layout, total):
        self.discard()
        self._open()
        if self.fd < 0:
            return
        try:
            # 预分配：4 条流各写自己的偏移，中间的空洞由读回来的那一步补零，不需要顺序
            os.ftruncate(self.fd, total)
        except Exception as e:
            logger.warning('预分配断点文件失败 %s：%s', self.key, e)
        self.mode = 'parts'
        self.total = total
        self.segs = [{'start': b['start'], 'end': b['end'], 'pos': b['start']} for b in layout]
        self.flush_meta(force=True)

    # ---------- 单流模式 ----------

    def resume_stream(self, expected=0):
        """盘上有同一份包的单流进度就接着下，返回已收字节数（0 = 从头）。"""
        info = self.peek()
        if not info or info['mode'] != 'stream':
            return 0
        pos = min(info['pos'], info['size'])
        total = info['total']
        if total and pos > total:
            pos = 0  # 元数据被写坏过，宁可重下也不拼出坏包
        if pos <= 0:
            return 0
        self._open()
        if self.fd < 0:
            return 0
        self.mode = 'stream'
        self.total = total or expected or 0
        self.pos = pos
        return pos

    def begin_stream(self, total=0):
        """单流不预分配：pwrite 到文件尾会自动把文件撑长，省一次 208MB 的 fturcate。"""
        self._open()
        self.mode = 'stream'
        if total:
            self.total = total

    def set_stream_pos(self, pos, total=0):
        self.pos = pos
        if total:
            self.total = total
        self.flush_meta()

    def completed_bytes(self):
        """盘上这份如果已经下完，直接给字节；否则 None。"""
        info = self.peek()
        if not info:
            return None
        total = info['total']
        if info['mode'] == 'stream':
            if total and info['pos'] >= total and info['size'] >= total:
                return self.read_bytes(total)
            return None
        segs = info['segs']
        if total and segs and all(int(s.get('pos', 0)) > int(s['end']) for s in segs):
            return self.read_bytes(total)
        return None


def download_to_part(url, headers, part, expected=0, timeout=(10, 120),
                     chunk=256 * 1024, stall_limit=4, max_attempts=60):
    """把一个文件下到 part 上，断了用 Range 从断点接着下，返回完整 bytes。

    和 server.py 里 base APK 的单流循环是同一个判据（看「有没有前进」，不看
    「重试了几次」）；差别是每块都往盘上 pwrite，所以进程被杀、请求被掐、
    用户点重试都不会丢进度。splits 走这条路：30MB 也是几百次断线的事。
    """
    pos = part.resume_stream(expected)
    if pos:
        logger.info('%s 从断点续传：%s', part.label, _fmt(pos))
    attempt = 0
    stall = 0
    while True:
        before = pos
        try:
            h = dict(headers or {})
            if pos:
                h['Range'] = f'bytes={pos}-'
            # 必须要求未压缩：带 gzip 时 Range 是按压缩流切的，偏移和内容对不上
            h['Accept-Encoding'] = 'identity'
            with requests.get(url, headers=h, timeout=timeout, stream=True) as r:
                if not r.ok:
                    raise ValueError(f'HTTP {r.status_code}')
                if pos and r.status_code != 206:
                    # 上游忽略了 Range 回了整包：只能从头写，否则文件里会留下错位的旧前缀
                    logger.warning('%s 不认 Range（HTTP %d），从头重下', part.label, r.status_code)
                    pos = 0
                    try:
                        os.ftruncate(part.fd, 0)
                    except Exception:
                        part.discard()
                cl = int(r.headers.get('content-length') or 0)
                total = (cl + pos) if cl else (expected or part.total or 0)
                part.begin_stream(total)
                for piece in r.iter_content(chunk):
                    if not piece:
                        continue
                    part.pwrite(pos, piece)
                    pos += len(piece)
                    part.set_stream_pos(pos, total)
                if cl and pos - before < cl:
                    raise ValueError(f'只收到 {_fmt(pos - before)} / {_fmt(cl)}')
                if total and pos < total:
                    raise ValueError(f'不完整：{_fmt(pos)} / {_fmt(total)}')
                break
        except Exception as e:
            stall = 0 if pos > before else stall + 1
            attempt += 1
            if stall >= stall_limit or attempt >= max_attempts:
                raise
            wait = min(5.0, 0.8 * stall) if stall else 0.0
            logger.warning('%s 第 %d 次中断：%s；已收 %s%s', part.label, attempt, e, _fmt(pos),
                           f'，{wait:.1f}s 后续传' if wait else '，立刻续传')
            if wait:
                time.sleep(wait)
    part.set_stream_pos(pos, part.total)
    part.flush_meta(force=True)
    return part.read_bytes(pos)


def discard_group(key):
    """删掉 key 以及它的分片（`<key>-s0` 等）的断点文件。合并成功后调用。"""
    try:
        if not PARTIAL_DIR.exists():
            return
        for p in PARTIAL_DIR.glob(key + '*'):
            if p.suffix not in ('.part', '.json', '.tmp'):
                continue
            try:
                p.unlink()
            except Exception:
                pass
    except Exception as e:
        logger.warning('清理断点失败 %s：%s', key, e)


def cleanup():
    """按 TTL / 总量清理断点。放在 ~/.cache 就不归 /tmp 那套机制管，得自己收拾。"""
    try:
        if not PARTIAL_DIR.exists():
            return
        now = time.time()
        entries = []
        for p in PARTIAL_DIR.glob('*.part'):
            try:
                st = p.stat()
            except OSError:
                continue
            entries.append((st.st_mtime, st.st_size, p))
        entries.sort()  # 最老的先删
        total = sum(s for _, s, _ in entries)
        for mtime, size, p in entries:
            if now - mtime <= PARTIAL_TTL and total <= PARTIAL_MAX_BYTES:
                continue
            # 正在下的文件 mtime 一直是新的；但总量超限时也别碰十分钟内动过的，
            # 不然一个 208MB 的断点可能刚写到 3% 就被清理线程删掉
            if now - mtime < 600 and total > PARTIAL_MAX_BYTES:
                continue
            for q in (p, p.with_name(p.name[:-len('.part')] + '.json')):
                try:
                    q.unlink()
                except Exception:
                    pass
            total -= size
            logger.info('清理断点 %s（%s）', p.name, _fmt(size))
        # 孤儿 json（.part 已经没了）
        for p in PARTIAL_DIR.glob('*.json'):
            try:
                if now - p.stat().st_mtime > PARTIAL_TTL:
                    p.unlink()
            except Exception:
                pass
    except Exception as e:
        logger.warning('清理断点失败：%s', e)
