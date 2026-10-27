'use strict';

const PLATFORM_LABEL = {
  ios: 'iOS',
  macos: 'macOS',
  android: 'Android',
  windows: 'Windows',
  linux: 'Linux',
  archive: '压缩包',
};

const FILTER_ORDER = ['all', 'direct', 'ios', 'android', 'windows', 'macos', 'linux'];

const FILTER_LABEL = {
  all: '全部',
  direct: '可直接下载',
  ios: 'iOS',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

const $ = (sel) => document.querySelector(sel);
const form = $('#search-form');
const input = $('#q');
const goBtn = $('#go');
const storeSel = $('#store');
const resultsEl = $('#results');
const statusEl = $('#statusbar');
const filtersEl = $('#filters');
const deeplinksEl = $('#deeplinks');
const linkgridEl = $('#linkgrid');
const footStat = $('#foot-stat');

const state = {
  q: '',
  filter: 'all',
  data: null,
  loading: false,
  backends: null,
  devices: [],
  device: null,
  browsers: [],
  queueOpen: false,
  queueJobs: [],
};

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 字节 → 「32.4 MB」。和 sizeText 的口径保持一致，别一边 1024 一边 1000 */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

/** 进度条下面那行字：已下 / 总量 · 速度 · 剩余。缺哪个就少显示哪个，不硬凑 */
function dlStatText(bytes, total, speed) {
  const parts = [total ? `${fmtBytes(bytes)} / ${fmtBytes(total)}` : `已下载 ${fmtBytes(bytes)}`];
  if (speed > 0) parts.push(`${fmtBytes(speed)}/s`);
  if (speed > 0 && total > bytes) {
    const left = Math.round((total - bytes) / speed);
    parts.push(left >= 90 ? `剩余约 ${Math.round(left / 60)} 分` : `剩余约 ${left} 秒`);
  }
  return parts.join(' · ');
}

function downloadIcon() {
  return '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 2v7m0 0 3-3m-3 3L5 6M3 13h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
}

function arrowIcon() {
  return '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M6 3h7v7M13 3 3 13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
}

function historyIcon() {
  return '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 4.5V8l2.5 1.5M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
}

function plusIcon() {
  return '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>';
}

function phoneIcon() {
  return '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="4.2" y="1.8" width="7.6" height="12.4" rx="1.8" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M7 12.2h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
}

function platformsOf(item) {
  return (item.platforms && item.platforms.length ? item.platforms : ['archive']);
}

/* ---------------- search ---------------- */

// App Store 区域：只影响 Apple 两栏（检索目录），存在本地，下次打开还在原来的区。
// 键名带 v2：默认值从「中国区」改成「全部区」了，老用户存着的 cn 会把新默认压住，
// 换键等于让所有人重新拿一次默认值。
const STORE_KEY = 'apd.store.v2';

function currentStore() {
  return (storeSel && storeSel.value) || 'all';
}

function initStore() {
  if (!storeSel) return;
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && [...storeSel.options].some((o) => o.value === saved)) storeSel.value = saved;
  } catch {
    /* 隐私模式下 localStorage 会抛，忽略 */
  }
  storeSel.addEventListener('change', () => {
    try {
      localStorage.setItem(STORE_KEY, storeSel.value);
    } catch {
      /* 同上 */
    }
    // 换区就是要看另一套结果，直接重搜比让用户再点一次搜索更顺手
    if (state.q && !state.loading) search(state.q, { fresh: true });
  });
}

async function search(q, { fresh = false } = {}) {
  if (!q || state.loading) return;
  state.q = q;
  state.filter = 'all';
  state.loading = true;
  input.value = q;
  goBtn.disabled = true;
  goBtn.textContent = '搜索中';

  const url = new URL(location.href);
  url.searchParams.set('q', q);
  history.replaceState(null, '', url);

  resultsEl.innerHTML = `<div class="skeleton">${'<div class="sk-card"></div>'.repeat(6)}</div>`;
  statusEl.hidden = true;
  filtersEl.hidden = true;

  try {
    const store = currentStore();
    const res = await fetch(
      `/api/search?q=${encodeURIComponent(q)}&store=${encodeURIComponent(store)}${fresh ? '&fresh=1' : ''}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.data = data;
    renderStatus(data);
    renderFilters(data);
    renderResults();
    renderDeepLinks(data);
    footStat.textContent = `${data.results.length} 个结果 · ${data.directCount} 个可直下 · ${data.tookMs}ms${data.cached ? ' · 缓存' : ''}`;
  } catch (e) {
    resultsEl.innerHTML = `<div class="empty"><h2>搜索失败</h2><p>${esc(e.message)}</p></div>`;
    footStat.textContent = '';
  } finally {
    state.loading = false;
    goBtn.disabled = false;
    goBtn.textContent = '搜索';
  }
}

/* ---------------- render: status ---------------- */

function renderStatus(data) {
  const failed = data.sources.filter((s) => !s.ok).length;
  const pills = data.sources
    .map((s) => {
      const cls = s.ok ? 'ok' : 'fail';
      const label = s.ok ? `${s.name} ${s.count}` : `${s.name} 不可用`;
      // 失败的源可以点一下重跑全量（fresh=1 绕开缓存），省得用户自己再搜一次
      const retry = s.ok ? '' : ` data-retry="${esc(s.name)}" title="点一下重试（${esc(s.error || '')}）"`;
      return `<span class="status-pill ${s.ok ? '' : 'fail'}${s.ok ? '' : ' retryable'}"${retry}>
        <span class="dot ${cls}"></span>${esc(label)}
        <span style="opacity:.5">${s.ms}ms</span>
      </span>`;
    })
    .join('');
  const hint = failed
    ? `<span class="status-summary status-retry" data-retry="${esc(data.query)}">${failed} 个源没连上 · 点这里重试</span>`
    : '';
  // 选了全部区就说清楚 Apple 那两栏是五个区的合并结果，免得以为「怎么多了这么多」
  const storeNote = data.store === 'all' ? ' · App Store 5 区' : '';
  statusEl.innerHTML = pills + `<span class="status-summary">${data.tookMs} ms · ${data.directCount} 可直下 · ${data.cached ? 'cache hit' : 'live'}${storeNote}</span>` + hint;
  statusEl.hidden = false;
}

/* ---------------- render: filters ---------------- */

function renderFilters(data) {
  const counts = { all: data.results.length, direct: data.results.filter((r) => r.direct).length };
  for (const r of data.results) {
    for (const p of platformsOf(r)) counts[p] = (counts[p] || 0) + 1;
  }

  const chips = FILTER_ORDER.filter((p) => p === 'all' || counts[p]).map((p) => {
    return `<button class="filter ${state.filter === p ? 'on' : ''}" data-filter="${p}">
      ${esc(FILTER_LABEL[p] || p)}<span class="n">${counts[p] || 0}</span>
    </button>`;
  });

  filtersEl.innerHTML = chips.join('');
  filtersEl.hidden = false;
}

/* ---------------- render: results ---------------- */

function renderResults() {
  const data = state.data;
  if (!data) return;

  const list = data.results.filter((r) => {
    if (state.filter === 'all') return true;
    if (state.filter === 'direct') return Boolean(r.direct);
    return platformsOf(r).includes(state.filter);
  });

  if (!list.length) {
    resultsEl.innerHTML = `<div class="empty">
      <div class="empty-icon">
        <svg viewBox="0 0 64 64" width="52" height="52"><circle cx="28" cy="28" r="17" stroke="currentColor" stroke-width="2.5" fill="none" opacity=".4"/><path d="m41 41 9 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity=".6"/></svg>
      </div>
      <h2>没有匹配的安装包</h2>
      <p>公开数据源里没找到「${esc(data.query)}」。换一个更短的关键词，或用英文名再试；下方「其他平台入口」可以直接跳到各商店搜索。</p>
    </div>`;
    return;
  }

  resultsEl.innerHTML = list.map(cardHtml).join('');

  resultsEl.querySelectorAll('img.icon').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        const div = document.createElement('div');
        div.className = 'icon blank';
        div.textContent = img.dataset.initial || '?';
        img.replaceWith(div);
      },
      { once: true }
    );
  });
}

function cardHtml(item) {
  const plats = platformsOf(item);
  const isGame = item.source === 'Steam';

  const badges = [
    ...plats.map((p) => `<span class="badge ${p}">${PLATFORM_LABEL[p] || p}</span>`),
    isGame ? '<span class="badge game">游戏</span>' : '',
    item.direct ? '' : '<span class="badge store">需跳转商店</span>',
    item.trust ? `<span class="badge trust">✓ ${esc(item.trust)}</span>` : '',
    item.price ? `<span class="badge price">${esc(item.price)}</span>` : '',
    // 热度放在评分前面：一眼看到「多少人用过」比「打几分」更能判断这是不是正主。
    // 各源给的指标不同（下载量 / 评分人数 / star），服务端已经折算成同一把尺子，
    // 这里只负责把原文单位写清楚，别让用户以为 star 数就是下载量
    item.heat?.text
      ? `<span class="badge heat" title="热度 ${item.heat.score}/100 · ${esc(item.heat.text)}${item.heat.from ? `（${esc(item.heat.from)}）` : ''}${item.support > 1 ? ` · ${item.support} 家商店同名收录` : ''}">${esc(item.heat.text)}</span>`
      : '',
    item.rating
      ? `<span class="badge soft">★ ${item.rating.score}${item.rating.count ? ` (${fmtCount(item.rating.count)})` : ''}</span>`
      : '',
    ...(item.tags || []).map((t) => `<span class="badge soft">${esc(t)}</span>`),
  ].join('');

  const initial = (item.name || '?').slice(0, 1).toUpperCase();
  const icon = item.icon
    ? `<img class="icon" src="${esc(item.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-initial="${esc(initial)}">`
    : `<div class="icon blank">${esc(initial)}</div>`;

  const downloads = orderedDownloads(item)
    .map((d, i) => {
      const isPlay = d.kind === 'play';
      const primary = i === 0 && (d.kind === 'direct' || isPlay);
      const label = d.kind === 'direct' || isPlay ? d.short || shortName(d.label) : d.label;
      const size = d.size ? `<span class="dl-size">${esc(d.size)}</span>` : '';

      // Play 原包不是一条现成 URL：服务端要先下 base+splits、合并、重签名，
      // 所以走按钮 + SSE 进度，而不是 <a href>。
      if (isPlay) {
        return `<button class="dl play ${primary ? 'primary' : ''}" type="button"
          data-play="${esc(item.packageId || '')}" data-name="${esc(d.filename || '')}"
          data-title="${esc(item.name || '')}"
          title="${esc(d.label)}">
          ${downloadIcon()}<span class="dl-label">${esc(label)}</span>${size}
        </button>`;
      }

      const href = d.kind === 'direct'
        ? `/api/download?u=${encodeURIComponent(d.url)}&n=${encodeURIComponent(d.filename || d.label)}`
        : d.url;
      const target = d.kind === 'direct' ? '' : ' target="_blank" rel="noopener noreferrer"';

      const link = `<a class="dl ${primary ? 'primary' : ''}" href="${esc(href)}"${target}
        title="${esc(d.label)}${d.size ? ' · ' + d.size : ''}">
        ${d.kind === 'direct' ? downloadIcon() : arrowIcon()}
        <span class="dl-label">${esc(label)}</span>${size}
      </a>`;

      if (d.kind !== 'direct' || !d.url) return link;

      // 浏览器下载只给你一个文件；这里多给一个「进队列」的入口：
      // 队列能看进度、能批量、下完还能直接推到连着的手机上。
      const dev = deviceFor(d.platform);
      const tip = dev
        ? `下载后直接装到 ${dev.name}`
        : '加入下载队列（本机保存 · 可批量 · 下完可装到手机）';
      return `<span class="dlgroup">${link}<button class="qadd ${dev ? 'to-device' : ''}" type="button"
        data-q-url="${esc(d.url)}" data-q-name="${esc(d.filename || d.label)}"
        data-q-title="${esc(item.name || '')}"
        data-q-plat="${esc(d.platform || '')}" title="${esc(tip)}" aria-label="${esc(tip)}">
        ${dev ? phoneIcon() : plusIcon()}</button></span>`;
    })
    .join('');

  const local = localButtons(item).join('');

  // Android 包名是跨源唯一的，所以哪怕这张卡来自应用宝，也能拿同一个包名去
  // Aptoide 的索引里翻历史版本——降级需求就靠这条。
  const versions = plats.includes('android') && item.packageId
    ? `<button class="dl versions" type="button" data-versions="${esc(item.packageId)}"
        data-name="${esc(item.name)}" title="从 Aptoide 索引里翻这个包名的历史版本">${historyIcon()}<span class="dl-label">历史版本</span></button>`
    : '';

  const meta = (item.meta || []).filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('');

  return `<article class="card">
    <div class="card-top">
      ${icon}
      <div class="card-head">
        <h3 class="card-name" title="${esc(item.name)}">${esc(item.name)}</h3>
        <div class="card-pub">${esc(item.publisher || '')}</div>
        <div class="badges">${badges}</div>
      </div>
    </div>
    ${item.summary ? `<p class="summary">${esc(item.summary)}</p>` : ''}
    ${meta ? `<div class="meta">${meta}</div>` : ''}
    <div class="downloads">${local}${downloads}${versions}</div>
    <div class="card-src">
      <span>${esc((item.sources && item.sources.length > 1 ? item.sources : [item.source]).join(' + '))}</span>
      ${item.sourceUrl ? `<a href="${esc(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">详情 ↗</a>` : '<span></span>'}
    </div>
  </article>`;
}

function shortName(name) {
  return String(name).length > 34 ? String(name).slice(0, 32) + '…' : String(name);
}

/** 有平台过滤时，把该平台的安装包排到最前面（同组内保持原顺序） */
function orderedDownloads(item) {
  const ds = item.downloads || [];
  if (state.filter === 'all') return ds;
  return ds
    .map((d, i) => ({ d, i, hit: d.platform === state.filter ? 1 : 0 }))
    .sort((a, b) => b.hit - a.hit || a.i - b.i)
    .map((x) => x.d);
}

/** 本机 CLI 后端：用用户自己的账号从商店取包 */
function localButtons(item) {
  const be = state.backends?.tools;
  if (!be) return [];
  const plats = platformsOf(item);
  const out = [];

  // iOS / Mac App Store 的包只能靠本机 ipatool 用自己的 Apple ID 取，
  // 所以按钮走 /api/apple/download（可选设备、选版本、有进度），不是普通 <a>
  const applePlat = plats.includes('ios') ? 'iphone' : plats.includes('macos') ? 'macos' : '';
  if (applePlat && item.bundleId && be.ipatool?.available) {
    const ext = applePlat === 'macos' ? 'PKG' : 'IPA';
    const authed = Boolean(be.ipatool.authed);
    const tip = authed
      ? `用 ${be.ipatool.email || '你的 Apple ID'} 从 App Store 取 .${ext.toLowerCase()}`
      : '点这里用你自己的 Apple ID 登录一次，凭证只留在本机';
    out.push(`<button class="dl local ${authed ? 'primary' : 'ghost'}" data-apple="${esc(item.bundleId)}"
      data-plat="${applePlat}" data-name="${esc(item.name)}" data-stores="${esc((item.stores || []).join(','))}"
      title="${esc(tip)}">
      ${downloadIcon()}<span class="dl-label">${authed ? `下载 ${ext}` : `${ext} 需登录`}</span></button>`);
  }

  // apkeep 的 F-Droid 通道只对「真的在 F-Droid 上」的包有效。
  // 以前它对每张 Android 卡片都出现，点「微信」也会给一个必然失败的按钮。
  const fromFdroid = item.source === 'F-Droid' || (item.sources || []).includes('F-Droid');
  if (plats.includes('android') && item.packageId && be.apkeep?.available && fromFdroid) {
    const src = be.apkeep.sourceLabel || 'F-Droid';
    out.push(`<button class="dl local" data-local="apkeep" data-id="${esc(item.packageId)}"
      title="用 apkeep 从 ${esc(src)} 下载 APK">
      ${downloadIcon()}<span class="dl-label">${esc(src)} 直下</span></button>`);
  }

  return out;
}

function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'show';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.className = '';
  }, 5600);
}

