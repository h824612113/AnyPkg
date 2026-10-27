'use strict';

/**
 * 本机下载队列。
 *
 * 为什么下载要放服务端而不是继续用浏览器的 <a download>：
 *  1. 批量下十几个包时，浏览器会把它们挤进同一个连接池，进度只在系统下载器里，
 *     页面完全不知道下到哪了；
 *  2. 「下完直接装到手机」要求文件先落在本机固定目录，浏览器的下载目录不归我们管；
 *  3. 断点续传 / 失败重试 / 速度统计只有写文件的一方才有意义。
 *
 * 并发压到 2：再多也抢不出带宽，只会让每个文件的剩余时间都变长。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { smartOpen } = require('./net');
const devices = require('./devices');
const names = require('./names');

const UA = 'AnyPkg/0.8 (local queue)';
const CONCURRENCY = 2;
const MAX_RETRY = 2;
const KEEP_JOBS = 40;
const DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 ** 3;

class DownloadCapacityError extends Error {
  constructor(used, limit) {
    super(`下载目录已占用 ${fmtSize(used)}，达到上限 ${fmtSize(limit)}；请手动清理后再下载`);
    this.name = 'DownloadCapacityError';
    this.code = 'download_capacity';
    this.used = used;
    this.limit = limit;
  }
}

function directoryBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }
  return total;
}

/**
 * 分段并发下载。
 *
 * 起因：Whering 那个 68 MB 的 APK 单连接只跑到 29~40 KB/s，11 分钟下了 14 MB 就断了；
 * 同样的地址开 4 条 Range 各跑 40 KB/s，合计 337 KB/s~1 MB/s。单连接被限速是很多
 * CDN/代理的默认行为（按连接计费、拥塞窗口小），多开几条就绕过去了。
 *
 * 只在 6 MB 以上才探：一次探测要多花 200~500ms，小文件不值当。
 * 探测不通过、或者分段本身失败两次，就退回单流——优化点不能变成新的故障点。
 */
const PARALLEL_MIN = 6 * 1024 * 1024;
const MAX_PARTS = 8;

