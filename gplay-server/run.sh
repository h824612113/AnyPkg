#!/bin/zsh
# 启动 Google Play 旁路服务（供 server.js 调用）。
# 独立进程的原因：Play 的鉴权/设备指纹/APK 合并全是 Python 生态（gpapi + APKEditor），
# 在 Node 里重写一遍不划算。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 宿主环境可能注入 PYTHONPATH（IDE 的沙箱 shim 会拦截 mkdir 等系统调用，
# 让 TEMP_APK_DIR.mkdir(exist_ok=True) 直接抛 PermissionError）。清掉即可。
unset PYTHONPATH

# Play 在这台机器上直连不通，必须走本地代理。端口探测顺序和 lib/net.js 保持一致。
if [[ -z "$PROXY" ]]; then
  for p in 7897 7890 1087 8080 6152; do
    if nc -z -G 1 127.0.0.1 $p 2>/dev/null; then PROXY="http://127.0.0.1:$p"; break; fi
  done
fi
if [[ -n "$PROXY" ]]; then
  # 大小写都要设：requests/urllib 优先读小写 *_proxy，宿主环境里的小写变量
  # 指向一个连不通 Google 的内部代理，不覆盖就会 502。
  export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY"
  unset ALL_PROXY all_proxy 2>/dev/null || true
  # 回环地址绝不能走代理：server.js 转发下载时要连 127.0.0.1:5001
  export NO_PROXY="127.0.0.1,localhost,::1" no_proxy="127.0.0.1,localhost,::1"
  echo "[gplay] proxy = $PROXY"
else
  echo "[gplay] WARN: 未发现本地代理，Play 大概率连不通"
fi

# APKEditor 要 Java 17；签名要 apksigner（Android SDK build-tools 里，不在 PATH）
if [[ -d /opt/homebrew/opt/openjdk@17 ]]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17
elif [[ -d /usr/local/opt/openjdk@17 ]]; then
  export JAVA_HOME=/usr/local/opt/openjdk@17
fi
APKSIGNER_DIR="$(ls -d "$HOME"/Library/Android/sdk/build-tools/* 2>/dev/null | sort -V | tail -1)"
export PATH="${JAVA_HOME:+$JAVA_HOME/bin:}${APKSIGNER_DIR:+$APKSIGNER_DIR:}$DIR/.venv/bin:$PATH"

export PORT="${PORT:-5001}"
export HOST="${HOST:-127.0.0.1}"
# 关掉 SEO 详情页生成：会往磁盘写一堆 HTML，本机自用不需要
export DISABLE_APP_PAGES="${DISABLE_APP_PAGES:-1}"
# 下载断点放这里（partials.py）。刻意不放 /tmp：重启后还能接着下才是重点。
# 默认 6 小时过期、总量 3GB，用 GPLAY_PARTIAL_TTL / GPLAY_PARTIAL_MAX_MB 调。
export GPLAY_PARTIAL_DIR="${GPLAY_PARTIAL_DIR:-$HOME/.cache/gplay-partials}"

exec "$DIR/.venv/bin/python" server.py