function fmtCount(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/* ---------------- Android 历史版本 ---------------- */

function versionRow(pkg, v) {
  // 下载链接指向服务端解析：Aptoide 的列表接口不给地址，要按 vercode 现查
  const href = `/api/android/download?pkg=${encodeURIComponent(pkg)}&vercode=${v.vercode}`;
  const name = v.version || String(v.vercode);
  return `<div class="vrow">
    <span class="vname">${esc(name)}</span>
    <span class="vdate">${esc(v.date || '')}</span>
    <span class="vsize">${esc(v.size || '')}</span>
    <a class="vget" href="${href}" title="${esc(v.md5 ? `MD5 ${v.md5}` : name)}">下载</a>
  </div>`;
}

async function showAndroidVersions(pkg, name) {
  openModal(
    `历史版本 · ${name || pkg}`,
    `<p class="modal-note">列表来自 Aptoide 的公共索引：只有它收录过的版本才在里面，国内应用常常只有当前版本。
     每行右侧的「下载」会按版本号现取直链，文件名带版本，MD5 悬停可见。</p>
     <div class="vlist" id="vlist"><div class="vempty">读取中…</div></div>
     <div class="log" id="vlog"></div>`
  );

  const list = $('#vlist');
  const log = $('#vlog');
  let n = 0;

  try {
    await readSse(`/api/android/versions?pkg=${encodeURIComponent(pkg)}`, {}, (evt) => {
      if (evt.type === 'version') {
        if (!n) list.innerHTML = '';
        list.insertAdjacentHTML('beforeend', versionRow(pkg, evt));
        n += 1;
      } else if (evt.type === 'error') {
        logTo(log, evt.message || '拿不到版本列表', 'err');
      }
    });
  } catch (err) {
    logTo(log, String(err.message || err), 'err');
  }

  if (!n) list.innerHTML = '<div class="vempty">这个包名在 Aptoide 上没有历史版本记录。</div>';
}

/* ---------------- render: deep links ---------------- */

function renderDeepLinks(data) {
  if (!data.deepLinks || !data.deepLinks.length) {
    deeplinksEl.hidden = true;
    return;
  }
  linkgridEl.innerHTML = data.deepLinks
    .map(
      (l) => `<a class="deeplink" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">
        <span class="badge ${l.platform}">${PLATFORM_LABEL[l.platform] || '其他'}</span>
        <span>
          <div class="dl-name">${esc(l.label)}</div>
          <div class="dl-note">${esc(l.note || '')}</div>
        </span>
        <span class="dl-arrow">${arrowIcon()}</span>
      </a>`
    )
    .join('');
  deeplinksEl.hidden = false;
}

/* ---------------- render: 本地工具 ---------------- */

function renderTools(be) {
  const el = $('#tools');
  const list = $('#toollist');
  if (!el || !list) return;

  // gplaydl 已经被顶部的 Google Play 通道取代：都是取 Play 原包，
  // 但新的那条不用手机配对、还能自动合并分包，留着只会让人不知道该点哪个
  const rows = Object.values(be.tools || {})
    .filter((t) => t.key !== 'gplaydl')
    .map((t) => {
    let status = '已安装';
    let cls = 'ok';
    if (!t.available) {
      status = '未安装';
      cls = 'off';
    } else if (t.key === 'ipatool' && !t.authed) {
      status = '已安装 · 未登录';
      cls = 'warn';
    } else if (t.key === 'ipatool') {
      status = `已登录${t.email ? ' ' + t.email : ''}`;
    }

    let cmd = '';
    if (!t.available) cmd = t.install;
    // ipatool 的登录在页面顶部那条状态条里，不在终端，所以不给命令行提示

    return `<div class="tool">
      <span class="dot ${cls}"></span>
      <div class="tool-main">
        <div class="tool-name">${esc(t.label)}<span class="tool-tag">${esc((t.platforms || []).join(' / '))}</span></div>
        <div class="tool-note">${esc(t.note || '')}</div>
      </div>
      <div class="tool-status">
        <span class="${cls === 'on' || cls === 'ok' ? 'ok-text' : ''}">${esc(status)}</span>
        ${cmd ? `<code>${esc(cmd)}</code>` : ''}
      </div>
    </div>`;
  });

  list.innerHTML = rows.join('');
  el.hidden = false;
}

/* ---------------- events ---------------- */

form.addEventListener('submit', (e) => {
  e.preventDefault();
  search(input.value.trim());
});

document.querySelectorAll('.chip-mini').forEach((btn) => {
  btn.addEventListener('click', () => search(btn.dataset.q));
});

// ?q=微信 直接开搜：分享一个搜索链接、或者刷新后想停在原结果上都用得上。
// 放在事件绑定之后，这样 search() 里用到的状态都已经初始化好了
const bootQuery = new URLSearchParams(location.search).get('q');
if (bootQuery) {
  input.value = bootQuery;
  search(bootQuery.trim());
}

// 「某几个源没连上」时点一下就地重跑。fresh=1 是为了绕过那份（很可能也是坏的）短缓存
statusEl.addEventListener('click', (e) => {
  if (!e.target.closest('[data-retry]') || state.loading) return;
  search(state.q, { fresh: true });
});

filtersEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  renderFilters(state.data);
  renderResults();
});

resultsEl.addEventListener('click', async (e) => {
  const qbtn = e.target.closest('[data-q-url]');
  if (qbtn) {
    e.preventDefault();
    addToQueue({
      u: qbtn.dataset.qUrl,
      n: qbtn.dataset.qName,
      t: qbtn.dataset.qTitle,
      platform: qbtn.dataset.qPlat,
    });
    return;
  }

  const playBtn = e.target.closest('[data-play]');
  if (playBtn) {
    e.preventDefault();
    playDownload(playBtn.dataset.play, playBtn.dataset.name, playBtn.dataset.title);
    return;
  }

  const verBtn = e.target.closest('[data-versions]');
  if (verBtn) {
    e.preventDefault();
    showAndroidVersions(verBtn.dataset.versions, verBtn.dataset.name);
    return;
  }

  const appleBtn = e.target.closest('[data-apple]');
  if (appleBtn) {
    e.preventDefault();
    const req = {
      bundle: appleBtn.dataset.apple,
      plat: appleBtn.dataset.plat || 'iphone',
      name: appleBtn.dataset.name || '',
      // 全部区搜出来的包可能是「只在美区上架」的，弹窗里要能把这句话说出来
      stores: (appleBtn.dataset.stores || '').split(',').filter(Boolean),
    };
    if (!appleState.authed) {
      // 登完自动接着下，不用让用户回来再点一次
      applePending = req;
      showAppleLogin();
    } else {
      openAppleDownload(req);
    }
    return;
  }

  const btn = e.target.closest('[data-local]');
  if (!btn || btn.disabled) return;
  e.preventDefault();

  const labelEl = btn.querySelector('.dl-label');
  const original = labelEl.textContent;
  btn.disabled = true;
  btn.classList.add('busy');
  labelEl.textContent = '下载中…';

  try {
    const res = await fetch('/api/local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: btn.dataset.local, id: btn.dataset.id }),
    });
    const j = await res.json();
    if (j.ok && j.files && j.files.length) {
      labelEl.textContent = `已保存 ${j.files[0].sizeText}`;
      location.href = `/api/file?name=${encodeURIComponent(j.files[0].name)}`;
      setTimeout(() => {
        labelEl.textContent = original;
      }, 4000);
    } else {
      labelEl.textContent = original;
      toast(j.message || j.log || '下载失败');
    }
  } catch (err) {
    labelEl.textContent = original;
    toast(String(err.message || err));
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input) {
    e.preventDefault();
    input.focus();
    input.select();
  }
});

/* ---------------- Google Play 账号与下载 ---------------- */

const playbarEl = $('#playbar');
const playbarText = $('#playbar-text');
const playbarBtn = $('#playbar-btn');
const playbarDirect = $('#playbar-direct');
const applebarEl = $('#applebar');
const applebarText = $('#applebar-text');
const applebarBtn = $('#applebar-btn');
const applebarAccts = $('#applebar-accts');
const modalEl = $('#modal');
const modalTitle = $('#modal-title');
const modalBody = $('#modal-body');

let playState = { up: false, authenticated: false, email: '' };

// Apple 的凭证只在这一个变量里过一遍：登录成功后立刻清空，
// 页面刷新就没了。真正长期保存的是 ipatool 写进本机 keychain 的那份。
let appleState = { available: false, authed: false, email: '' };
let appleCred = null;
let applePending = null;

// 每次开弹窗都换一个号：允许同时下多个之后，前一个下载收尾时不能把
// 用户正在看的另一个弹窗关掉
let modalSeq = 0;

function openModal(title, html) {
  modalSeq += 1;
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalEl.hidden = false;
  return modalSeq;
}

function closeModal(seq) {
  // 只有显式传了号才做「是不是同一个弹窗」的判断；
  // 关闭按钮、点遮罩、Esc 都不传，照旧直接关
  if (typeof seq === 'number' && seq !== modalSeq) return;
  modalEl.hidden = true;
  modalBody.innerHTML = '';
}

/**
 * 「后台下载」这一行。
 *
 * 下载其实一直在服务端跑，关掉弹窗并不会中断；但界面没告诉用户，
 * 他只会以为一关就没了。所以给一个明确出口：点了就收起弹窗、展开队列，
 * 那里那条任务的百分比正在动——比一句「请勿关闭窗口」有用得多。
 */