function partsWanted() {
  const raw = Number(process.env.APD_DOWNLOAD_PARTS || 4);
  if (!Number.isFinite(raw) || raw <= 0) return 4;
  return Math.max(1, Math.min(MAX_PARTS, Math.floor(raw)));
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function sanitize(name) {
  return (
    String(name || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 160) || 'download'
  );
}

function splitExt(name) {
  const m = String(name).match(/^(.*?)(\.[A-Za-z0-9]{1,8})$/);
  return m ? [m[1], m[2]] : [String(name), ''];
}

/**
 * 这类失败重试多少次都是同一个结果：包在你账号的商店区拿不到、要付费、
 * 和设备不兼容。给按钮等于给一个「点了也没用」的期待。
 */
const HOPELESS = new Set(['not_found', 'no_delivery', 'paid_app', 'incompatible']);

function retryable(j) {
  if (j.status !== 'error' && j.status !== 'canceled') return false;
  if (j.errorCode && HOPELESS.has(j.errorCode)) return false;
  // 直链任务有 url 就能重排；Play / Apple 这种外部传输靠发起时记下的 retry 元数据
  return Boolean(j.url || j.retry);
}

function totalFrom(headers, offset) {
  const cr = headers['content-range'];
  if (cr) {
    const m = String(cr).match(/\/(\d+)/);
    if (m) return Number(m[1]);
  }
  const len = Number(headers['content-length']) || 0;
  return len ? len + offset : 0;
}

class DownloadQueue {
  constructor({ dir, onFinish = null, validateUrl = null, maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES } = {}) {
    this.dir = dir;
    this.jobs = [];
    this.active = 0;
    this.onFinish = onFinish;
    this.validateUrl = validateUrl;
    this.maxBytes = Number(maxBytes) || DEFAULT_MAX_DOWNLOAD_BYTES;
    fsp.mkdir(dir, { recursive: true }).catch(() => {});
  }

  usage() {
    return directoryBytes(this.dir);
  }

  assertCapacity() {
    const used = this.usage();
    if (used >= this.maxBytes) throw new DownloadCapacityError(used, this.maxBytes);
    return { used, limit: this.maxBytes };
  }

  list() {
    return this.jobs.map((j) => this.view(j));
  }

  /** 用户手动清了 .downloads 之后，别让面板还挂着一个点了 404 的「保存」 */
  missing(j) {
    if (j.status !== 'done' || !j.file) return false;
    const now = Date.now();
    if (!j._checkedAt || now - j._checkedAt > 5000) {
      j._checkedAt = now;
      j._missing = !fs.existsSync(path.join(this.dir, j.file));
    }
    return Boolean(j._missing);
  }

  view(j) {
    return {
      id: j.id,
      name: j.name,
      // 应用名（「奶茶人」），和 name（文件名）分开：文件名里只有包名，
      // 用户认不出是哪个 App。显式带过来的优先，没有就按包名查本地字典
      title: j.title || names.nameForFile(j.file || j.name),
      file: j.file,
      url: j.url,
      platform: j.platform,
      kind: j.kind,
      status: j.status,
      bytes: j.bytes,
      total: j.total,
      sizeText: fmtSize(j.bytes || j.total),
      totalText: fmtSize(j.total),
      speedText: j.status === 'downloading' && j.speed ? `${fmtSize(j.speed)}/s` : '',
      // 分了几段并发（0 = 走单流），面板上标一下，用户才知道「怎么突然快了」
      parallel: j.status === 'downloading' ? Number(j.parallel) || 0 : 0,
      // 100% 只留给真正落盘完成的那一刻：Apple/Play 的字节数先到顶、
      // 后面还有合并和重签名要跑，这时候显示 100% 会让人以为卡住了
      percent: j.total
        ? Math.min(j.status === 'done' ? 100 : 99, Math.round((j.bytes / j.total) * 100))
        : 0,
      // 外部传输没有 stream 可断，发起方没给 onCancel 就别显示「取消」
      canCancel: j.external ? Boolean(j.onCancel) : true,
      // 失败/取消的条目给个「重试」。重试是原地复活同一条任务，不会多出一条重复的
      canRetry: retryable(j),
      // 排队等轮次的（Apple 一次只能跑一个），面板上要和真在下传的区分开
      waiting: Boolean(j.waiting),
      error: j.error,
      errorCode: j.errorCode || '',
      install: j.install,
      installStatus: j.installStatus,
      installLog: j.installLog,
      missing: this.missing(j),
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
    };
  }

  /**
   * 把一个「已经在磁盘上」的文件登记成已完成任务。
   *
   * IPA（ipatool）和 Play 合并包都不是 HTTP 流，走不了 enqueue()；
   * 但用户要的是「下完统一在列表里取」，所以让它们也出现在同一个面板里，
   * 保存/显示/装到设备这三个按钮就能复用。
   *
   * 只登记路径，不搬文件——文件本来就在 this.dir 里。
   */
  adopt({ name, file, platform = 'ios', size = 0, kind = 'app', title = '' }) {
    if (!file) return null;
    const dup = this.jobs.find((j) => j.file === file && j.status === 'done');
    if (dup) {
      // 后到的名字通常更准（比如刚从搜索卡片带过来的），补上但不覆盖新的
      if (title && !dup.title) dup.title = title;
      return this.view(dup);
    }
    const job = {
      id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: name || file,
      title: title || '',
      file,
      url: '',
      platform,
      kind,
      status: 'done',
      bytes: size,
      total: size,
      createdAt: Date.now(),
      finishedAt: Date.now(),
    };
    this.jobs.push(job);
    return this.view(job);
  }

  /** 从列表里去掉一条（不动磁盘文件）。前端「移除」按钮用 */
  drop(id) {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0) return this.jobs.length;
    const job = this.jobs[i];
    // 还在下载的先标取消再摘掉：直接摘会让传输在后台跑完、文件落盘却没条目，
    // 变成一个用户看不见也删不掉的孤儿
    if (job.status === 'downloading' || job.status === 'queued') {
      job.canceled = true;
      job.status = 'canceled';
      try {
        job.onCancel?.();
      } catch {
        /* 传输已经没了 */
      }
    }
    this.jobs.splice(i, 1);
    return this.jobs.length;
  }

  /**
   * 登记一条「不归队列调度」的传输。
   *
   * Apple 的 ipatool 和 Play 的 base+splits 合并都在各自的 SSE 请求里跑完才落盘，
   * 队列插不进手，也压不住它们的并发。但它们一样要跑几分钟，用户却只能在
   * 弹窗里看——关掉弹窗就不知道下到哪了。所以这里只做记账：
   * 进度由调用方喂进来，队列不负责调度，也不占 CONCURRENCY 的槽位。
   *
   * onCancel 是可选的：给了才在面板上出「取消」，否则那个按钮点了也没用。
   */
  begin({ name, platform = '', kind = 'app', total = 0, onCancel = null, title = '', retry = null }) {
    this.assertCapacity();
    const job = {
      id: `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      url: '',
      name: name || '下载中',
      title: title || '',
      file: '',
      platform,
      kind,
      status: 'downloading',
      bytes: 0,
      total: Number(total) || 0,
      speed: 0,
      error: '',
      errorCode: '',
      // 「怎么把这一次重新跑起来」的描述：队列调度不了 Play / Apple，
      // 只能在发起时把参数记下来，重试时照着再叫一遍
      retry,
      install: null,
      installStatus: '',
      installLog: '',
      canceled: false,
      external: true,
      onCancel,
      createdAt: Date.now(),
      finishedAt: 0,
      sample: { at: Date.now(), bytes: 0 },
    };
    this.jobs.unshift(job);
    return job.id;
  }

  /** 外部传输的进度：调用方给的是绝对字节数，不是增量 */
  progress(id, bytes, total) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.status !== 'downloading') return;
    const b = Number(bytes);
    if (Number.isFinite(b) && b >= 0) job.bytes = b;
    const t = Number(total);
    if (Number.isFinite(t) && t > 0) job.total = t;
    const now = Date.now();
    if (now - job.sample.at >= 400) {
      const dt = (now - job.sample.at) / 1000;
      job.speed = Math.max(0, (job.bytes - job.sample.bytes) / dt);
      job.sample = { at: now, bytes: job.bytes };
    }
  }

  /** 排队中还是真在传。Apple 一次只跑一个，排队的那条要单独标出来 */
  markWaiting(id, waiting) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.status !== 'downloading') return;
    job.waiting = Boolean(waiting);
  }

  finishExternal(id, { file = '', size = 0 } = {}) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    job.file = file || job.file;
    job.name = file || job.name;
    if (size) {
      job.bytes = size;
      job.total = size;
    }
    job.speed = 0;
    job.status = 'done';
    job.finishedAt = Date.now();
    return this.view(job);
  }

  failExternal(id, message, code = '') {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    // 用户点了取消之后，上游断开是预期内的，别把它报成红字。
    // 判 canceled 标记而不是 status：断开回调可能比 cancel() 置状态早一个 tick
    if (job.canceled || job.status === 'canceled') {
      job.status = 'canceled';
      job.speed = 0;
      job.finishedAt = job.finishedAt || Date.now();
      return this.view(job);
    }
    job.status = 'error';
    job.error = String(message || '下载失败');
    // 上游给的错误码要留着：面板靠它判断这条值不值得给「重试」
    job.errorCode = String(code || '');
    job.speed = 0;
    job.finishedAt = Date.now();
    return this.view(job);
  }

  /** 原始任务对象（含 retry 元数据这类不对外暴露的字段），给服务端的重试逻辑用 */
  raw(id) {
    return this.jobs.find((j) => j.id === id) || null;
  }

  /**
   * 重排一条失败的直链任务。
   *
   * 原地复活而不是新开一条：新 id 会因为 job.file 还被旧条目占着而变成
   * `xxx (2).apk`，而 `.part` / `.part.json` 的断点是按文件名存的——换了名字
   * 等于从零开始白下一遍，81 MB 的包重下一次就是几分钟。
   */
  retry(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return { error: '任务不存在' };
    if (job.status === 'downloading' || job.status === 'queued') return { error: '这条任务还在跑' };
    if (job.external) return { error: '外部传输要由发起方重跑' };
    if (!job.url) return { error: '这条任务没有下载地址' };
    try {
      this.assertCapacity();
    } catch (err) {
      return { error: err.message, code: err.code };
    }

    job.status = 'queued';
    job.error = '';
    job.errorCode = '';
    job.canceled = false;
    job.speed = 0;
    // 进度由 fetchOnce 从 `.part` / `.part.json` 重新算，这里先归零避免闪一下旧数字
    job.bytes = 0;
    job.parallel = 0;
    job.finishedAt = 0;
    job.sample = { at: Date.now(), bytes: 0 };
    // 手动重试是一个新的开始，给分段模式一次机会（自动降级只针对同一次尝试）
    job.parFail = 0;
    job.parOff = false;

    this.pump();
    return { job: this.view(job) };
  }

  /**
   * 把一条失败的外部传输（Play / Apple）原地复活，返回同一个 id。
   *
   * 复用 id 而不是 begin() 新建：面板上失败的那条直接变回「下载中」，
   * 不会留下一堆红色的历史条目让用户自己分辨哪个是新的。
   */
  reopen(id, { onCancel = null } = {}) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || !job.external) return null;
    try {
      this.assertCapacity();
    } catch {
      return null;
    }
    job.status = 'downloading';
    job.bytes = 0;
    job.total = 0;
    job.speed = 0;
    job.error = '';
    job.errorCode = '';
    job.canceled = false;
    job.waiting = false;
    job.finishedAt = 0;
    job.startedAt = Date.now();
    job.sample = { at: Date.now(), bytes: 0 };
    job.onCancel = onCancel;
    return job;
  }

  /** 队列里同时只有一个同名文件；重名就 (2)(3) 往后排，别互相覆盖 */
  uniqueName(want) {
    const dir = this.dir;
    const taken = new Set(this.jobs.filter((j) => j.file).map((j) => j.file));
    if (!taken.has(want) && !fs.existsSync(path.join(dir, want))) return want;
    const [base, ext] = splitExt(want);
    for (let i = 2; i < 99; i += 1) {
      const cand = `${base} (${i})${ext}`;
      if (!taken.has(cand) && !fs.existsSync(path.join(dir, cand))) return cand;
    }
    return `${base}-${Date.now()}${ext}`;
  }

  add({ url, name, platform = '', kind = 'download', file = '', install = null, title = '' }) {
    if (url) this.assertCapacity();
    const id = crypto.randomBytes(6).toString('hex');
    const finalName = file ? path.basename(file) : this.uniqueName(sanitize(name));
    const job = {
      id,
      url: url || '',
      name: name || finalName,
      title: title || '',
      file: finalName,
      platform,
      kind,
      status: 'queued',
      bytes: 0,
      total: 0,
      speed: 0,
      error: '',
      install: install || null,
      installStatus: '',
      installLog: '',
      canceled: false,
      createdAt: Date.now(),
      finishedAt: 0,
      stream: null,
      ws: null,
      sample: { at: Date.now(), bytes: 0 },
    };
    this.jobs.unshift(job);
    this.trim();
    this.pump();
    return this.view(job);
  }

  trim() {
    const done = this.jobs.filter((j) => j.status !== 'downloading' && j.status !== 'queued');
    while (done.length > KEEP_JOBS) {
      const j = done.pop();
      const i = this.jobs.indexOf(j);
      if (i >= 0) this.jobs.splice(i, 1);
    }
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    job.canceled = true;
    if (job.status === 'queued') {
      job.status = 'canceled';
      job.finishedAt = Date.now();
    }
    // 分段下载时有多个读写流（每段一对），只 destroy 主的那对会留下还在跑的连接
    for (const s of [job.stream, job.ws, ...(job.streams || [])]) {
      try {
        s?.destroy(new Error('canceled'));
      } catch {
        /* 已经结束 */
      }
    }
    // 外部传输（Apple / Play）没有 stream 可 destroy，只能让发起方自己收手。
    // 立刻定成 canceled：等发起方回头再报错的话，用户点了取消还看到红字
    if (job.external && job.status === 'downloading') {
      job.status = 'canceled';
      job.speed = 0;
      job.finishedAt = Date.now();
    }
    try {
      job.onCancel?.();
    } catch {
      /* 已经结束 */
    }
    return true;
  }

  clear() {
    this.jobs = this.jobs.filter((j) => j.status === 'downloading' || j.status === 'queued');
    return this.list();
  }

  stats() {
    const active = this.jobs.filter((j) => j.status === 'downloading').length;
    const queued = this.jobs.filter((j) => j.status === 'queued').length;
    return { active, queued, total: this.jobs.length };
  }

  pump() {
    while (this.active < CONCURRENCY) {
      const job = this.jobs.find((j) => j.status === 'queued' && !j.canceled);
      if (!job) return;
      this.active += 1;
      // 不 await：每条任务是独立链路，pump 只负责派活
      this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  tick(job, delta) {
    job.bytes += delta;
    const now = Date.now();
    if (now - job.sample.at >= 400) {
      const dt = (now - job.sample.at) / 1000;
      job.speed = Math.max(0, (job.bytes - job.sample.bytes) / dt);
      job.sample = { at: now, bytes: job.bytes };
    }
  }

  async run(job) {
    job.status = 'downloading';
    job.startedAt = Date.now();
    try {
      if (job.kind !== 'install') this.assertCapacity();
      if (job.kind === 'install') {
        await this.install(job);
        return;
      }

      const part = path.join(this.dir, `${job.file}.part`);
      let lastErr = null;
      for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
        if (job.canceled) break;
        try {
          await this.fetchOnce(job, part);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (job.canceled) break;
          // 断点还在，下一次会带 Range 从断处续
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        }
      }

      if (job.canceled) {
        job.status = 'canceled';
        job.finishedAt = Date.now();
        // 取消不是失败，没必要留着半个文件占地方（分段模式还有一份进度 json）
        await this.dropPart(part);
        return;
      }
      if (lastErr) {
        job.status = 'error';
        job.error = String(lastErr.message || lastErr);
        return;
      }

      const target = path.join(this.dir, job.file);
      await fsp.rm(target, { force: true });
      await fsp.rename(part, target);
      // .part 已经改名成正式文件了，进度文件再留着就是垃圾
      await fsp.rm(this.statePath(part), { force: true }).catch(() => {});
      const st = await fsp.stat(target);
      job.bytes = st.size;
      job.total = job.total || st.size;
      job.speed = 0;
      job.parallel = 0;
      job.status = 'done';
      job.finishedAt = Date.now();

      if (job.install) await this.install(job);
      this.onFinish?.(this.view(job));
    } catch (e) {
      job.status = 'error';
      job.error = String(e.message || e);
      job.errorCode = String(e.code || '');
    }
  }

  async install(job) {
    job.installStatus = 'installing';
    job.status = job.status === 'queued' ? 'downloading' : job.status;
    try {
      const out = await devices.install({
        platform: job.install.platform,
        device: job.install.device,
        file: job.file,
        dir: this.dir,
      });
      job.installStatus = out.ok ? 'ok' : 'error';
      job.installLog = [out.log, out.hint].filter(Boolean).join('\n\n').slice(-1600);
    } catch (e) {
      job.installStatus = 'error';
      job.installLog = String(e.message || e);
    }
    job.status = 'done';
    job.finishedAt = Date.now();
  }

  /** 分段进度落在 `.part.json` 里：`.part` 本身会被预分配成整包大小，光看它看不出进度 */
  statePath(part) {
    return `${part}.json`;
  }

  async loadState(part) {
    try {
      const raw = await fsp.readFile(this.statePath(part), 'utf8');
      const s = JSON.parse(raw);
      return s && typeof s === 'object' ? s : null;
    } catch {
      return null;
    }
  }

  /** 单流和分段两种模式不能共用同一个 `.part`：一个是「长度=已下字节」，一个是「长度=整包」 */
  async dropPart(part) {
    await fsp.rm(part, { force: true }).catch(() => {});
    await fsp.rm(this.statePath(part), { force: true }).catch(() => {});
  }

  /**
   * 探一次「这个地址能不能切块」。
   *
   * 只认 206 + Content-Range 里带总长的响应。有些 CDN 对 `bytes=0-0` 照样回 200 全量，
   * 那就在这里立刻 disconnect，别顺手把几百 MB 拉下来。
   */
  async probeRange(url) {
    let res = null;
    try {
      res = await smartOpen(url, {
        headers: {
          'user-agent': UA,
          accept: '*/*',
          // 不带 identity 的话 gzip 会让 Range 失效，切出来的块拼不回原文件
          'accept-encoding': 'identity',
          range: 'bytes=0-0',
        },
        // 探针只是拿个头，别用下载那套宽松超时：慢站上白等 16s 才开工，
        // 比「这次不分段」体验更差。8s 探不出来就当它不支持
        timeout: 8000,
        idleTimeout: 15000,
        prefer: 'direct',
        hardPrefer: true,
        validateUrl: this.validateUrl,
      });
      if (res.status !== 206) return { ok: false, total: 0 };
      const m = String(res.headers['content-range'] || '').match(/\/(\d+)\s*$/);
      return { ok: Boolean(m), total: m ? Number(m[1]) : 0 };
    } catch {
      return { ok: false, total: 0 };
    } finally {
      try {
        res?.stream?.destroy();
      } catch {
        /* 已经关了 */
      }
    }
  }

  /**
   * 分段并发拉同一个文件。
   *
   * 每段用 `FileHandle.write(buf, off, len, pos)` 直接写自己的偏移，段之间不重叠，
   * 所以不需要最后拼一次，也不多占一份内存或磁盘。
   *
   * 为什么不用 `createWriteStream` + `pipe`：写流会先攒在内存里，连接一断缓冲区里
   * 那几 MB 就丢了，`seg.pos` 也就不再等于「磁盘上真有的字节」，拿它当断点会写出洞。
   * 显式 await 每次 write 之后，pos 就是可信的断点，断了接着下，最多丢一个 chunk。
   */
  async fetchParallel(job, part, total) {
    const sp = this.statePath(part);
    const limit = partsWanted();
    // 段太小并发就没意义了：每段至少 2 MB
    const n = Math.max(2, Math.min(limit, Math.ceil(total / (2 * 1024 * 1024))));
    const segSize = Math.ceil(total / n);

    const state = await this.loadState(part);
    let segs;
    if (
      state &&
      state.url === job.url &&
      Number(state.total) === total &&
      Array.isArray(state.segs) &&
      state.segs.length === n
    ) {
      segs = state.segs.map((s) => {
        const start = Math.max(0, Number(s.start) || 0);
        const end = Math.max(start, Number(s.end) || 0);
        // 越界的 pos（手改过 json / 上次算错）夹回去，别拿它去发 Range
        const pos = Math.min(Math.max(Number(s.pos) || 0, start), end + 1);
        return { start, end, pos };
      });
    } else {
      segs = Array.from({ length: n }, (_, i) => {
        const start = i * segSize;
        return { start, end: Math.min(total, start + segSize) - 1, pos: start };
      });
    }

    // 预分配到总长：后面每段都要能直接 seek 到自己的偏移，文件不能是「边下边长」的
    const fh0 = await fsp.open(part, 'a');
    await fh0.close();
    const st0 = await fsp.stat(part);
    if (st0.size !== total) await fsp.truncate(part, total);

    const done = () => segs.reduce((sum, s) => sum + Math.max(0, s.pos - s.start), 0);
    job.bytes = done();
    job.total = total;
    job.parallel = n;
    job.sample = { at: Date.now(), bytes: job.bytes };

    const save = () =>
      fsp
        .writeFile(sp, JSON.stringify({ url: job.url, total, segs }))
        .catch(() => {});

    await save();

    const live = new Set();
    job.streams = live;

    /** 拉一段，返回时 seg.pos 就是磁盘上真有的位置 */
    const pullSeg = async (seg, at) => {
      const headers = {
        'user-agent': UA,
        accept: '*/*',
        'accept-encoding': 'identity',
        range: `bytes=${seg.pos}-${seg.end}`,
      };
      const res = await smartOpen(job.url, {
        headers,
        timeout: 15000,
        idleTimeout: 90000,
        prefer: 'direct',
        hardPrefer: true,
        validateUrl: this.validateUrl,
      });
      if (res.status !== 206) {
        try {
          res.stream.destroy();
        } catch {
          /* 已经关了 */
        }
        throw new Error(
          res.status === 200 ? '服务器忽略了分段请求（回了 200）' : `上游返回 ${res.status}`
        );
      }

      // 先拿到句柄再登记到 live：打开失败时流还没进监控集合，得自己收尾
      const fh = await fsp.open(part, 'r+').catch((e) => {
        try {
          res.stream.destroy();
        } catch {
          /* 已经关了 */
        }
        throw e;
      });
      live.add(res.stream);
      try {
        // for await 自带背压：盘写不动的时候连接会一起慢下来，内存不会涨
        for await (const chunk of res.stream) {
          let off = 0;
          while (off < chunk.length) {
            const { bytesWritten } = await fh.write(chunk, off, chunk.length - off, seg.pos);
            if (!bytesWritten) throw new Error('磁盘写入没有进展');
            off += bytesWritten;
            seg.pos += bytesWritten;
            this.tick(job, bytesWritten);
          }
          // 服务端多给字节 = 段边界没守住，继续写会糊掉隔壁段
          if (seg.pos > seg.end + 1) throw new Error(`第 ${at} 段越界`);
        }
      } finally {
        live.delete(res.stream);
        try {
          res.stream.destroy();
        } catch {
          /* 已经关了 */
        }
        await fh.close().catch(() => {});
      }
    };

    const runSeg = async (seg) => {
      const at = segs.indexOf(seg) + 1;
      const want = seg.end - seg.start + 1;
      // 一段断了就地重连一次，不等其他段跑完——否则另外三段跑多久都得干等，
      // 400 KB/s 的线上就是十几分钟的差别。pos 是可信断点，重连不浪费字节。
      for (let attempt = 0; seg.pos <= seg.end; attempt += 1) {
        if (job.canceled) throw new Error('canceled');
        try {
          await pullSeg(seg, at);
          break;
        } catch (e) {
          if (job.canceled || attempt >= 1 || seg.pos > seg.end) {
            if (seg.pos - seg.start === want) break;
            throw e;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      if (job.canceled) throw new Error('canceled');
      const got = seg.pos - seg.start;
      if (got !== want) {
        throw new Error(`第 ${at} 段只收到 ${fmtSize(got)} / ${fmtSize(want)}`);
      }
      await save();
    };

    try {
      // 等所有段都收手再抛：跑完的段已经落到状态里了，下一次不用重下。
      // 单段掉线在 runSeg 里就地重连一次，所以走到这儿通常是真的整条链路断了。
      const settled = await Promise.allSettled(segs.map((seg) => runSeg(seg)));
      const bad = settled.find((r) => r.status === 'rejected');
      if (bad) throw bad.reason;
    } finally {
      job.streams = null;
      // 失败也要记一次：正在跑的段已经有确定的 pos 了，下次直接从这儿续
      await save();
    }
  }

  async fetchOnce(job, part) {
    // ---- 分段模式：有断点就续，没断点先探一次 ----
    if (partsWanted() > 1 && !job.parOff && !job.canceled) {
      let total = 0;
      const state = await this.loadState(part);
      if (state && state.url === job.url && Number(state.total) > 0) {
        const want = Number(state.total);
        // 光有状态不够：.part 被手动删过（或预分配没成功）时按状态续会在文件里留一片空洞
        const st = await fsp.stat(part).catch(() => null);
        if (st && st.size === want) total = want;
        else await this.dropPart(part);
      } else if (state) {
        // 地址换了（正常不会，但别赌），旧断点作废，否则会往错的文件里续
        await this.dropPart(part);
      }
      if (!total) {
        const probe = await this.probeRange(job.url);
        if (probe.ok && probe.total >= PARALLEL_MIN) total = probe.total;
      }
      if (total) {
        try {
          await this.fetchParallel(job, part, total);
          return;
        } catch (e) {
          job.parFail = (job.parFail || 0) + 1;
          if (job.canceled) throw e;
          // 连两次分段都不成，说明这条路本身不通（CDN 不认 Range / 中间设备改写），
          // 别再耗第三次：清掉预分配的 .part 换回单流，从头下总比下不动强
          if (job.parFail < 2) throw e;
          job.parOff = true;
          job.parallel = 0;
          await this.dropPart(part);
        }
      }
    }

    // ---- 单流（原路：靠 .part 长度做断点） ----
    let start = 0;
    try {
      start = (await fsp.stat(part)).size;
    } catch {
      start = 0;
    }

    const headers = {
      'user-agent': UA,
      accept: '*/*',
      'accept-encoding': 'identity',
      ...(start > 0 ? { range: `bytes=${start}-` } : {}),
    };

    const res = await smartOpen(job.url, {
      headers,
      timeout: 15000,
      idleTimeout: 90000,
      prefer: 'direct',
      hardPrefer: true,
      validateUrl: this.validateUrl,
    });

    if (res.status !== 200 && res.status !== 206) {
      res.stream.resume();
      throw new Error(`上游返回 ${res.status}`);
    }

    // 上游不认 Range 就会回 200 + 全量，这时候必须从头写，否则文件会拼坏
    const append = res.status === 206 && start > 0;
    if (!append) start = 0;
    job.bytes = start;
    job.total = totalFrom(res.headers, start);
    job.parallel = 0;
    job.sample = { at: Date.now(), bytes: start };

    const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    job.ws = ws;
    job.stream = res.stream;

    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        try {
          res.stream.destroy();
        } catch {}
        try {
          ws.destroy();
        } catch {}
        reject(e);
      };

      res.stream.on('data', (c) => this.tick(job, c.length));
      res.stream.once('error', fail);
      ws.once('error', fail);
      ws.once('finish', () => {
        if (settled) return;
        settled = true;
        job.stream = null;
        job.ws = null;
        // 内容长度对不上 = 连接中途断了，交给外层重试并续传
        if (job.total && job.bytes < job.total) {
          reject(new Error(`只下到 ${fmtSize(job.bytes)} / ${fmtSize(job.total)}`));
          return;
        }
        resolve();
      });

      res.stream.pipe(ws);
    });
  }
}

module.exports = { DownloadQueue, fmtSize, retryable };
