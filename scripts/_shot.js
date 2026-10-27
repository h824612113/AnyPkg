/**
 * 用 CDP 截图：等搜索结果真的渲染出来再拍。
 * headless 的 --screenshot 是 load 事件后立刻拍，而搜索要 20 秒，
 * --virtual-time-budget 又会被页面的队列轮询定时器卡住（虚拟时钟永远推进不完）。
 */
const fs = require('node:fs');

const PORT = Number(process.argv[2] || 9333);
const OUT = process.argv[3] || '/tmp/shot.png';
const NEED = Number(process.argv[4] || 4); // 至少要看到几张卡片
const MAX_MS = Number(process.argv[5] || 60000);

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:8787'));
  if (!page) throw new Error('没找到页面 target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result?.result?.value;
  };

  const t0 = Date.now();
  let cards = 0;
  while (Date.now() - t0 < MAX_MS) {
    cards = (await evalJs('document.querySelectorAll("article.card").length')) || 0;
    if (cards >= NEED) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // 卡片刚插进去时图标还在加载，等一拍让版式稳定
  await new Promise((r) => setTimeout(r, 1200));

  const heat = await evalJs(
    'Array.from(document.querySelectorAll("article.card")).slice(0,6).map(c=>c.querySelector(".card-name").textContent+" || "+Array.from(c.querySelectorAll(".badge")).map(b=>b.textContent.trim()).join(" / ")).join("\\n")'
  );
  console.log(`卡片 ${cards} 张，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(heat);

  // 只截结果区：整页截图有 3000px 高，缩下来什么都看不清
  // 第 6 个参数可以换成别的选择器（比如 #status 只看源状态栏）
  const sel = process.argv[6] || '#results';
  const box = await evalJs(
    `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({ x: 0, y: Math.max(0, r.top + scrollY - 16), w: innerWidth, h: Math.min(1500, r.height + 32) }); })()`
  );
  const clip = JSON.parse(box);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 },
  });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('已写入', OUT);
  ws.close();
}

main().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