function bgRowHtml() {
  // 默认藏着：还没点「开始下载」时它没有意义，点了只会关掉窗口，反而像在骗人。
  // 真正发起请求后再由 showBg() 露出来
  return `<div class="dl-bg" id="dl-bg" hidden>
    <button class="btn-ghost btn-sm" type="button" data-bg="1">后台下载</button>
    <span class="dl-bg-tip">关掉去搜别的就行，进度在右下角「下载队列」里继续</span>
  </div>`;
}

function showBg(el) {
  if (el) el.hidden = false;
}

/** SSE 读取：登录和下载都是长任务，只能靠流式事件回显进度 */
async function readSse(url, { method = 'GET', body } = {}, onEvent) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let data = null;
    try {
      data = await res.json();
      msg = data.error || msg;
    } catch {
      /* 上游不一定是 JSON */
    }
    const err = new Error(msg);
    // 412 的 needsPassword 要靠 data 传出去，不能只剩一句错误文本
    err.data = data;
    err.status = res.status;
    throw err;
  }
  if (!res.body) throw new Error('这个浏览器不支持流式响应');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      onEvent(evt);
    }
  }
}

function logTo(el, text, cls) {
  if (!el || !text) return;
  // 连续同一句只留一条：后端已经去重了，但多个源/多轮重试仍可能撞车，
  // 一屏「正在协商包体」看着像卡死
  const last = el.lastElementChild;
  if (last && last.textContent === text && last.className === (cls || '')) return;
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

async function refreshPlay() {
  let st;
  try {
    const res = await fetch('/api/play/status');
    st = await res.json();
  } catch {
    st = { up: false };
  }
  playState = st;
  playbarEl.hidden = false;
  playbarEl.classList.remove('on', 'off', 'down');

  if (!st.up) {
    playbarEl.classList.add('down');
    playbarText.innerHTML = '<b>Google Play</b> 旁路没起来';
    playbarBtn.textContent = '启动';
    playbarBtn.dataset.act = 'start';
    playbarBtn.classList.remove('ghostbtn');
    return;
  }
  if (st.authenticated) {
    playbarEl.classList.add('on');
    playbarText.innerHTML = `<b>Google Play</b> ${esc(st.email || '已登录')}`;
    playbarBtn.textContent = '退出';
    playbarBtn.dataset.act = 'logout';
    playbarBtn.classList.add('ghostbtn');
    return;
  }
  playbarEl.classList.add('off');
  playbarText.innerHTML = '<b>Google Play</b> 未登录，登录后能下 Play 原包';
  playbarBtn.textContent = '连接账号';
  playbarBtn.dataset.act = 'login';
  playbarBtn.classList.remove('ghostbtn');
}

function showLogin() {
  openModal('连接 Google 账号', `
    <p>用你自己的 Google 账号从 Play 取原包。凭证只落在本机 <code>gplay-server/</code>，不会上传到任何地方。</p>
    <div id="pb-box"></div>
    <div class="tabs">
      <button class="tab on" data-tab="browser" type="button">浏览器登录</button>
      <button class="tab" data-tab="manual" type="button">手动填 Token</button>
    </div>
    <div id="tab-browser">
      <p>只有密码登录被 Google 拦下时（新设备/异地登录）才需要走这里：会弹出一个独立的
      Chrome 窗口，在里面完成验证后自动抓取凭证。</p>
      <div class="btn-row"><button class="btn-main" id="btn-browser" type="button">打开浏览器登录</button></div>
    </div>
    <div id="tab-manual" hidden>
      <p>在<b>无痕窗口</b>打开 <code>accounts.google.com/EmbeddedSetup</code> 登录，再从 DevTools 的
      Application → Cookies 里复制 <code>oauth_token</code>（<code>oauth2_4/</code> 开头，只有几分钟有效期）。</p>
      <div class="field"><label>Google 邮箱</label>
        <input id="in-email" type="email" placeholder="you@gmail.com" autocomplete="off"></div>
      <div class="field"><label>oauth_token</label>
        <input id="in-oauth" type="text" placeholder="oauth2_4/..." autocomplete="off"></div>
      <div class="btn-row"><button class="btn-main" id="btn-manual" type="button">提交</button></div>
    </div>
    <div class="log" id="login-log"></div>
  `);
  loadBrowserAccounts();
}

/**
 * 开窗之前先看看本机浏览器里已经登录了哪些 Google 账号。
 * 只读 Local State 和 Cookie 库的过期时间，不碰密码、不触发钥匙串授权。
 */
async function loadBrowserAccounts() {
  const box = $('#pb-box');
  if (!box) return;
  box.innerHTML = '<p class="muted kc-hint">正在看本机浏览器里登录了哪些 Google 账号…</p>';
  try {
    const r = await fetch('/api/play/browsers');
    const j = await r.json();
    const browsers = (j.browsers || []).filter((b) => (b.profiles || []).length);
    state.browsers = browsers;
    if (!browsers.length) {
      box.innerHTML = '';
      return;
    }
    const rows = [];
    for (const b of browsers) {
      for (const p of b.profiles) {
        const tag = [b.name, p.name, p.signedIn ? '' : '会话已失效'].filter(Boolean).join(' · ');
        rows.push(`<div class="kc-item">
          <div class="kc-main">
            <div class="kc-mail">${esc(p.email)}</div>
            <div class="kc-tag">${esc(tag)}</div>
          </div>
          <button class="qact" data-pbemail="${esc(p.email)}">用这个账号</button>
        </div>`);
      }
    }
    box.innerHTML = `<div class="kc-tag" style="margin-bottom:6px">本机浏览器已登录的账号</div>
      <div class="kc-list">${rows.join('')}</div>
      <p class="muted kc-hint">点一个直接用：密码从浏览器密码库（或钥匙串）里取，<b>不会</b>再开一个空窗口让你重新登录。
      本机没存密码的账号会就地让你输一次。</p>`;
  } catch (e) {
    box.innerHTML = `<p class="muted kc-hint">查本机浏览器失败：${esc(String(e.message || e))}</p>`;
  }
}

/**
 * 用本机浏览器里已登录的账号登录。
 *
 * 以前这里是「开一个登录窗、把邮箱预填进去」，但那个窗口是独立 profile，
 * 里面的账号全都没有，用户还是得从头输一遍密码——体验上等于没复用。
 * 现在优先用浏览器密码库/钥匙串里的密码直接换 token，窗口根本不用出现。
 */
function loginWithAccount(email) {
  const log = $('#login-log');
  // 已经连着这个号就别再走一遍：oauth_token 是一次性的，重复提交只会拿到
  // BadAuthentication，看着像「登录失败」，其实早就登进去了
  if (playState.authenticated && playState.email === email) {
    if (log) logTo(log, `${email} 已经连着了，可以直接下原包。`, 'ok');
    setTimeout(closeModal, 1200);
    return;
  }
  if (log) {
    log.innerHTML = '';
    logTo(log, `用 ${email} 登录（先找本机存的密码）…`, 'dim');
  }
  $('#pb-pwdbar')?.remove();
  runLogin({ email, preferPassword: true, browser: 'chrome' });
}

/**
 * 本机没有密码时的两条路。
 *
 * 为什么「没有密码」是常态：Chrome 不会把 Google 账号密码存进 Login Data
 * （浏览器自身的登录不算网页表单），而 iCloud 钥匙串里的那条 security 命令
 * 没有 entitlement 读不到。所以这里只能给替代方案，不能假装能填。
 *
 * 替代方案优先「借会话」：用户已经在 Chrome 里登录着，让浏览器自己去领一张
 * 一次性 oauth_token，全程不用输密码；失败再退回手输。
 */
function askAccountPassword(email, message) {
  const box = $('#pb-box');
  const log = $('#login-log');
  if (log && message) logTo(log, message, 'err');
  if (!box || $('#pb-pwdbar')) return;
  box.insertAdjacentHTML(
    'afterbegin',
    `<div class="kc-quit" id="pb-pwdbar" data-email="${esc(email)}">
      <div class="kc-tip"><b>不用输密码的路</b>：你已经在 Chrome 里登录了这个账号，
      让浏览器自己去授权一次就行（在打开的页面里点「继续」，授权页不会问密码）。</div>
      <button class="qact" id="pb-session-go" type="button">借 Chrome 的登录状态（推荐）</button>
      <div class="kc-tip">要是授权页还是让你输密码，那就在这儿输一次；输对了会存进钥匙串，下次不用再输。</div>
      <input id="pb-pwd" type="password" autocomplete="current-password" placeholder="Google 密码">
      <button class="qact" id="pb-pwd-go">登录</button>
    </div>`
  );
  $('#pb-pwd')?.focus();
  $('#pb-pwd')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#pb-pwd-go')?.click();
  });
}

/** 借已登录的 Chrome 领票据：页面由用户自己打开，服务端只负责读 cookie 换 token */
async function runSessionLogin(email) {
  const log = $('#login-log');
  const go = $('#pb-session-go');
  if (go) {
    go.disabled = true;
    go.textContent = '等待浏览器授权…';
  }
  // 必须由用户点开：服务端在沙箱里调 open 会被静默拦掉，窗口根本不会出现。
  // 不能带 noopener——那样 window.open 恒返回 null，下面的「被拦了」会误报。
  const win = window.open('https://accounts.google.com/EmbeddedSetup', '_blank');
  logTo(
    log,
    '已在新标签页打开授权页。用你登录着 Google 的那个 Chrome 走完它（选一下账号、点「继续」），不用输密码。',
    'dim'
  );
  if (!win) logTo(log, '（弹窗被拦了：自己打开 accounts.google.com/EmbeddedSetup，效果一样）', 'dim');

  let ok = false;
  try {
    await readSse(`/api/play/session?email=${encodeURIComponent(email)}`, {}, (evt) => {
      if (evt.type === 'progress') logTo(log, evt.message);
      else if (evt.type === 'success') {
        ok = true;
        logTo(log, `登录成功：${evt.email || email}${evt.validated ? '（已校验）' : ''}`, 'ok');
        // 这一刻用户多半盯着浏览器那个标签页，弹窗压在后面看不见变化。
        // 所以把弹窗内容整个换成结果，别让他以为又卡住了。
        if (modalBody) {
          modalBody.innerHTML = `<div class="login-done">
            <div class="login-done-ico">✓</div>
            <div class="login-done-main">已连接 ${esc(evt.email || email)}</div>
            <div class="login-done-sub">${
              evt.validated ? 'token 已对着 Play 接口验证过，可以直接下原包了' : 'token 已保存，下次开页面就是登录状态'
            }</div>
          </div>`;
        }
      } else if (evt.type === 'error') {
        logTo(log, evt.message || '借会话登录失败', 'err');
        if (go) {
          go.disabled = false;
          go.textContent = '重试一次';
        }
      }
    });
  } catch (err) {
    logTo(log, String(err.message || err), 'err');
  }

  if (go && !ok) {
    go.disabled = false;
    go.textContent = '借 Chrome 的登录状态（推荐）';
  }
  await refreshPlay();
  if (state.data) renderResults();
  // 给结果页留够看的时间：用户刚从浏览器标签页切回来
  if (ok) setTimeout(closeModal, 2400);
}

async function runLogin(body) {
  const log = $('#login-log');
  const btns = modalBody.querySelectorAll('button');
  log.innerHTML = '';
  btns.forEach((b) => {
    b.disabled = true;
  });
  logTo(log, '开始…', 'dim');

  let ok = false;
  try {
    await readSse('/api/play/login', { method: 'POST', body }, (evt) => {
      if (evt.type === 'progress') logTo(log, evt.message);
      else if (evt.type === 'success') {
        ok = true;
        logTo(log, `登录成功：${evt.email || ''}${evt.validated ? '（已校验）' : ''}`, 'ok');
        // 手输的那次存进钥匙串，下次点账号就不用再输（取的时候仍会弹系统授权）
        if (body.savePassword && body.password && body.email) {
          fetch('/api/play/save-password', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: body.email, password: body.password }),
          })
            .then((r) => r.json())
            .then((j) => {
              if (j.ok) logTo(log, '密码已存进钥匙串，下次点账号直接登录', 'dim');
            })
            .catch(() => {});
        }
      } else if (evt.type === 'error') logTo(log, evt.message || '登录失败', 'err');
    });
  } catch (err) {
    // 412：本机没存这个账号的密码，就地让他输一次，别退回去开浏览器
    if (err.data && err.data.needsPassword) {
      askAccountPassword(err.data.email || '', String(err.message || ''));
      return;
    }
    logTo(log, String(err.message || err), 'err');
  } finally {
    btns.forEach((b) => {
      b.disabled = false;
    });
  }

  await refreshPlay();
  if (state.data) renderResults();
  if (ok) setTimeout(closeModal, 1400);
}

