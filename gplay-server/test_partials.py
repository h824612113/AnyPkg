#!/usr/bin/env python3
"""partials.py 的自测：不碰外网，用本地 flask/HTTPServer 模拟「下到一半被掐」。

跑法：gplay-server/.venv/bin/python gplay-server/test_partials.py
断点逻辑错了的后果是合并出坏包（不是报错），所以这里必须逐字节比对。
"""
import hashlib
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ['GPLAY_PARTIAL_DIR'] = tempfile.mkdtemp(prefix='gplay-partials-test-')

import partials  # noqa: E402

PAYLOAD = os.urandom(3 * 1024 * 1024 + 12345)
DROP_AFTER = [700_000, 900_000]   # 前两次请求各吐这么多就断线
state = {'served': 0, 'requests': []}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_GET(self):
        rng = self.headers.get('Range')
        start = 0
        if rng and rng.startswith('bytes='):
            start = int(rng[6:].split('-')[0])
        state['requests'].append(start)
        chunk = PAYLOAD[start:]
        self.send_response(206 if rng else 200)
        self.send_header('Content-Length', str(len(chunk)))
        self.send_header('Accept-Ranges', 'bytes')
        if rng:
            self.send_header('Content-Range', f'bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}')
        self.end_headers()
        # 模拟这条线路：吐一段就被掐
        if state['served'] < len(DROP_AFTER):
            cut = min(DROP_AFTER[state['served']], len(chunk))
            state['served'] += 1
            self.wfile.write(chunk[:cut])
            self.wfile.flush()
            self.close_connection = True
            try:
                self.connection.close()
            except Exception:
                pass
            return
        self.wfile.write(chunk)


def check(name, cond, extra=''):
    print(('  OK   ' if cond else '  FAIL ') + name + (f'  {extra}' if extra else ''))
    if not cond:
        raise SystemExit(1)


def main():
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{srv.server_port}/app.apk'

    print('1. 单流：断两次后用 Range 续，最后字节必须完全一致')
    key = partials.safe_key('com.test.app', 1917, 'arm64-v8a')
    part = partials.PartialDownload(key, label='test base')
    data = partials.download_to_part(url, {}, part, expected=len(PAYLOAD))
    check('字节一致', data == PAYLOAD, f'{len(data)} / {len(PAYLOAD)}')
    # 续传点由 iter_content 的 256KB 粒度决定，不写死具体数字，只要求单调前进且只从 0 开始一次
    starts = state['requests']
    check('断了两次、每次都从已收处续', len(starts) == 3 and starts[0] == 0
          and starts[1] > 0 and starts[2] > starts[1], str(starts))

    print('2. 同样的 key 再来一次：应该直接判定已下完，一个请求都不发')
    before = list(state['requests'])
    part2 = partials.PartialDownload(key, label='test base')
    done = part2.completed_bytes()
    check('盘上判完成', done == PAYLOAD)
    check('没有多余请求', state['requests'] == before)
    partials.discard_group(key)
    check('discard 后文件清空', not part2.path.exists() and not part2.meta_path.exists())

    print('3. 分段：区间按偏移落盘，进度能被新实例读回')
    total = 4 * 1024 * 1024
    layout = [{'start': i * 1024 * 1024, 'end': (i + 1) * 1024 * 1024 - 1} for i in range(4)]
    p3 = partials.PartialDownload('segs-demo')
    p3.start_parts(layout, total)
    p3.pwrite(0, b'A' * 1024)
    p3.pwrite(2 * 1024 * 1024, b'B' * 2048)
    p3.segs[0]['pos'] = 1024
    p3.segs[2]['pos'] = 2 * 1024 * 1024 + 2048
    p3.flush_meta(force=True)

    p4 = partials.PartialDownload('segs-demo')
    check('布局对得上就能续', p4.resume_parts(layout, total))
    check('pos 恢复', [s['pos'] for s in p4.segs] == [1024, 1048576, 2 * 1024 * 1024 + 2048, 3 * 1024 * 1024],
          str([s['pos'] for s in p4.segs]))
    buf = p4.read_bytes(total)
    check('已落盘的字节位置正确',
          buf[:1024] == b'A' * 1024 and buf[2 * 1024 * 1024:2 * 1024 * 1024 + 2048] == b'B' * 2048
          and buf[1024:2048] == b'\x00' * 1024)

    print('4. 布局/总量变了就不能续（否则会拼出错位的包）')
    p5 = partials.PartialDownload('segs-demo')
    check('总量不同 → 拒绝', not p5.resume_parts(layout, total + 1))
    two = [{'start': 0, 'end': total - 1}]
    check('分段数不同 → 拒绝', not p5.resume_parts(two, total))
    p4.discard()

    print('5. 两路并发同一个包：claim 必须给第二个另一个 key')
    k, owned1 = partials.claim('same-key')
    k2, owned2 = partials.claim('same-key')
    check('第一个独占', owned1 and k == 'same-key')
    check('第二个改名，且不需要释放', (not owned2) and k2 != 'same-key', k2)
    partials.release(k, owned1)
    k3, owned3 = partials.claim('same-key')
    check('释放后可再占用', owned3 and k3 == 'same-key')

    print('\n全部通过')


if __name__ == '__main__':
    main()
