#!/usr/bin/env python3
"""sse_stream_download 的跨请求续传验证（走真正的生产代码路径）。

和 test_partials.py 的区别：那个只测 partials 这个零件，这里测 server.py 里
两条下载路径（单流 / 4 段并发）在「SSE 断开后重新发起一次」时到底会不会重下。

跑法：env -u PYTHONPATH gplay-server/.venv/bin/python gplay-server/test_resume.py
（沙箱里 PYTHONPATH 注入的 sitecustomize 会拦 mkdir，必须去掉）
"""
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ['GPLAY_PARTIAL_DIR'] = tempfile.mkdtemp(prefix='gplay-resume-test-')

import server  # noqa: E402  导入即会起清理线程 / 预热连接，无副作用

BIG = os.urandom(8 * 1024 * 1024 + 4321)   # > PARALLEL_MIN_BYTES，走分段
SMALL = os.urandom(3 * 1024 * 1024 + 777)  # < 门槛，走单流

state = {'payload': b'', 'cut': [], 'ranges': [], 'served': 0, 'phase': 0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_GET(self):
        total = len(state['payload'])
        rng = self.headers.get('Range')
        start = int(rng[6:].split('-')[0]) if rng and rng.startswith('bytes=') else 0
        state['ranges'].append((state['phase'], rng or 'full'))
        chunk = state['payload'][start:]
        self.send_response(206 if rng else 200)
        self.send_header('Content-Length', str(len(chunk)))
        self.send_header('Accept-Ranges', 'bytes')
        if rng:
            self.send_header('Content-Range', f'bytes {start}-{total - 1}/{total}')
        self.end_headers()
        cut = state['cut'].pop(0) if state['cut'] else 0
        body = chunk[:cut] if cut else chunk
        # 限速到 ~1.5MB/s：不限速的话 8MB 一瞬间就下完了，「中途断开」根本来不及发生
        try:
            for i in range(0, len(body), 65536):
                self.wfile.write(body[i:i + 65536])
                self.wfile.flush()
                time.sleep(0.04)
        except (BrokenPipeError, ConnectionResetError):
            return  # 客户端提前断开（正是要测的场景），正常现象
        state['served'] += len(body)
        if cut:
            self.close_connection = True
            try:
                self.connection.close()
            except Exception:
                pass


def offset_of(rng):
    """Range 头 → 起始偏移。返回 None 表示这是探活用的 `bytes=0-0`（不算真正的重下）。"""
    if rng == 'full':
        return 0
    if rng == 'bytes=0-0':
        return None
    return int(rng[6:].split('-')[0])


def offsets(phase=None):
    return [o for p, r in state['ranges'] if phase is None or p == phase
            for o in [offset_of(r)] if o is not None]


def check(name, cond, extra=''):
    print(('  OK   ' if cond else '  FAIL ') + name + (f'  {extra}' if extra else ''))
    if not cond:
        raise SystemExit(1)


def run(sse_gen, until_bytes=None):
    """把 SSE 生成器跑到底；until_bytes 给值就跑到收够这么多字节后模拟客户端断开。"""
    out = []
    for chunk in sse_gen:
        out.append(chunk)
        if until_bytes:
            import json
            payload = json.loads(chunk[len('data: '):])
            if payload.get('bytes', 0) >= until_bytes:
                sse_gen.close()
                return None
    return out


def main():
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{srv.server_port}/app.apk'

    print('1. 单流：两次断线后自动续，返回的字节必须和原文件一致')
    state.update(payload=SMALL, cut=[600_000, 800_000], ranges=[], served=0, phase=0)
    key = server.partials.safe_key('com.test.small', 1, 'arm64-v8a')
    part = server.partials.PartialDownload(key, label='small')
    gen = server.sse_stream_download(url, {}, expected=len(SMALL), label='small', part=part)
    sent = []
    data = None
    try:
        while True:
            sent.append(next(gen))
    except StopIteration as stop:
        data = stop.value
    check('字节一致', data == SMALL, f'{len(data or b"")} / {len(SMALL)}')
    starts = offsets()
    check('三次请求，续传点单调前进且只从 0 开始一次',
          len(starts) == 3 and starts[0] == 0 and starts[1] > 0 and starts[2] > starts[1],
          str(starts))
    server.partials.discard_group(key)

    print('2. 分段：客户端中途断开（SSE close）之后重开一次，应该跳过已下区间')
    state.update(payload=BIG, cut=[], ranges=[], served=0, phase=0)
    key = server.partials.safe_key('com.test.big', 7, 'arm64-v8a')
    p1 = server.partials.PartialDownload(key, label='big')
    run(server.sse_stream_download(url, {}, expected=len(BIG), label='big', part=p1),
        until_bytes=len(BIG) * 0.6)
    first_served = state['served']
    filled = sum(max(0, s['pos'] - s['start']) for s in
                 (server.partials.PartialDownload(key).peek() or {}).get('segs', []))
    check('第一次断开时盘上确实存下了进度', filled > len(BIG) * 0.4,
          f'{filled / 1024 / 1024:.1f}MB / {len(BIG) / 1024 / 1024:.1f}MB')

    state['phase'] = 1
    state['served'] = 0
    state['ranges'] = []
    p2 = server.partials.PartialDownload(key, label='big')
    gen = server.sse_stream_download(url, {}, expected=len(BIG), label='big', part=p2)
    data = None
    try:
        while True:
            next(gen)
    except StopIteration as stop:
        data = stop.value

    check('第二次拿到的字节仍然完全一致', data == BIG, f'{len(data or b"")} / {len(BIG)}')
    starts = offsets(phase=1)
    check('第二次不是从 0 重下', bool(starts) and all(s > 0 for s in starts), str(starts))
    check('第二次只补了缺的那部分', state['served'] <= len(BIG) - filled + 1024 * 1024,
          f'补下 {state["served"] / 1024 / 1024:.1f}MB，缺 {(len(BIG) - filled) / 1024 / 1024:.1f}MB')
    server.partials.discard_group(key)

    print('\n全部通过')


if __name__ == '__main__':
    main()