async function playDownload(pkg, filename, title = '') {
  if (!pkg) return;
  if (!playState.authenticated) {
    showLogin();
    return;
  }

  openModal('从 Google Play 下载', `
    <p>正在取 <code>${esc(title ? `${title}（${pkg}）` : pkg)}</code> 的原包。base + 分包通常几十兆，合并和重签名还要一会儿，第一次会慢一些。</p>
    ${bgRowHtml()}
    <div class="bar work"><i id="dl-bar"></i></div>
    <div class="dl-stat" id="pl-stat">准备中…</div>
    <div class="log" id="dl-log"></div>
  `);
  const myModal = modalSeq;
  const log = $('#dl-log');
  const bar = $('#dl-bar');
  const stat = $('#pl-stat');
  const myBg = $('#dl-bg');

  // 服务端一挂上队列就让它出现在面板里，别等成功才显示
  setTimeout(pollQueue, 400);
  setTimeout(pollQueue, 1500);

  let fileId = '';
  let finalName = filename || `${pkg}.apk`;

  // 整个流程切成几段，每段一个百分比区间：
  // 合并/签名拿不到细粒度进度，只能整段跳；下载主包有字节数，能在区间内平滑走。
  // 再挂个计时器，让黑盒步骤看起来还在动，而不是卡死。
  const PL_RANGE = {
    auth: [0, 4, '取授权'],
    merge: [58, 88, '合并分包'],
    sign: [88, 99, '重新签名'],
  };
  const t0 = Date.now();
  let label = '准备中';
  let lastPct = 0;
  let dlNow = 0;
  let dlTotal = 0;

  const paint = () => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    const mm = Math.floor(sec / 60);
    const dur = mm ? `${mm} 分 ${sec % 60} 秒` : `${sec} 秒`;
    const bytesPart = dlTotal ? ` · ${fmtBytes(dlNow)} / ${fmtBytes(dlTotal)}` : '';
    if (stat) stat.textContent = `${label}${bytesPart} · 已用 ${dur}`;
  };
  const tick = setInterval(paint, 500);

  // 只往前推，不倒退：缓存命中时会直接跳到 merge，条子回跳比不精确更糟
  const advance = (pct, name) => {
    if (name) label = name;
    lastPct = Math.max(lastPct, pct);
    bar.style.width = `${lastPct}%`;
    paint();
  };

  const setStep = (evt) => {
    let range;
    if (evt.step === 'download') {
      // current=1 是主包，2 是全部拆分包
      range = Number(evt.current) <= 1 ? [4, 24, '下载主包'] : [24, 58, '下载分包'];
      dlNow = Number(evt.bytes) || 0;
      dlTotal = Number(evt.bytesTotal) || 0;
    } else {
      range = PL_RANGE[evt.step];
      dlNow = dlTotal = 0;
    }
    if (!range) return;
    const [from, to, name] = range;
    // 有字节数就在区间内按比例走，没有就停在区间起点
    const frac = dlTotal > 0 ? Math.min(1, dlNow / dlTotal) : 0;
    advance(from + frac * (to - from), name);
  };

  const stopTick = () => clearInterval(tick);

  showBg(myBg);
  try {
    await readSse(`/api/play/prepare?pkg=${encodeURIComponent(pkg)}${title ? `&name=${encodeURIComponent(title)}` : ''}`, {}, (evt) => {
      if (evt.type === 'progress') {
        // 带字节数的进度每 0.6 秒一条，全打进日志会把有用的步骤行冲掉，
        // 这类只更新条子和状态行
        if (!evt.bytes) logTo(log, evt.message);
        if (evt.step) setStep(evt);
      } else if (evt.type === 'success') {
        fileId = evt.download_id || '';
        finalName = evt.filename || finalName;
        stopTick();
        bar.classList.remove('work');
        bar.style.width = '100%';
        if (stat) stat.textContent = `完成 · 已用 ${Math.round((Date.now() - t0) / 1000)} 秒`;
        logTo(log, `准备完成：${finalName}`, 'ok');
      } else if (evt.type === 'error') {
        stopTick();
        bar.classList.remove('work');
        bar.classList.add('err');
        if (stat) {
          stat.classList.add('bad');
          stat.textContent = `失败 · ${evt.message || '未知错误'}`;
        }
        logTo(log, evt.message || '下载失败', 'err');
        // 这两个是「应用层」失败：token 没问题，只是这个包在当前商店区拿不到。
        // 用户下一步该做的是换来源，不是反复重试，所以直接把话说清楚。
        if (evt.code === 'not_found' || evt.code === 'no_delivery') {
          logTo(log, '同一张卡片上通常还有 APKPure / 应用宝 的直链，回列表点那个就行。', 'dim');
          offerApkpureFallback(pkg, title, myModal);
        }
      }
    });
  } catch (err) {
    stopTick();
    bar.classList.remove('work');
    bar.classList.add('err');
    if (stat) {
      stat.classList.add('bad');
      stat.textContent = `失败 · ${err.message || err}`;
    }
    logTo(log, String(err.message || err), 'err');
    return;
  }
  stopTick();

  if (!fileId) {
    logTo(log, '没有拿到文件，请重试', 'err');
    return;
  }
  // 后端在 success 之后会把合并包从临时目录落到 .downloads 并入队，
  // 所以这里不弹浏览器下载，等它拷完直接看列表
  logTo(log, '合并包正在存到本机，几秒后会出现在下载队列里…', 'dim');
  setTimeout(pollQueue, 800);
  setTimeout(() => {
    pollQueue();
    openQueue(true);
  }, 2600);
  setTimeout(closeModal, 2400, myModal);
}

/**
 * Play 拿不到包时的兜底：拿同一个包名去 APKPure 要一条直链。
 *
 * 为什么不只提示「回卡片点别的」：从「直下 APK」进来的根本没有卡片，
 * 而从卡片进来的用户也得重新找一遍——两秒钟能自动找到的东西，别让人手动做。
 * 拿到的是 APKPure 的原始包（多数是 XAPK，带签名），和 Play 合并包不是一回事，
 * 所以文案里写清来源，让他自己判断。
 */
async function offerApkpureFallback(pkg, title, modalId) {
  if (!pkg || modalSeq !== modalId) return;
  let d = null;
  try {
    const r = await fetch(`/api/apkpure?pkg=${encodeURIComponent(pkg)}`);
    if (!r.ok) return;
    d = await r.json();
  } catch {
    return;
  }
  // 期间用户可能已经关掉弹窗/换了内容，别往别的面板里塞按钮
  if (!d || !d.url || modalSeq !== modalId) return;
  const body = $('#modal-body');
  if (!body || $('#pl-alt')) return;

  const meta = [d.version ? `v${d.version}` : '', d.size ? fmtBytes(d.size) : '', d.type || '']
    .filter(Boolean)
    .map(esc)
    .join(' · ');
  const row = document.createElement('div');
  row.className = 'btn-row';
  row.style.marginTop = '12px';
  row.innerHTML = `<button class="btn-main" id="pl-alt" type="button">改用 APKPure 下载</button>
    <span class="muted" style="font-size:12px;align-self:center">${meta}</span>`;
  body.appendChild(row);

  $('#pl-alt').addEventListener('click', async () => {
    const btn = $('#pl-alt');
    btn.disabled = true;
    btn.textContent = '加入队列…';
    const ext = String(d.type || 'apk').toLowerCase();
    await addToQueue({
      u: d.url,
      n: `${pkg}-${d.version || 'latest'}.${ext}`,
      t: title || '',
      platform: 'android',
    });
    closeModal();
  });
}

/* ---------------- 从 Play 链接 / 包名直下 ---------------- */

/**
 * 从用户粘的东西里认出包名。支持三种写法：
 *   https://play.google.com/store/apps/details?id=com.foo&hl=zh
 *   market://details?id=com.foo
 *   com.foo
 * 中文应用名不算——那得走搜索，硬猜会把「微信」当成包名发到服务端。
 */
function parsePlayRef(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/[?&]id=([A-Za-z0-9._]+)/);
  if (m) return m[1];
  // 裸包名至少得是反向域名：带点、只用安全字符
  if (s.includes('.') && /^[A-Za-z0-9._]{2,200}$/.test(s)) return s;
  return '';
}

function showPlayDirect() {
  openModal('从 Google Play 直下 APK', `
    <p>把 Play 商店的链接或包名粘进来，用你自己的 Google 账号取原包。服务端会下 base + 分包，
    合并成一个 APK（debug 重签，装之前先卸载官方版）。</p>
    <div class="field"><label>Play 链接 / 包名</label>
      <input id="pd-ref" type="text" autocomplete="off" spellcheck="false"
        placeholder="https://play.google.com/store/apps/details?id=com.tencent.mm"></div>
    <div class="btn-row"><button class="btn-main" id="pd-go" type="button">开始下载</button></div>
    <p class="muted" style="font-size:12px">只支持免费应用。付费的、在你账号所属区已下架的、
    或与虚拟设备不兼容的包，Play 不会给下载链接——那种情况用卡片上的 APKPure / 应用宝 直链。</p>
    <div class="log" id="pd-log"></div>
  `);
  const input = $('#pd-ref');
  const go = $('#pd-go');
  const log = $('#pd-log');
  if (!input || !go) return;
  input.focus();

  const run = async () => {
    const pkg = parsePlayRef(input.value);
    if (!pkg) {
      logTo(log, '认不出包名：粘完整链接，或者像 com.tencent.mm 这样的包名', 'err');
      return;
    }
    go.disabled = true;
    go.textContent = '查应用名…';
    let title = '';
    try {
      const r = await fetch(`/api/play/info?pkg=${encodeURIComponent(pkg)}`);
      const j = await r.json();
      if (r.ok && j.title) title = j.title;
    } catch {
      /* 名字取不到就先用包名，不影响下载 */
    }
    go.disabled = false;
    go.textContent = '开始下载';
    // 直接换成下载面板（openModal 会替换内容），不要先 closeModal：
    // 关和开的动画叠在一起会闪一下
    playDownload(pkg, `${pkg}.apk`, title);
  };

  go.addEventListener('click', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  });
}

/* ---------------- App Store（ipatool）账号与 IPA / PKG 下载 ---------------- */

let appleJob = null;

async function reloadBackends() {
  try {
    const res = await fetch('/api/backends?refresh=1');
    state.backends = await res.json();
    renderTools(state.backends);
    if (state.data) renderResults();
  } catch {
    /* 刷新失败就维持旧状态 */
  }
}

async function refreshApple() {
  let st;
  try {
    const res = await fetch('/api/apple/status');
    st = await res.json();
  } catch {
    st = { available: false };
  }

  appleState = st;
  applebarEl.hidden = false;
  applebarEl.classList.remove('on', 'off', 'down');
  // 多账号入口只在 ipatool 可用时有意义
  applebarAccts.hidden = !st.available;

  if (!st.available) {
    applebarEl.classList.add('down');
    applebarText.innerHTML = '<b>App Store</b> 没装 ipatool';
    applebarBtn.textContent = '怎么装';
    applebarBtn.dataset.act = 'install';
    applebarBtn.classList.remove('ghostbtn');
    return;
  }
  if (st.authed) {
    applebarEl.classList.add('on');
    applebarText.innerHTML = `<b>App Store</b> ${esc(st.email || '已登录')}`;
    applebarBtn.textContent = '退出';
    applebarBtn.dataset.act = 'logout';
    applebarBtn.classList.add('ghostbtn');
    return;
  }
  applebarEl.classList.add('off');
  applebarText.innerHTML = '<b>App Store</b> 未登录，登录后能下 IPA / PKG';
  applebarBtn.textContent = '连接账号';
  applebarBtn.dataset.act = 'login';
  applebarBtn.classList.remove('ghostbtn');
}

/* ---------------- Apple 多账号：国服 / 美服 / 其他区 ---------------- */

// 添加账号时暂存邮箱密码，2FA 那一步只补验证码，不把密码反复塞进 DOM
let acctDraft = null;

async function openAppleAccounts() {
  acctDraft = null;
  openModal('Apple 多账号', `
    <p>每个 Apple ID 只能下它所在区的 App（国服账号下中国区，美服账号下美国区）。
    这里按账号保存 ipatool 的会话快照，切换时把快照写回钥匙串，通常不用再验证；
    快照过期才需要密码重登（会触发两步验证）。<strong>添加账号时 macOS 会弹一次钥匙串授权，点「允许」即可。</strong></p>
    <div id="acct-list"><p class="muted">正在读取…</p></div>
    <h4 class="acct-h">添加账号</h4>
    <div class="acct-grid">
      <div class="field"><label>备注</label>
        <input id="acct-label" type="text" maxlength="24" placeholder="例如：国服 / 美服"></div>
      <div class="field"><label>商店区</label>
        <select id="acct-region">
          <option value="">未指定</option>
          <option value="cn">中国区</option>
          <option value="us">美国区</option>
          <option value="jp">日本区</option>
          <option value="hk">中国香港区</option>
          <option value="tw">中国台湾区</option>
          <option value="gb">英国区</option>
          <option value="other">其他区</option>
        </select></div>
    </div>
    <div class="field"><label>Apple ID</label>
      <input id="acct-email" type="text" inputmode="email" autocomplete="username" placeholder="you@example.com"></div>
    <div class="field"><label>密码</label>
      <input id="acct-pwd" type="password" autocomplete="current-password" placeholder="Apple ID 密码"></div>
    <div class="field"><label>两步验证码（登录要求时再填）</label>
      <input id="acct-code" type="text" inputmode="numeric" maxlength="6" placeholder="6 位数字，可留空"></div>
    <div class="btn-row"><button class="btn-main" id="acct-add-btn" type="button">登录并添加</button></div>
    <div class="log" id="acct-log"></div>
  `);

  $('#acct-add-btn')?.addEventListener('click', () => appleAccountAdd());
  await renderAppleAccounts();
  $('#acct-email')?.focus();
}

