/**
 * 一次性排查：应用宝搜索页里 syzs_download_num 到底是什么量级的数。
 * 直接把 __NEXT_DATA__ 解析出来看结构，别在 HTML 上猜正则。
 */
const https = require('node:https');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

function objectAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'accept-language': 'zh-CN,zh;q=0.9', 'user-agent': UA } }, (res) => {
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (s += d));
        res.on('end', () => resolve(s));
      })
      .on('error', reject);
  });
}

(async () => {
  const html = await get(`https://sj.qq.com/search?q=${encodeURIComponent(process.argv[2] || '微信')}`);
  const data = objectAfter(html, '__NEXT_DATA__');
  const comps = data?.props?.pageProps?.dynamicCardResponse?.data?.components || [];
  for (const c of comps) {
    for (const it of c?.data?.itemData || []) {
      const keys = Object.keys(it).filter((k) => /num|count|down|install|total/i.test(k));
      const vals = {};
      for (const k of keys) vals[k] = it[k];
      if (it.name) console.log(it.name, '|', it.pkg_name || it.relevance_pkg_name, '|', JSON.stringify(vals));
    }
  }
})();