async function renderAppleAccounts() {
  const box = $('#acct-list');
  if (!box) return;
  try {
    const r = await fetch('/api/apple/accounts');
    const j = await r.json();
    const list = j.accounts || [];
    if (!list.length) {
      box.innerHTML = '<p class="muted kc-hint">还没有保存的账号。登录一次会自动登记到这里。</p>';
      return;
    }
    box.innerHTML = `<div class="kc-list">${list
      .map(
        (a) => `<div class="kc-item">
          <div class="kc-main">
            <div class="kc-mail">${esc(a.email)}${a.label ? ` · ${esc(a.label)}` : ''}${a.active ? ' · 当前' : ''}</div>
            <div class="kc-tag">${esc(a.regionText || '未指定区')} · ${
              a.hasSession ? '有会话快照' : '无会话快照（需重登）'
            }${a.hasPassword ? ' · 已存密码' : ''}</div>
          </div>
          <div class="kc-acts">
            ${a.active ? '' : `<button class="qact" data-acct-switch="${esc(a.email)}" type="button">切换</button>`}
            <button class="qact" data-acct-del="${esc(a.email)}" type="button">删除</button>
          </div>
        </div>`
      )
      .join('')}</div>`;
    box.querySelectorAll('[data-acct-switch]').forEach((b) =>
      b.addEventListener('click', () => switchAppleAccount(b.dataset.acctSwitch, b))
    );
    box.querySelectorAll('[data-acct-del]').forEach((b) =>
      b.addEventListener('click', () => removeAppleAccount(b.dataset.acctDel))
    );
  } catch (e) {
    box.innerHTML = `<p class="muted kc-hint">读取失败：${esc(String(e.message || e))}</p>`;
  }
}

async function switchAppleAccount(email, btn) {
  const log = $('#acct-log');
  if (btn) btn.disabled = true;
  // 复用添加表单里的验证码框：目标账号没有快照、要密码重登时用得上
  const code = $('#acct-code')?.value.trim() || '';
  logTo(log, `正在切换到 ${email}…`, 'dim');
  try {
    const r = await fetch('/api/apple/accounts/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    const j = await r.json();

    if (r.ok && j.ok) {
      if ($('#acct-code')) $('#acct-code').value = '';
      logTo(log, `已切到 ${j.email}${j.sessionOk ? '' : '（会话可能已过期）'}`, 'ok');
      if (j.warn) logTo(log, j.warn, 'dim');
      await renderAppleAccounts();
      await refreshApple();
      await reloadBackends();
      return;
    }
    if (j.needs2fa) {
      logTo(log, '这个账号要两步验证：把验证码填到上面的框，再点一次「切换」', 'dim');
      $('#acct-code')?.focus();
      return;
    }
    logTo(log, j.message || '切换失败', 'err');
  } catch (e) {
    logTo(log, String(e.message || e), 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function removeAppleAccount(email) {
  const log = $('#acct-log');
  try {
    const r = await fetch('/api/apple/accounts/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const j = await r.json();
    if (!r.ok) return logTo(log, j.message || '删除失败', 'err');
    logTo(log, `已删除 ${email} 的登记`, 'ok');
    await renderAppleAccounts();
  } catch (e) {
    logTo(log, String(e.message || e), 'err');
  }
}

async function appleAccountAdd() {
  const log = $('#acct-log');
  const btn = $('#acct-add-btn');
  if (!btn) return;

  if (!acctDraft) {
    const email = $('#acct-email')?.value.trim() || '';
    const password = $('#acct-pwd')?.value || '';
    if (!email) return logTo(log, '先填 Apple ID', 'err');
    if (!password) return logTo(log, '密码也要填', 'err');
    acctDraft = {
      email,
      password,
      label: $('#acct-label')?.value.trim() || '',
      region: $('#acct-region')?.value || '',
    };
    if ($('#acct-pwd')) $('#acct-pwd').value = '';
  }

  const code = $('#acct-code')?.value.trim() || '';
  if (code && !/^\d{6}$/.test(code)) return logTo(log, '验证码是 6 位数字', 'err');

  btn.disabled = true;
  logTo(log, code ? '正在校验验证码…' : '正在登录（首次要等 Apple 下发会话，十几秒）…', 'dim');
  try {
    const r = await fetch('/api/apple/accounts/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...acctDraft, code }),
    });
    const j = await r.json();
    if (j.ok) {
      acctDraft = null;
      logTo(log, `已添加：${j.email || ''}`, 'ok');
      if (j.captured === false) {
        logTo(log, `会话快照没抓到：${j.captureError || '钥匙串授权没通过'}。这个账号切换时需要重新登录。`, 'err');
      } else {
        logTo(log, '会话已保存，之后来回切换不用再验证', 'dim');
      }
      if ($('#acct-code')) $('#acct-code').value = '';
      await renderAppleAccounts();
      await refreshApple();
      await reloadBackends();
      return;
    }
    if (j.needs2fa) {
      logTo(log, 'Apple 要求两步验证，验证码已推到你的设备——填进上面的框再点一次', 'dim');
      $('#acct-code')?.focus();
      return;
    }
    if (j.badCode) {
      logTo(log, '验证码不对或已过期，Apple 会重新推一个', 'err');
      return;
    }
    logTo(log, j.message || '登录失败', 'err');
  } catch (e) {
    logTo(log, String(e.message || e), 'err');
  } finally {
    btn.disabled = false;
  }
}

function showAppleLogin(hint) {
  appleCred = null;
  openModal('连接 Apple ID', `
    <p>用你自己的 Apple ID 从 App Store 取包。ipatool 会把长期凭证存进本机 keychain，
    密码只在本机内存里过一次，不落盘、不上传、也不写日志。</p>
    <div class="btn-row" style="margin-bottom:10px">
      <button class="btn-ghost" id="ap-keychain" type="button">从钥匙串读取</button>
    </div>
    <div id="ap-kc-list"></div>
    <div class="field"><label>Apple ID</label>
      <input id="ap-email" type="text" inputmode="email" autocomplete="username" placeholder="you@example.com"></div>
    <div class="field"><label>密码</label>
      <input id="ap-pwd" type="password" autocomplete="current-password" placeholder="Apple ID 密码"></div>
    <div class="btn-row"><button class="btn-main" id="ap-login" type="button">登录</button></div>
    <div class="log" id="ap-log"></div>
  `);
  if (hint) logTo($('#ap-log'), hint, 'err');
  const input = $('#ap-email');
  if (input) input.focus();
}

/** 钥匙串里翻到的 Apple ID：有密码的直接登，没密码的只回填账号 */
async function loadAppleKeychain() {
  const box = $('#ap-kc-list');
  const btn = $('#ap-keychain');
  const log = $('#ap-log');
  if (!box) return;
  btn.disabled = true;
  box.innerHTML = '<p class="muted kc-hint">正在读钥匙串…（第一次系统可能会问一次是否允许 security 访问）</p>';
  try {
    const r = await fetch('/api/apple/keychain');
    const j = await r.json();
    const items = j.items || [];
    if (!items.length) {
      box.innerHTML = `<p class="muted kc-hint">钥匙串里没找到 Apple ID。
        只有本机「登录钥匙串」里的条目能读（iCloud 钥匙串 /「密码」App 里存的，系统不给命令行读）。</p>`;
      return;
    }
    box.innerHTML = `<div class="kc-list">${items
      .map(
        (it) => `<div class="kc-item">
          <div class="kc-main">
            <div class="kc-mail">${esc(it.email)}</div>
            <div class="kc-tag">${esc(it.label)}${it.hasPassword ? ' · 含密码' : ' · 仅账号'}</div>
          </div>
          <div class="kc-acts">
            ${
              it.hasPassword
                ? `<button class="qact" data-kc="${esc(it.id)}" data-kcmode="fill">验证并填入</button>
                   <button class="qact" data-kc="${esc(it.id)}" data-kcmode="login">直接登录</button>`
                : `<button class="qact" data-kc="${esc(it.id)}" data-kcmode="fill">填入账号</button>`
            }
          </div>
        </div>`
      )
      .join('')}</div>`;
    // 登录过的账号多半就是这个，省一次点选
    const first = items[0];
    const em = $('#ap-email');
    if (em && !em.value) em.value = first.email;
    if (log) logTo(log, `找到 ${items.length} 条 Apple ID 记录`, 'dim');
  } catch (e) {
    box.innerHTML = `<p class="muted kc-hint">读钥匙串失败：${esc(String(e.message || e))}</p>`;
  } finally {
    btn.disabled = false;
  }
}

/**
 * 钥匙串条目：取账号和取密码是两步。
 * 取密码那一步才弹 macOS 的系统授权框 —— 输本机登录密码并允许（这就是管理员验证），
 * 通过后明文才交给 security，这里再自动填进密码框。
 */
async function appleLoginFromKeychain(id, mode = 'login') {
  const log = $('#ap-log');
  const card = document.querySelector('[data-kc="' + CSS.escape(id) + '"]')?.closest('.kc-item');
  const email = (card?.querySelector('.kc-mail')?.textContent || '').trim();
  const fillEmail = () => {
    const em = $('#ap-email');
    if (em && email) em.value = email;
  };

  if (mode === 'fill') {
    const btn = card?.querySelector('[data-kcmode="fill"]');
    if (!card?.querySelector('[data-kcmode="login"]')) {
      // 只有账号没有密码，没什么可验证的
      fillEmail();
      $('#ap-pwd')?.focus();
      if (log) logTo(log, '已填入账号，密码要手动输', 'dim');
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = '等待系统验证…';
    }
    if (log) logTo(log, '系统会弹授权框：输本机登录密码并点「允许」，密码才会交出来', 'dim');
    try {
      const res = await fetch('/api/apple/keychain-fill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const j = await res.json();
      if (j.ok) {
        fillEmail();
        const pwd = $('#ap-pwd');
        if (pwd) pwd.value = j.password;
        logTo(log, `系统验证通过，已填入 ${j.email || email} 的密码`, 'ok');
        $('#ap-login')?.focus();
      } else {
        logTo(log, j.message || '没取到密码', 'err');
      }
    } catch (e) {
      logTo(log, String(e.message || e), 'err');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '验证并填入';
      }
    }
    return;
  }

  const item = card?.querySelector('[data-kcmode="login"]');
  if (item) item.disabled = true;
  if (log) logTo(log, '用钥匙串里的凭证登录…', 'dim');
  try {
    const res = await fetch('/api/apple/keychain-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const j = await res.json();
    if (j.ok) {
      logTo(log, `登录成功：${j.email || ''}`, 'ok');
      await refreshApple();
      await reloadBackends();
      const pending = applePending;
      applePending = null;
      setTimeout(() => (pending ? openAppleDownload(pending) : closeModal()), 800);
      return;
    }
    if (j.needs2fa) {
      // 2FA 那一步要复用同一份凭证，所以记一下「这次是从钥匙串来的」
      appleCred = { keychain: true, id };
      showApple2fa('');
      return;
    }
    if (j.needsPassword) {
      const em = $('#ap-email');
      if (em) em.value = j.email || '';
      $('#ap-pwd')?.focus();
      logTo(log, j.message || '需要手动填密码', 'dim');
      return;
    }
    logTo(log, j.message || '登录失败', 'err');
  } catch (e) {
    logTo(log, String(e.message || e), 'err');
  } finally {
    if (item) item.disabled = false;
  }
}

function showApple2fa(hint) {
  openModal('两步验证', `
    <p>Apple 已经把 6 位验证码发到你信任的 iPhone / iPad / Mac 上了。</p>
    <div class="field"><label>验证码</label>
      <input id="ap-code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code"></div>
    <div class="btn-row">
      <button class="btn-main" id="ap-verify" type="button">验证并登录</button>
      <button class="btn-ghost" id="ap-back" type="button">换个账号</button>
    </div>
    <div class="log" id="ap-log"></div>
  `);
  if (hint) logTo($('#ap-log'), hint, 'dim');
  const input = $('#ap-code');
  if (!input) return;
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      appleLogin(input.value.trim());
    }
  });
}

async function appleLogin(code) {
  const log = $('#ap-log');
  const btn = $('#ap-login') || $('#ap-verify');
  if (!btn) return;

  // 第一次提交时把账号密码收进内存；2FA 那一步只补验证码，
  // 不把密码塞进 DOM，也不放 localStorage
  const emailEl = $('#ap-email');
  if (emailEl) {
    const email = emailEl.value.trim();
    // 从钥匙串那条进来的（appleCred.keychain）不用再要密码，服务端自己取
    const password = $('#ap-pwd') ? $('#ap-pwd').value : '';
    if (!email) {
      logTo(log, '先填 Apple ID', 'err');
      return;
    }
    if (!password && !appleCred?.keychain) {
      logTo(log, '密码也要填', 'err');
      return;
    }
    appleCred = password ? { email, password } : appleCred;
    if ($('#ap-pwd')) $('#ap-pwd').value = '';
  }
  if (!appleCred) return;

  if (code && !/^\d{6}$/.test(code)) {
    logTo(log, '验证码是 6 位数字', 'err');
    return;
  }

  btn.disabled = true;
  logTo(log, code ? '正在校验验证码…' : '正在登录（首次要等 Apple 下发会话，十几秒）…', 'dim');

  const body = appleCred.keychain
    ? { id: appleCred.id, code }
    : { email: appleCred.email, password: appleCred.password, code };

  try {
    const res = await fetch(appleCred.keychain ? '/api/apple/keychain-login' : '/api/apple/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json();

    if (j.ok) {
      appleCred = null;
      logTo(log, `登录成功：${j.email || ''}`, 'ok');
      await refreshApple();
      await reloadBackends();
      const pending = applePending;
      applePending = null;
      setTimeout(() => (pending ? openAppleDownload(pending) : closeModal()), 800);
      return;
    }

    if (j.needs2fa) {
      // 第一次是「刚触发推送」，第二次多半是「码错了 / 过期了」，提示得不一样
      showApple2fa(code ? '这个码没通过或已过期，Apple 会重新推一个' : '');
      return;
    }

    logTo(log, j.message || '登录失败', 'err');
    if (j.badCode && !$('#ap-code')) showApple2fa();
  } catch (err) {
    logTo(log, String(err.message || err), 'err');
  } finally {
    btn.disabled = false;
  }
}

const APPLE_PLATFORMS = {
  iphone: 'iPhone / iOS',
  ipad: 'iPad',
  appletv: 'Apple TV',
  watchos: 'Apple Watch',
  visionos: 'Vision Pro',
  macos: 'Mac App Store',
};

const APPLE_STORE_LABEL = {
  cn: '中国',
  us: '美国',
  jp: '日本',
  hk: '中国香港',
  tw: '中国台湾',
};

function openAppleDownload({ bundle, plat, name, stores = [] }) {
  appleJob = { bundle, plat, name, stores };
  const choices = plat === 'macos' ? ['macos'] : ['iphone', 'ipad', 'appletv', 'watchos', 'visionos'];
  const ext = plat === 'macos' ? 'PKG' : 'IPA';
  const title = name ? `${name}` : bundle;

  // 全部区检索会把「只在某一区上架」的 App 也翻出来。这类包的下载取决于
  // 账号属于哪个 storefront（ipatool 没有 --country），不提前说清楚就是必然的失败。
  const regions = stores.map((c) => APPLE_STORE_LABEL[c]).filter(Boolean);
  const storeWarn = regions.length && !stores.includes('cn')
    ? `<p class="store-warn">这个 App 只在 ${esc(regions.join(' / '))}区上架。下载用的是你账号所属的区，
        不是这里选的区——如果你的 Apple ID 不在这些区里，会取不到包。</p>`
    : '';

  openModal(`下载 ${ext}`, `
    <p>${esc(title)} · <code>${esc(bundle)}</code></p>
    ${storeWarn}
    <div class="field-row">
      <div class="field"><label>设备</label>
        <select id="ap-platform">
          ${choices.map((p) => `<option value="${p}"${p === plat ? ' selected' : ''}>${APPLE_PLATFORMS[p]}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>版本</label>
        <select id="ap-version"><option value="">最新版</option></select>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn-main" id="ap-go" type="button">开始下载</button>
      <button class="btn-ghost" id="ap-loadv" type="button">加载历史版本</button>
      <button class="btn-ghost" id="ap-batch" type="button" hidden>批量下载</button>
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px">包是 FairPlay 加密、绑在你账号上的，只能装到本人登录同一 Apple ID 的设备。</p>
    <p class="muted" style="font-size:12px">一次只能真正跑一个 Apple 下载（ipatool 会抢钥匙串），但你可以连着点几个：后面的会排队，进度都在右下角「下载队列」里。</p>
    <div class="bar indet"><i id="ap-bar"></i></div>
    <div class="dl-stat" id="ap-stat"></div>
    ${bgRowHtml()}
    <div class="log" id="ap-log"></div>
  `);
}

// 版本数上限：默认补最近 20 个，点「加载更多」翻倍，最多 60（再多就是几十次进程往返）
let appleVersionCap = 20;

async function loadAppleVersions(more) {
  if (!appleJob) return;
  const sel = $('#ap-version');
  const btn = $('#ap-loadv');
  const log = $('#ap-log');
  if (!sel || !btn) return;

  if (more) appleVersionCap = Math.min(appleVersionCap * 2, 60);
  sel.innerHTML = '<option value="">最新版</option>';
  btn.disabled = true;
  btn.textContent = '加载中…';
  let n = 0;
  let total = 0;
  let failed = false;

  try {
    const plat = $('#ap-platform').value;
    await readSse(
      `/api/apple/versions?bundle=${encodeURIComponent(appleJob.bundle)}&platform=${plat}&limit=${appleVersionCap}`,
      {},
      (evt) => {
        if (evt.type === 'total') {
          total = evt.total || 0;
        } else if (evt.type === 'version') {
          const opt = document.createElement('option');
          opt.value = evt.id;
          opt.textContent = `v${evt.version || '?'}${evt.date ? ' · ' + evt.date : ''}`;
          sel.appendChild(opt);
          n += 1;
        } else if (evt.type === 'done' && Array.isArray(evt.versions) && evt.versions.length) {
          // 并发查回来的顺序是「谁先完成谁先到」，这里按服务端排好的新→旧重排一次
          const keep = sel.value;
          sel.innerHTML = '<option value="">最新版</option>';
          for (const v of evt.versions) {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = `v${v.version || '?'}${v.date ? ' · ' + v.date : ''}`;
            sel.appendChild(opt);
          }
          if (keep) sel.value = keep;
        } else if (evt.type === 'error') {
          failed = true;
          logTo(log, evt.message || '拿不到版本列表', 'err');
        }
      }
    );
  } catch (err) {
    failed = true;
    logTo(log, String(err.message || err), 'err');
  }

  if (failed) {
    // 失败时说「没有历史版本」会误导，恢复原样让用户能重试
    btn.textContent = '加载历史版本';
    btn.disabled = false;
    return;
  }
  if (total > n) {
    // 版本 id 一次全给，元数据才是逐个查的，所以「还有多少」是确切数字
    btn.textContent = `已列出最近 ${n} 个 / 共 ${total} 个 · 加载更多`;
    btn.disabled = false;
  } else {
    btn.textContent = n ? `已列出全部 ${n} 个版本` : '没有历史版本';
    btn.disabled = n > 0;
  }

  // 批量下载：只对已经列出来的版本生效（没列出来的连 id 都没有）。
  // 上限 5 个——每个都可能是几百 MB，一次全下会占满磁盘和带宽。
  const batch = $('#ap-batch');
  if (batch) {
    const k = Math.min(5, n);
    batch.hidden = k < 2;
    batch.textContent = `批量下载前 ${k} 个`;
  }
}

async function runAppleDownload(batch = []) {
  if (!appleJob) return;
  const go = $('#ap-go');
  const loadBtn = $('#ap-loadv');
  const batchBtn = $('#ap-batch');
  const log = $('#ap-log');
  const bar = $('#ap-bar');
  const stat = $('#ap-stat');
  const myBg = $('#dl-bg');
  const plat = $('#ap-platform').value;
  const version = $('#ap-version').value;
  if (!go) return;

  // 批量下多个版本时不再要求选单个版本：列表本身就是「要下哪些」
  const isBatch = Array.isArray(batch) && batch.length > 1;
  if (!isBatch && batch.length === 1) {
    // 只有一个就退回单版本路径，省一次批量循环
    $('#ap-version').value = batch[0];
    return runAppleDownload();
  }

  go.disabled = true;
  // 上一轮失败后按钮会变成「重试下载」，这次重新跑就恢复成原样的文案
  go.textContent = '开始下载';
  if (loadBtn) loadBtn.disabled = true;
  if (batchBtn) batchBtn.disabled = true;
  log.innerHTML = '';
  if (bar) {
    bar.parentElement.classList.add('indet');
    bar.parentElement.classList.remove('err');
    bar.style.width = '0%';
  }

  // 分母来自 App Store 的 lookup（大约等于最新版的体积），历史版本会不准，
  // 所以只在文字上标「约」，条走到 99% 就停住，别让它冲到 100% 后又往回退
  let totalBytes = 0;
  let lastBytes = 0;
  const setStat = (t, bad) => {
    if (!stat) return;
    stat.textContent = t;
    stat.classList.toggle('bad', Boolean(bad));
  };
  if (stat) stat.textContent = '正在准备…';

  // 断了就只能从头再来：ipatool 2.7 没有断点续传（download 没有 --resume，
  // 也不吐下载直链），写了一半的 .tmp 服务端会清掉。
  // 所以别让用户回列表里重新找这个 App——把主按钮直接换成「重试下载」。
  const markBroken = (msg) => {
    setStat('下载中断 · 不能续传，点「重试下载」', true);
    if (bar) {
      bar.parentElement.classList.remove('indet');
      bar.parentElement.classList.add('err');
      if (!bar.style.width) bar.style.width = '100%';
    }
    if (msg) logTo(log, msg, 'err');
    if (go) go.textContent = '重试下载';
  };

  let file = '';
  const files = [];
  // 服务端一挂上队列就把面板里的那条刷出来，别等下完才第一次看见
  setTimeout(pollQueue, 700);
  setTimeout(pollQueue, 2200);
  showBg(myBg);
  try {
    const query = isBatch
      ? `&versions=${batch.map(encodeURIComponent).join(',')}`
      : `&version=${encodeURIComponent(version)}`;

    await readSse(
      `/api/apple/download?bundle=${encodeURIComponent(appleJob.bundle)}&platform=${plat}${query}${
        appleJob.name ? `&name=${encodeURIComponent(appleJob.name)}` : ''
      }`,
      {},
      (evt) => {
        if (evt.type === 'start') {
          totalBytes = Number(evt.total) || 0;
          if (bar) {
            // 知道总量了，先回到 0%，但保留 indet 的滑动动画：
            // 真正收到字节前它是「正在协商」，有字节后才切成确定的百分比
            bar.parentElement.classList.add('indet');
            bar.parentElement.classList.remove('err');
            bar.style.width = '0%';
          }
          setStat(totalBytes ? `包体${evt.exact ? '' : '约'} ${fmtBytes(totalBytes)}，正在向 App Store 请求…` : '开始下载…');
        } else if (evt.type === 'progress') {
          // 带 bytes 的是真实进度，只带 message 的是阶段说明
          if (typeof evt.bytes === 'number') {
            lastBytes = evt.bytes;
            if (bar) {
              bar.parentElement.classList.remove('indet', 'err');
              if (totalBytes) bar.style.width = `${Math.min(99, (evt.bytes / totalBytes) * 100).toFixed(1)}%`;
            }
            setStat(dlStatText(evt.bytes, totalBytes, evt.speed || 0));
          } else {
            logTo(log, evt.message);
            if (!totalBytes) setStat(evt.message);
          }
        } else if (evt.type === 'batch') {
          logTo(log, `—— ${evt.message} ——`, 'dim');
          setStat(evt.message);
          // 每个版本体积不同，换包时把分母清掉，等下一个 start 重新给
          totalBytes = 0;
          if (bar) {
            bar.parentElement.classList.add('indet');
            bar.style.width = '0%';
          }
        } else if (evt.type === 'item-success') {
          files.push(evt.file);
          logTo(log, `✓ ${evt.file}${evt.size ? ' · ' + evt.size : ''}`, 'ok');
        } else if (evt.type === 'item-error') {
          logTo(log, `✗ 版本 ${evt.versionId}：${evt.message || '失败'}`, 'err');
        } else if (evt.type === 'success') {
          file = evt.file || '';
          if (Array.isArray(evt.files)) files.push(...evt.files);
          if (bar) {
            bar.parentElement.classList.remove('indet');
            bar.style.width = '100%';
          }
          setStat(isBatch ? `全部完成 · ${new Set(files).size} 个包` : `完成 · ${evt.size || fmtBytes(lastBytes)}`);
          if (isBatch) {
            logTo(log, `全部完成：${new Set(files).size} 个包已存到 .downloads`, 'ok');
          } else {
            logTo(log, `准备完成：${evt.file}${evt.size ? ' · ' + evt.size : ''}`, 'ok');
          }
        } else if (evt.type === 'error') {
          // 条停在失败时的位置并变红，别让它继续假滑——用户得一眼看出是断了
          markBroken(evt.message || '下载失败');
          if (evt.needsAuth) {
            applePending = appleJob;
            setTimeout(() => showAppleLogin(evt.message), 1200);
          }
        }
      }
    );
  } catch (err) {
    // 服务端重启 / 连接被掐断时 SSE 会直接抛（Chrome 报的就是 network error），
    // 这时已经下到一半的字节同样救不回来，按同一种方式收尾
    markBroken(String(err.message || err));
  } finally {
    go.disabled = false;
    if (loadBtn) loadBtn.disabled = false;
    if (batchBtn) batchBtn.disabled = false;
  }

  if (isBatch) {
    // 批量下载的包都在 .downloads 里，走文件列表比连开 5 个下载更稳
    if (files.length) {
      logTo(log, '已全部放进下载队列（右下角），在列表里统一保存或装到设备。', 'ok');
      pollQueue();
      openQueue(true);
    }
    return;
  }
  if (!file) return;
  // 不自动拉文件：用户常常连着下好几个版本，每下一个就弹一次浏览器很烦。
  // 放进队列，等他挑完再一起取。
  logTo(log, '已放进下载队列（右下角），在那里点「保存」再取。', 'ok');
  pollQueue();
  openQueue(true);
  setTimeout(closeModal, 1800);
}

/* ---------------- 第三方分发页 → IPA 直链 ---------------- */

function showIpaResolve() {
  openModal('从分发页提取 IPA', `
    <p>把一个第三方分发页、<code>itms-services://</code> 链接，或者 <code>.ipa</code> 直链粘进来。
    服务端会读出页面里的 OTA 清单（plist），把真正的安装包地址、包名、版本和体积列出来。</p>
    <div class="field"><label>分发页 / manifest / IPA 链接</label>
      <input id="ipa-url" type="url" placeholder="https://example.com/app" autocomplete="off" spellcheck="false"></div>
    <div class="btn-row"><button class="btn-main" id="ipa-resolve" type="button">解析</button></div>
    <p class="muted" style="font-size:12px">只解析公开链接，不需要 Apple ID。包能不能装取决于它的签名和你的设备，
    本工具不重签、也不碰破解源。</p>
    <div class="log" id="ipa-log"></div>
  `);
  const el = $('#ipa-url');
  if (!el) return;
  el.focus();
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      resolveIpa();
    }
  });
}

async function resolveIpa() {
  const input = $('#ipa-url');
  const btn = $('#ipa-resolve');
  const log = $('#ipa-log');
  if (!input || !btn || !log) return;

  const u = input.value.trim();
  if (!u) {
    logTo(log, '先粘一个链接', 'err');
    return;
  }

  btn.disabled = true;
  log.innerHTML = '';
  logTo(log, '正在抓取页面并找 OTA 清单…', 'dim');

  try {
    const res = await fetch(`/api/apple/resolve?u=${encodeURIComponent(u)}`);
    const j = await res.json();
    if (!j.ok) {
      logTo(log, j.error || '解析失败', 'err');
      return;
    }
    if (!j.items || !j.items.length) {
      logTo(log, j.hint || '页面里没有 IPA', 'err');
      return;
    }

    logTo(log, `找到 ${j.items.length} 个候选`, 'ok');
    for (const it of j.items) {
      const name = it.bundleId || 'app';
      const file = `${name}-${it.version || 'latest'}.ipa`;
      const row = document.createElement('div');
      row.className = 'ipa-item';
      row.innerHTML = `
        <div class="ipa-title">${esc(it.title || '未命名安装包')}</div>
        <div class="ipa-meta">${esc(
          [it.bundleId, it.version ? `v${it.version}` : '', it.sizeText].filter(Boolean).join(' · ') || '没有元数据'
        )}</div>
        <a class="dl primary" href="/api/download?u=${encodeURIComponent(it.ipaUrl)}&n=${encodeURIComponent(file)}">
          ${downloadIcon()}<span class="dl-label">下载 IPA${it.sizeText ? '' : '（体积未知）'}</span>
        </a>`;
      log.appendChild(row);
    }
  } catch (e) {
    logTo(log, String(e.message || e), 'err');
  } finally {
    btn.disabled = false;
  }
}

const ipaBtn = $('#applebar-ipa');
if (ipaBtn) ipaBtn.addEventListener('click', showIpaResolve);

applebarBtn.addEventListener('click', async () => {
  const act = applebarBtn.dataset.act;
  if (act === 'login') return showAppleLogin();

  if (act === 'install') {
    openModal('安装 ipatool', `
      <p>IPA 只能由本机的 ipatool 用你自己的 Apple ID 取。在终端跑一次：</p>
      <pre><code>brew install ipatool</code></pre>
      <p>装完刷新这个页面，顶部的状态条就会变成「连接账号」。</p>
    `);
    return;
  }

  if (act === 'logout') {
    applebarBtn.disabled = true;
    try {
      await fetch('/api/apple/logout', { method: 'POST' });
    } catch {
      /* 失败也刷新一次状态 */
    }
    applebarBtn.disabled = false;
    await refreshApple();
    await reloadBackends();
  }
});

playbarDirect?.addEventListener('click', () => showPlayDirect());

// App Store 多账号入口
applebarAccts?.addEventListener('click', () => openAppleAccounts());

playbarBtn.addEventListener('click', async () => {
  const act = playbarBtn.dataset.act;
  if (act === 'login') return showLogin();
  if (act === 'logout') {
    playbarBtn.disabled = true;
    try {
      await fetch('/api/play/logout', { method: 'POST' });
    } catch {
      /* 失败也刷新一次，让状态自己说话 */
    }
    playbarBtn.disabled = false;
    await refreshPlay();
    if (state.data) renderResults();
    return;
  }

  if (act === 'start') {
    playbarBtn.disabled = true;
    playbarBtn.textContent = '启动中…';
    try {
      await fetch('/api/play/start', { method: 'POST' });
    } catch {
      /* 下面刷新会体现结果 */
    }
    playbarBtn.disabled = false;
    await refreshPlay();
  }
});

modalBody.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    modalBody.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
    const which = tab.dataset.tab;
    $('#tab-browser').hidden = which !== 'browser';
    $('#tab-manual').hidden = which !== 'manual';
    return;
  }

  /* ---- Google：用本机浏览器里已登录的账号开窗（只预填邮箱） ---- */
  const pbBtn = e.target.closest('[data-pbemail]');
  if (pbBtn) {
    loginWithAccount(pbBtn.dataset.pbemail);
    return;
  }

  if (e.target.closest('#pb-session-go')) {
    const email = (document.querySelector('#pb-pwdbar')?.dataset.email) || '';
    runSessionLogin(email);
    return;
  }

  if (e.target.closest('#pb-pwd-go')) {
    const btn = e.target.closest('#pb-pwd-go');
    const email = (document.querySelector('#pb-pwdbar')?.dataset.email) || '';
    const pwd = $('#pb-pwd')?.value || '';
    const log = $('#login-log');
    if (!pwd) {
      if (log) logTo(log, '密码是空的', 'err');
      return;
    }
    // 密码可能带首尾空格（粘贴来的），但不能替用户删——先报长度，对不上就知道少了字符
    logTo(log, `提交中（${pwd.length} 位密码）…`, 'dim');
    btn.disabled = true;
    btn.textContent = '登录中';
    runLogin({ email, password: pwd, savePassword: true }).finally(() => {
      btn.disabled = false;
      btn.textContent = '登录';
    });
    return;
  }

  if (e.target.closest('#btn-browser')) {
    runLogin({ browser: true });
    return;
  }

  if (e.target.closest('#btn-manual')) {
    const email = $('#in-email').value.trim();
    const oauthToken = $('#in-oauth').value.trim();
    if (!email || !oauthToken) {
      logTo($('#login-log'), '邮箱和 oauth_token 都要填', 'err');
      return;
    }
    runLogin({ email, oauthToken });
    return;
  }

  /* ---- App Store / ipatool ---- */
  if (e.target.closest('#ap-keychain')) {
    loadAppleKeychain();
    return;
  }
  const kcBtn = e.target.closest('[data-kc]');
  if (kcBtn) {
    appleLoginFromKeychain(kcBtn.dataset.kc, kcBtn.dataset.kcmode || 'login');
    return;
  }
  if (e.target.closest('#ap-login')) {
    appleLogin();
    return;
  }
  if (e.target.closest('#ap-verify')) {
    appleLogin($('#ap-code').value.trim());
    return;
  }
  if (e.target.closest('#ap-back')) {
    showAppleLogin();
    return;
  }
  if (e.target.closest('#ap-go')) {
    runAppleDownload();
    return;
  }
  if (e.target.closest('#ap-loadv')) {
    loadAppleVersions(true);
    return;
  }
  if (e.target.closest('#ap-batch')) {
    const sel = $('#ap-version');
    const ids = sel ? [...sel.options].map((o) => o.value).filter(Boolean).slice(0, 5) : [];
    if (ids.length < 2) return toast('先加载历史版本');
    runAppleDownload(ids);
    return;
  }
  if (e.target.closest('#ipa-resolve')) {
    resolveIpa();
  }
});

// 换设备等于换一套可用版本，历史版本列表必须重拉
modalBody.addEventListener('change', (e) => {
  if (e.target.id !== 'ap-platform') return;
  const sel = $('#ap-version');
  if (!sel) return;
  sel.innerHTML = '<option value="">最新版</option>';
  appleVersionCap = 20;
  const btn = $('#ap-loadv');
  const batch = $('#ap-batch');
  if (batch) batch.hidden = true;
  if (btn) {
    btn.textContent = '加载历史版本';
    btn.disabled = false;
  }
});

$('#modal-x').addEventListener('click', closeModal);
modalEl.addEventListener('click', (e) => {
  if (e.target === modalEl) closeModal();
});
// 「后台下载」：收起弹窗、把队列展开。下载本身跑在服务端，关不关窗口都不影响
modalEl.addEventListener('click', (e) => {
  if (!e.target.closest('[data-bg]')) return;
  closeModal();
  openQueue(true);
  pollQueue();
  toast('已转到后台，进度看右下角「下载队列」');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalEl.hidden) closeModal();
});

/* ---------------- 已连接的手机 ---------------- */

const devicebarEl = $('#devicebar');
const devicebarText = $('#devicebar-text');
const deviceSelect = $('#device-select');
const devicebarBtn = $('#devicebar-btn');

const PLATFORM_DEV = { android: 'android', ios: 'ios' };

/** 当前选中的设备能不能装这种包；不能就别在按钮上乱暗示 */
function deviceFor(platform) {
  const d = state.device;
  if (!d || !d.ready) return null;
  if (!PLATFORM_DEV[platform]) return null;
  return d.platform === PLATFORM_DEV[platform] ? d : null;
}

async function refreshDevices(force) {
  try {
    const res = await fetch(`/api/devices${force ? '?refresh=1' : ''}`);
    renderDeviceBar(await res.json());
  } catch {
    /* 探测失败就当作没设备，不影响搜索 */
  }
}

function renderDeviceBar(j) {
  const tools = j?.tools || {};
  const devices = j?.devices || [];
  const anyTool = tools.adb?.available || tools.pymobiledevice3?.available;
  if (!anyTool) {
    devicebarEl.hidden = true;
    return;
  }

  const ready = devices.filter((d) => d.ready);
  const prevId = state.device?.id || '';
  // 选中的设备拔掉了就退回上次用的、再不行用第一台
  let sel = state.device ? ready.find((d) => d.id === state.device.id) : null;
  if (!sel) {
    let saved = '';
    try {
      saved = localStorage.getItem('apd.device') || '';
    } catch {
      saved = '';
    }
    const sid = saved.split(':').slice(1).join(':');
    sel = (sid && ready.find((d) => d.id === sid)) || ready[0] || null;
  }
  state.device = sel;
  state.devices = devices;

  const changed = prevId !== (sel?.id || '');
  devicebarEl.hidden = false;
  devicebarEl.classList.toggle('on', Boolean(sel));
  devicebarEl.classList.toggle('off', !sel);

  if (!devices.length) {
    devicebarText.textContent = '没有连接手机';
    deviceSelect.hidden = true;
    devicebarBtn.textContent = '怎么连？';
    devicebarBtn.dataset.act = 'help';
  } else {
    devicebarText.innerHTML = sel
      ? `装到 <b>${esc(sel.name)}</b>`
      : `有 ${devices.length} 台设备未就绪`;
    // 只有一台设备时下拉是纯噪音，文字里已经写了名字
    deviceSelect.hidden = devices.length <= 1;
    deviceSelect.innerHTML = devices
      .map(
        (d) =>
          `<option value="${esc(d.id)}"${d.ready ? '' : ' disabled'}>${esc(d.name)} · ${
            d.platform === 'android' ? 'Android' : 'iOS'
          }</option>`
      )
      .join('');
    deviceSelect.value = sel?.id || '';
    devicebarBtn.textContent = '刷新';
    devicebarBtn.dataset.act = 'refresh';
  }

  // 设备换了，卡片上的小按钮要从「＋」变成「📱」，否则用户不知道会装到哪台
  if (changed && state.data) renderResults();
}

deviceSelect.addEventListener('change', () => {
  state.device = state.devices.find((d) => d.id === deviceSelect.value) || null;
  if (state.device) {
    localStorage.setItem('apd.device', `${state.device.platform}:${state.device.id}`);
  }
  if (state.data) renderResults();
});

devicebarBtn.addEventListener('click', async () => {
  if (devicebarBtn.dataset.act === 'help') return showDeviceHelp();
  devicebarBtn.disabled = true;
  await refreshDevices(true);
  devicebarBtn.disabled = false;
  toast(state.device ? `已连接 ${state.device.name}` : '还是没有检测到设备');
});

function showDeviceHelp() {
  openModal('把手机连到这台电脑', `
    <p><strong>Android</strong>：装一份 <code>platform-tools</code>，用数据线插上，手机上打开「开发者选项 → USB 调试」，看到授权弹窗点「允许」。</p>
    <pre><code>brew install --cask android-platform-tools
adb devices -l</code></pre>
    <p><strong>iPhone / iPad</strong>：装 pymobiledevice3（纯 Python，不需要 Xcode），插线后在手机上点「信任」。</p>
    <pre><code>python3 -m pip install pymobiledevice3
pymobiledevice3 usbmux list</code></pre>
    <p class="muted">检测到的设备只在本机使用。装 iOS 包时要注意：App Store 下到的 IPA 是 FairPlay 加密、绑账号的，系统会拒绝安装；能装的是自己重签过或企业签名分发的 IPA。</p>
  `);
}

/* ---------------- 下载队列 ---------------- */

const queuebarEl = $('#queuebar');
const queueListEl = $('#queue-list');
const queueTitleEl = $('#queue-title');
const queueToggleBtn = $('#queue-toggle');
const queueClearBtn = $('#queue-clear');

let queueTimer = null;
let queueLogJob = '';

async function pollQueue() {
  clearTimeout(queueTimer);
  try {
    const res = await fetch('/api/queue');
    const j = await res.json();
    state.queueJobs = j.jobs || [];
    renderQueue();
  } catch {
    /* 网络抖动就下一轮再试 */
  }
  const busy = state.queueJobs.some((x) => x.status === 'queued' || x.status === 'downloading');
  if (busy || state.queueOpen) {
    queueTimer = setTimeout(pollQueue, busy ? 700 : 2500);
  }
}

function openQueue(open) {
  state.queueOpen = open;
  queueToggleBtn.textContent = open ? '收起' : '展开';
  queueToggleBtn.setAttribute('aria-expanded', String(open));
  queueListEl.hidden = !open;
  renderQueue();
  if (open) pollQueue();
}

async function addToQueue(body) {
  const dev = deviceFor(body.platform);
  const payload = { ...body };
  // 设备已选好就直接「下完即装」，省掉一次回来点按钮
  if (dev) payload.install = { platform: dev.platform, device: dev.id, name: dev.name };

  try {
    const res = await fetch('/api/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (!res.ok) return toast(j.error || '加入队列失败');
    toast(dev ? `已加入队列，下完自动装到 ${dev.name}` : '已加入下载队列');
    openQueue(true);
    await pollQueue();
  } catch (e) {
    toast(String(e.message || e));
  }
}

function queueJobHtml(j) {
  const installing = j.installStatus === 'installing';
  const pct = j.status === 'done' || installing ? 100 : j.percent || 0;
  const active = j.status === 'downloading';
  const cls = [j.status, j.installStatus === 'ok' ? 'installed' : ''].filter(Boolean).join(' ');

  let meta = '';
  const missing = Boolean(j.missing);
  if (missing) {
    meta = '文件已被清理';
  } else if (installing) {
    meta = '正在安装…';
  } else if (j.waiting) {
    // Apple 一次只能跑一个，排在后面的别显示成「下载中 0%」，看着像卡住了
    meta = '排队中，前面的下完自动开始';
  } else if (active || j.status === 'queued') {
    const parts = [j.sizeText && j.totalText ? `${j.sizeText} / ${j.totalText}` : j.sizeText || '等待中'];
    if (j.speedText) parts.push(j.speedText);
    // 分了几段并发：单连接被限速时这里会从 1 跳到 4，用户能对上「怎么突然快了」
    if (j.parallel > 1) parts.push(`${j.parallel} 段`);
    meta = parts.join(' · ');
  } else if (j.status === 'error') {
    meta = j.error || '失败';
  } else if (j.status === 'canceled') {
    meta = '已取消';
  } else {
    meta = j.totalText || j.sizeText || '已完成';
  }

  const acts = [];
  // 文件被手动删了：只留「移除」，别给一个必然 404 的保存按钮
  if (missing) acts.push(`<button class="qact" data-qdrop="${esc(j.id)}">移除</button>`);
  // 纯安装任务没有可取消的下载流，给个「取消」只会让人以为真能停下来；
  // 外部传输（Apple/Play）没给 onCancel 时同理
  else if ((active || j.status === 'queued') && j.kind !== 'install' && j.canCancel !== false) {
    acts.push(`<button class="qact" data-qcancel="${esc(j.id)}">取消</button>`);
  }
  if (j.status === 'done' && !missing) {
    if (j.installStatus === 'installing') acts.push('<span class="qnote">安装中…</span>');
    if (j.installStatus === 'ok') acts.push('<span class="qnote ok">已装到设备</span>');
    if (j.installStatus === 'error') {
      acts.push('<span class="qnote err">安装失败</span>');
      acts.push(`<button class="qact" data-qlog="${esc(j.id)}">看日志</button>`);
    }
    if (!j.installStatus || j.installStatus === 'error') {
      acts.push(`<a class="qact" href="/api/file?name=${encodeURIComponent(j.file)}">保存</a>`);
      acts.push(`<button class="qact" data-qreveal="${esc(j.file)}">显示</button>`);
      if (deviceFor(j.platform)) {
        acts.push(`<button class="qact strong" data-qinstall="${esc(j.id)}">装到 ${esc(deviceFor(j.platform).name)}</button>`);
      }
    }
    // 完成的条目也要能清出去，否则列表只增不减。只从列表移除，文件留着
    acts.push(`<button class="qact" data-qdrop="${esc(j.id)}">移除</button>`);
  }
  if (j.status === 'error' || j.status === 'canceled') {
    // 「区域不提供 / 要付费 / 和设备不兼容」这类错误点几次都是同一个结果，
    // 服务端会把 canRetry 置 false，别给用户一个点了也没用的按钮
    if (j.canRetry) {
      acts.push(`<button class="qact strong" data-qretry="${esc(j.id)}">重试</button>`);
    }
    acts.push(`<button class="qact" data-qdrop="${esc(j.id)}">移除</button>`);
  }

  const devNote = j.install
    ? `<span class="qdev">→ ${esc(j.install.name || j.install.device.slice(0, 8))}</span>`
    : '';

  // 标题行显示应用名（「奶茶人」），包名/文件名降成下面一行小字：
  // 下完隔天回来看列表，com.sanjie.sipor_6759524779_1.1.5.ipa 谁也认不出是什么
  const main = j.title || j.name || '';
  const sub = j.title && (j.file || j.name) && (j.file || j.name) !== j.title
    ? `<div class="qjob-file" title="${esc(j.file || j.name)}">${esc(j.file || j.name)}</div>`
    : '';

  return `<div class="qjob ${cls}">
    <div class="qjob-top">
      <span class="qjob-name" title="${esc(j.title ? `${j.title} · ${j.file || j.name}` : j.name)}">${esc(main)}</span>
      <span class="qjob-pct">${j.waiting ? '排队' : active || j.status === 'queued' ? `${pct}%` : ''}</span>
    </div>
    ${sub}
    <div class="qbar"><i style="width:${pct}%"></i></div>
    <div class="qjob-meta">${esc(meta)}${devNote}</div>
    <div class="qjob-act">${acts.join('')}</div>
  </div>`;
}

function renderQueue() {
  const jobs = state.queueJobs;
  queuebarEl.hidden = jobs.length === 0;
  if (!jobs.length) return;

  const busy = jobs.filter((j) => j.status === 'queued' || j.status === 'downloading').length;
  queueTitleEl.textContent = busy ? `下载队列 · ${busy} 个进行中` : `下载队列 · ${jobs.length}`;
  queuebarEl.classList.toggle('busy', busy > 0);
  queueClearBtn.hidden = busy > 0;

  if (state.queueOpen) queueListEl.innerHTML = jobs.map(queueJobHtml).join('');
}

queueToggleBtn.addEventListener('click', () => openQueue(!state.queueOpen));

queueClearBtn.addEventListener('click', async () => {
  await fetch('/api/queue/clear', { method: 'POST' });
  pollQueue();
});

queueListEl.addEventListener('click', async (e) => {
  const cancelBtn = e.target.closest('[data-qcancel]');
  if (cancelBtn) {
    await fetch('/api/queue/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: cancelBtn.dataset.qcancel }),
    });
    return pollQueue();
  }

  const revealBtn = e.target.closest('[data-qreveal]');
  if (revealBtn) {
    const r = await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: revealBtn.dataset.qreveal }),
    });
    if (!r.ok) toast('打不开文件所在目录');
    return;
  }

  const installBtn = e.target.closest('[data-qinstall]');
  if (installBtn) {
    const job = state.queueJobs.find((x) => x.id === installBtn.dataset.qinstall);
    const dev = job && deviceFor(job.platform);
    if (!job || !dev) return toast('没有可用的设备');
    const r = await fetch('/api/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: job.file, platform: job.platform, device: dev.id, deviceName: dev.name }),
    });
    const j = await r.json();
    if (!r.ok) return toast(j.error || '安装失败');
    pollQueue();
    return;
  }

  const logBtn = e.target.closest('[data-qlog]');
  if (logBtn) {
    const job = state.queueJobs.find((x) => x.id === logBtn.dataset.qlog);
    return openModal('安装日志', `<pre class="qlog"><code>${esc(job?.installLog || '没有日志')}</code></pre>`);
  }

  // 失败/取消的条目重来一次。直链任务复用同一个 id 和 .part，所以是「续」不是「重下」；
  // Play / Apple 是另一种链路（队列调度不了），服务端按记下的参数重新发起
  const retryBtn = e.target.closest('[data-qretry]');
  if (retryBtn) {
    const id = retryBtn.dataset.qretry;
    retryBtn.disabled = true;
    retryBtn.textContent = '重试中…';
    try {
      const r = await fetch('/api/queue/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(j.error || '重试失败');
        retryBtn.disabled = false;
        retryBtn.textContent = '重试';
        return;
      }
      // 取消时 `.part` 已经删了，直链也会从头下，别在这时候说「从断点继续」
      const wasCanceled = state.queueJobs.find((x) => x.id === id)?.status === 'canceled';
      toast(j.kind === 'download' && !wasCanceled ? '已重新排队，从断点继续' : '已重新开始下载');
      await pollQueue();
    } catch (err) {
      toast(String(err.message || err));
      retryBtn.disabled = false;
      retryBtn.textContent = '重试';
    }
    return;
  }

  const dropBtn = e.target.closest('[data-qdrop]');
  if (dropBtn) {
    // 必须让服务端也删掉，否则下次轮询又把它拉回来
    await fetch('/api/queue/drop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: dropBtn.dataset.qdrop }),
    });
    return pollQueue();
  }
});

/* ---------------- boot ---------------- */

initStore();

(async function bootBackends() {
  try {
    const res = await fetch('/api/backends');
    state.backends = await res.json();
    renderTools(state.backends);
    if (state.data) renderResults();
  } catch {
    /* 后端探测失败不影响搜索 */
  }
})();

// Play 旁路要单独拿状态：它是独立进程，可能没起来或没登录
refreshPlay();
// App Store 走的是本机 ipatool，状态从 keychain 读，同样单独拉
refreshApple();
// 设备与队列都是本机能力，和搜索互不影响，各拉一次
refreshDevices();
pollQueue();

// 直接带 ?queue=1 打开面板，方便分享「我下到哪了」这类现场
if (new URL(location.href).searchParams.has('queue')) openQueue(true);

const initial = new URL(location.href).searchParams.get('q');
if (initial) search(initial.trim());
