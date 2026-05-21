(() => {
  'use strict';

  if (window.__BILI_FOLLOW_MANAGER_CONTENT__) return;
  window.__BILI_FOLLOW_MANAGER_CONTENT__ = true;

  // === 常量 ===
  const AUTO_GROUPS = [
    '自动疑似异常', '自动无公开投稿', '自动一年未更', '自动半年未更',
    '自动近期未更', '自动知识科技', '自动动漫游戏', '自动音乐娱乐',
    '自动生活日常', '自动影视剪辑', '自动其他活跃'
  ];

  const CATEGORY_RULES = [
    { group: '自动知识科技', words: ['科技','数码','编程','代码','程序','开发','算法','机器学习','人工智能','AI','Python','Java','Linux','电脑','软件','硬件','教程','科普','知识','学习','数学','物理','化学','生物','医学','科研','论文','考研','公开课','工程'] },
    { group: '自动动漫游戏', words: ['游戏','实况','攻略','电竞','原神','崩坏','明日方舟','王者','英雄联盟','LOL','DOTA','MC','Minecraft','Steam','主机','PS5','switch','动漫','动画','漫画','二次元','番剧','手办','cos','声优'] },
    { group: '自动音乐娱乐', words: ['音乐','翻唱','演唱','唱歌','钢琴','吉他','乐队','舞蹈','宅舞','偶像','明星','综艺','娱乐','live','MV','rap','说唱','电音','鬼畜'] },
    { group: '自动生活日常', words: ['生活','日常','vlog','美食','做饭','烘焙','旅行','旅游','探店','穿搭','健身','减脂','宠物','猫','狗','家居','情感','摄影','手工','开箱'] },
    { group: '自动影视剪辑', words: ['电影','电视剧','影视','剪辑','解说','影评','混剪','纪录片','预告','片段','短片','美剧','韩剧','日剧'] }
  ];

  const DEFAULT_PARAMS = {
    inactiveDays: 90,
    followAgeDays: 180,
    maxAnalyze: 0,
    analyzeConcurrency: 3,
    requestInterval: 300,
    groupBatch: 50,
    groupInterval: 800,
    unfollowMax: 30,
    unfollowInterval: 1200,
    feedPages: 15,
    debug: '开启'
  };

  const PARAM_STORAGE_KEY = 'bfmParamsSafeV2';

  // === 状态 ===
  const state = {
    running: false,
    stop: false,
    self: null,
    follows: [],
    analyzed: [],
    selected: new Set(),
    specialMids: new Set(),
    processedUnfollowMids: new Set(),
    unfollowRecords: [],
    tagsByName: new Map(),
    tagsById: new Map(),
    whitelist: new Map(),
    lastParams: { ...DEFAULT_PARAMS },
    filter: '候选',
    search: '',
    activePool: null,
    feedActiveUids: new Map()
  };

  // === Promise 池 ===
  class PromisePool {
    constructor(max) { this.max = max; this.running = 0; this.queue = []; this.paused = false; }
    setMax(n) { this.max = Math.max(1, n); this._drain(); }
    pause(ms) { this.paused = true; setTimeout(() => { this.paused = false; this._drain(); }, ms); }
    add(fn) { return new Promise((resolve, reject) => { this.queue.push({ fn, resolve, reject }); this._drain(); }); }
    _drain() {
      if (this.paused) return;
      while (this.running < this.max && this.queue.length) {
        const { fn, resolve, reject } = this.queue.shift();
        this.running++;
        fn().then(resolve).catch(reject).finally(() => { this.running--; this._drain(); });
      }
    }
    get active() { return this.running; }
    get pending() { return this.queue.length; }
    clear() { this.queue.forEach(({ reject }) => reject(new Error('cancelled'))); this.queue = []; }
  }

  // === 退避状态 ===
  let backoffState = { active: false, delay: 0, resumeAt: 0, attempt: 0 };

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg?.source === 'BFM_INJECTED' && msg.type === 'backoff_status') {
      backoffState = { active: !!msg.active, delay: msg.delay || 0, resumeAt: msg.resumeAt || 0, attempt: msg.attempt || 0 };
      if (msg.active) {
        const secs = Math.ceil((msg.delay || 0) / 1000);
        log('WARNING', `⚠️ 风控退避中，等待 ${secs}s 后自动恢复（第${msg.attempt}次，触发码: ${msg.triggerCode}）`);
        updatePerfMonitor();
      } else {
        log('INFO', '✓ 风控退避已解除，恢复正常请求');
        updatePerfMonitor();
      }
    }
  });

  // === 工具函数 ===
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function nowText() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  }

  function log(level, text) {
    const box = $('#bfm-log');
    if (!box) return;
    const line = document.createElement('div');
    line.className = `bfm-log-line bfm-log-${level.toLowerCase()}`;
    line.textContent = `[${nowText()}] ${level.padEnd(7)} ${text}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
    if (state.lastParams.debug === '开启' || ['OK','WARNING','ERROR'].includes(level)) {
      console.log('[B站生态管理大师]', level, text);
    }
  }

  function setProgress(value) {
    const bar = $('#bfm-progress-inner');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  }

  function setRunning(value) {
    state.running = value;
    $$('.bfm-action').forEach(btn => {
      if (btn.dataset.allowDuringRun !== 'true') btn.disabled = value;
    });
    const stopBtn = $('#bfm-stop');
    if (stopBtn) stopBtn.disabled = !value;
    updatePerfMonitor();
  }

  function updatePerfMonitor() {
    const concEl = $('#bfm-perf-conc');
    const healthEl = $('#bfm-perf-health');
    const dotEl = $('#bfm-perf-dot');
    if (!concEl) return;
    const pool = state.activePool;
    concEl.textContent = pool ? `${pool.active}/${pool.max}` : '0/0';
    if (backoffState.active) {
      healthEl.textContent = '退避中';
      if (dotEl) dotEl.className = 'dot warning';
    } else if (state.running) {
      healthEl.textContent = '运行中';
      if (dotEl) dotEl.className = 'dot';
    } else {
      healthEl.textContent = '空闲';
      if (dotEl) dotEl.className = 'dot';
    }
  }

  function updateDashboard() {
    const total = state.follows.length;
    const analyzed = state.analyzed.length;
    const abnormal = state.analyzed.filter(x => x.isAbnormal).length;
    const ratio = analyzed > 0 ? ((abnormal / analyzed) * 100).toFixed(1) + '%' : '0%';
    const el1 = $('#bfm-dash-total');
    const el2 = $('#bfm-dash-analyzed');
    const el3 = $('#bfm-dash-abnormal');
    if (el1) el1.textContent = total;
    if (el2) el2.textContent = analyzed;
    if (el3) el3.textContent = ratio;
  }

  function normalizeNumber(value, fallback, options = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const min = options.min ?? 0;
    const v = (options.integer !== false) ? Math.floor(n) : n;
    return Math.max(min, v);
  }

  // === 存储 ===
  function localStorageGetObject(key) {
    try { return JSON.parse(window.localStorage.getItem(key)) || {}; } catch (_) { return {}; }
  }
  function localStorageSetObject(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function safeStorageGet(key) {
    return new Promise(resolve => {
      const fallback = () => resolve({ [key]: localStorageGetObject(key) });
      try {
        const api = globalThis.chrome?.storage?.local;
        if (!api?.get) return fallback();
        let done = false;
        const finish = v => { if (!done) { done = true; resolve(v || {}); } };
        const ret = api.get(key, r => { if (globalThis.chrome?.runtime?.lastError) return fallback(); finish(r || {}); });
        if (ret && typeof ret.then === 'function') ret.then(finish).catch(fallback);
        setTimeout(() => { if (!done) fallback(); }, 1200);
      } catch (_) { fallback(); }
    });
  }

  function safeStorageSet(key, value) {
    localStorageSetObject(key, value);
    try {
      const api = globalThis.chrome?.storage?.local;
      if (!api?.set) return;
      const ret = api.set({ [key]: value }, () => {});
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (_) {}
  }

  function callBackground(action, data = {}) {
    return new Promise((resolve, reject) => {
      try {
        if (!chrome?.runtime?.sendMessage) return reject(new Error('background不可用'));
        chrome.runtime.sendMessage({ action, ...data }, response => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (response?.ok) resolve(response.data);
          else reject(new Error(response?.error || '未知错误'));
        });
      } catch (err) { reject(err); }
    });
  }

  // === 参数 ===
  function getParams() {
    const p = {
      inactiveDays: normalizeNumber($('#bfm-inactiveDays')?.value, DEFAULT_PARAMS.inactiveDays, { min: 1 }),
      followAgeDays: normalizeNumber($('#bfm-followAgeDays')?.value, DEFAULT_PARAMS.followAgeDays, { min: 0 }),
      maxAnalyze: normalizeNumber($('#bfm-maxAnalyze')?.value, DEFAULT_PARAMS.maxAnalyze, { min: 0 }),
      analyzeConcurrency: normalizeNumber($('#bfm-analyzeConcurrency')?.value, DEFAULT_PARAMS.analyzeConcurrency, { min: 1 }),
      requestInterval: normalizeNumber($('#bfm-requestInterval')?.value, DEFAULT_PARAMS.requestInterval, { min: 0 }),
      groupBatch: normalizeNumber($('#bfm-groupBatch')?.value, DEFAULT_PARAMS.groupBatch, { min: 1 }),
      groupInterval: normalizeNumber($('#bfm-groupInterval')?.value, DEFAULT_PARAMS.groupInterval, { min: 0 }),
      unfollowMax: normalizeNumber($('#bfm-unfollowMax')?.value, DEFAULT_PARAMS.unfollowMax, { min: 1 }),
      unfollowInterval: normalizeNumber($('#bfm-unfollowInterval')?.value, DEFAULT_PARAMS.unfollowInterval, { min: 0 }),
      feedPages: normalizeNumber($('#bfm-feedPages')?.value, DEFAULT_PARAMS.feedPages, { min: 0 }),
      debug: $('#bfm-debug')?.value || DEFAULT_PARAMS.debug
    };
    state.lastParams = p;
    safeStorageSet(PARAM_STORAGE_KEY, p);
    return p;
  }

  async function loadParams() {
    let saved = {};
    try { saved = (await safeStorageGet(PARAM_STORAGE_KEY))[PARAM_STORAGE_KEY] || {}; } catch (_) {}
    const p = { ...DEFAULT_PARAMS, ...saved };
    Object.entries(p).forEach(([key, val]) => { const el = $(`#bfm-${key}`); if (el) el.value = val; });
    state.lastParams = p;
  }

  async function loadWhitelist() {
    try {
      const wl = await callBackground('whitelist:get');
      state.whitelist = new Map(Object.entries(wl || {}));
    } catch (_) {
      try {
        const stored = await safeStorageGet('bfm_whitelist');
        state.whitelist = new Map(Object.entries(stored.bfm_whitelist || {}));
      } catch (__) { state.whitelist = new Map(); }
    }
  }

  // === 通信 ===
  function callBili(cmd, payload = {}, timeout = 45000) {
    const id = `bfm_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', onMsg); reject(new Error(`接口超时：${cmd}`)); }, timeout);
      function onMsg(event) {
        const msg = event.data;
        if (!msg || msg.source !== 'BFM_INJECTED' || msg.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        if (msg.ok) resolve(msg.data); else reject(new Error(msg.error || `接口失败：${cmd}`));
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'BFM_CONTENT', id, cmd, payload }, '*');
    });
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
  function secondsToDate(sec) { if (!sec) return ''; const d = new Date(Number(sec) * 1000); return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`; }
  function daysSince(sec) { if (!sec) return null; return Math.max(0, Math.floor((Date.now() / 1000 - Number(sec)) / 86400)); }
  function safeTagsArray(tag) { if (Array.isArray(tag)) return tag.map(Number).filter(Number.isFinite); if (tag === null || tag === undefined || tag === '') return []; return [Number(tag)].filter(Number.isFinite); }
  function jitter(base, ratio = 0.35) { const n = Math.max(0, Number(base) || 0); return n + Math.floor(Math.random() * n * ratio); }
  function isRateLimited(value) { return /412|-412|429|-429|-352|频繁|风控|冷却|Too Many/i.test(String(value?.message || value || '')); }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

  function isProtected(mid) {
    return state.specialMids.has(Number(mid)) || state.whitelist.has(String(mid));
  }

  // === 异常账号检测 ===
  function isAbnormalAccount(user, apiResult) {
    const uname = user.uname || '';
    if (/^bili_\d{6,}$/i.test(uname)) return { abnormal: true, reason: '已注销（昵称为默认bili_xxx）' };
    const msg = apiResult?.message || '';
    if (/注销|不存在|封禁|账号异常|小黑屋/.test(msg)) return { abnormal: true, reason: `账号异常: ${msg}` };
    const code = Number(apiResult?.code);
    if ([22013, 40061].includes(code)) return { abnormal: true, reason: `已注销/封禁 (code=${code})` };
    return { abnormal: false };
  }

  // === 数据分析 ===
  function specialMidSetFromData(data) {
    const raw = Array.isArray(data) ? data : (Array.isArray(data?.list) ? data.list : []);
    return new Set(raw.map(item => Number(typeof item === 'object' ? (item.mid ?? item.fid ?? item.uid) : item)).filter(Number.isFinite));
  }

  function archiveInfo(json) {
    const data = json?.data || {};
    const page = data?.page || {};
    const vlist = data?.list?.vlist || [];
    const total = Number(page.count ?? 0);
    const first = vlist[0] || null;
    const created = Number(first?.created || first?.pubdate || 0);
    return { total: Number.isFinite(total) ? total : vlist.length, lastPub: created || 0, lastTitle: first?.title || '', lastBvid: first?.bvid || '', lastType: first?.typename || '' };
  }

  function classifyActive(user, info) {
    const text = `${user.uname || ''} ${user.sign || ''} ${info.lastTitle || ''} ${info.lastType || ''}`.toLowerCase();
    for (const rule of CATEGORY_RULES) { if (rule.words.some(w => text.includes(w.toLowerCase()))) return rule.group; }
    return '自动其他活跃';
  }

  function computeAnalysis(user, apiResult, params) {
    const mtime = Number(user.mtime || 0);
    const followAge = daysSince(mtime);
    const mid = Number(user.mid);
    const userIsProtected = isProtected(mid);
    const base = {
      ...user, mid, uname: user.uname || user.name || String(mid),
      face: user.face || '', sign: user.sign || '', mtime,
      followDate: secondsToDate(mtime), followAgeDays: followAge,
      currentTagIds: safeTagsArray(user.tag), special: Number(user.special || 0),
      isSpecial: Number(user.special || 0) === 1 || state.specialMids.has(mid),
      isWhiteListed: state.whitelist.has(String(mid)),
      localRemark: state.whitelist.get(String(mid))?.localRemark || '',
      isProtected: userIsProtected,
      status: '已分析', reason: '', candidate: false, targetGroup: '自动其他活跃',
      lastPub: 0, lastPubDate: '', lastPubDays: null, lastTitle: '', videoTotal: null,
      isAbnormal: false, rawCode: apiResult?.code, rawMessage: apiResult?.message || ''
    };

    const abnCheck = isAbnormalAccount(user, apiResult);
    if (abnCheck.abnormal) {
      base.status = '已注销/封禁'; base.reason = abnCheck.reason;
      base.targetGroup = '自动疑似异常'; base.candidate = !userIsProtected; base.isAbnormal = true;
      return base;
    }

    if (!apiResult || apiResult.code !== 0) {
      const msg = apiResult?.message || '接口异常';
      const code = apiResult?.code;
      const suspicious = [22013, 40061, -404].includes(Number(code)) || /注销|不存在|隐私|风控|账号/.test(msg);
      base.status = suspicious ? '疑似异常' : '查询异常';
      base.reason = `${msg}${code !== undefined ? ` / code=${code}` : ''}`;
      base.targetGroup = suspicious ? '自动疑似异常' : '自动其他活跃';
      base.candidate = suspicious && !userIsProtected;
      return base;
    }

    const info = archiveInfo(apiResult);
    base.videoTotal = info.total; base.lastPub = info.lastPub;
    base.lastTitle = info.lastTitle; base.lastPubDate = secondsToDate(info.lastPub);
    base.lastPubDays = daysSince(info.lastPub);

    if (!info.total || !info.lastPub) {
      base.status = '无公开投稿'; base.targetGroup = '自动无公开投稿';
      base.reason = `未见公开投稿；已关注 ${followAge ?? '-'} 天`;
      base.candidate = !userIsProtected && (followAge ?? 0) >= params.followAgeDays;
      return base;
    }

    const d = base.lastPubDays ?? 0;
    if (d >= 365) { base.status = '长期未更'; base.targetGroup = '自动一年未更'; }
    else if (d >= 180) { base.status = '长期未更'; base.targetGroup = '自动半年未更'; }
    else if (d >= params.inactiveDays) { base.status = '近期未更'; base.targetGroup = '自动近期未更'; }
    else { base.status = '活跃'; base.targetGroup = classifyActive(user, info); }

    base.reason = `${d} 天未投稿；已关注 ${followAge ?? '-'} 天`;
    base.candidate = !userIsProtected && ['自动一年未更','自动半年未更','自动近期未更'].includes(base.targetGroup) && (followAge ?? 0) >= params.followAgeDays;
    return base;
  }

  // === 动态 Feed 预过滤 ===
  async function prefetchDynamicFeed(maxPages) {
    if (!maxPages || maxPages <= 0) return new Map();
    log('INFO', `[动态预过滤] 开始获取动态 Feed，最多 ${maxPages} 页...`);
    const activeUids = new Map();
    let offset = '';

    for (let page = 1; page <= maxPages; page++) {
      if (state.stop) break;
      try {
        const payload = offset ? { offset } : { page: 1 };
        const json = await callBili('feedAll', payload, 30000);
        if (json.code !== 0) { log('WARNING', `[动态预过滤] 第${page}页失败: ${json.code}`); break; }
        const items = json.data?.items || [];
        if (!items.length) break;
        offset = json.data?.offset || '';
        for (const item of items) {
          const mid = Number(item?.modules?.module_author?.mid);
          const ts = Number(item?.modules?.module_author?.pub_ts || 0);
          if (mid && Number.isFinite(mid)) {
            const existing = activeUids.get(mid) || 0;
            if (ts > existing) activeUids.set(mid, ts);
          }
        }
        if (page % 5 === 0) log('INFO', `[动态预过滤] 已扫描${page}页，发现 ${activeUids.size} 个活跃UID`);
        await sleep(250 + Math.floor(Math.random() * 150));
        if (!offset) break;
      } catch (err) { log('WARNING', `[动态预过滤] 第${page}页异常: ${err.message}`); break; }
    }
    log('OK', `[动态预过滤] 完成，共 ${activeUids.size} 个近期活跃UID将跳过WBI请求`);
    return activeUids;
  }

  // === 带降级的投稿查询 ===
  async function callLatestArchiveWithRetry(user, params) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const json = await callBili('latestArchive', { mid: user.mid }, 60000);
        if ([-352, -412, -429].includes(Number(json?.code)) && attempt < 2) {
          const wait = 5000 * (attempt + 1) + jitter(params.requestInterval, 1.2);
          log('WARNING', `投稿查询限速：${user.uname || user.mid}，等待 ${Math.round(wait/1000)}s`);
          await sleep(wait);
          continue;
        }
        return json;
      } catch (err) {
        lastErr = err;
        if (!isRateLimited(err) || attempt === 2) break;
        const wait = 5000 * (attempt + 1) + jitter(params.requestInterval, 1.2);
        await sleep(wait);
      }
    }
    // 降级到 card API
    try {
      log('INFO', `[降级] ${user.uname || user.mid} 使用 card API`);
      const cardJson = await callBili('card', { mid: user.mid }, 30000);
      if (cardJson.code === 0) {
        return { code: 0, data: { page: { count: cardJson.data?.card?.archive_count || cardJson.data?.archive_count || 0 }, list: { vlist: [] }, _fallback: 'card' } };
      }
    } catch (_) {}
    throw lastErr || new Error('投稿查询失败');
  }

  // === 统计与渲染 ===
  function updateStats() {
    const follows = state.follows.length;
    const analyzed = state.analyzed.length;
    const candidates = state.analyzed.filter(x => x.candidate && !state.processedUnfollowMids.has(Number(x.mid))).length;
    const inactive = state.analyzed.filter(x => ['自动近期未更','自动半年未更','自动一年未更','自动无公开投稿'].includes(x.targetGroup)).length;
    const special = state.analyzed.filter(x => x.isSpecial || x.isWhiteListed).length;
    $('#bfm-stat-follow').textContent = follows;
    $('#bfm-stat-analyzed').textContent = analyzed;
    $('#bfm-stat-candidate').textContent = candidates;
    $('#bfm-stat-inactive').textContent = inactive;
    $('#bfm-stat-special').textContent = special;
    $('#bfm-selected-count').textContent = String(state.selected.size);
    updateDashboard();
    updatePerfMonitor();
  }

  function normalizeFollowRow(user) {
    const mtime = Number(user.mtime || 0);
    const mid = Number(user.mid);
    return {
      ...user, mid, uname: user.uname || user.name || String(mid), face: user.face || '', mtime,
      followDate: secondsToDate(mtime), followAgeDays: daysSince(mtime),
      currentTagIds: safeTagsArray(user.tag || user.currentTagIds), special: Number(user.special || 0),
      isSpecial: Number(user.special || 0) === 1 || state.specialMids.has(mid),
      isWhiteListed: state.whitelist.has(String(mid)),
      localRemark: state.whitelist.get(String(mid))?.localRemark || '',
      isProtected: isProtected(mid),
      status: '未分析', reason: '已读取关注列表，尚未分析最近投稿',
      candidate: false, targetGroup: '待分析', lastPubDate: '-', lastPubDays: null, lastTitle: ''
    };
  }

  function filteredRows() {
    const rawMode = state.analyzed.length === 0;
    let rows = rawMode
      ? state.follows.map(normalizeFollowRow).filter(x => !state.processedUnfollowMids.has(Number(x.mid)))
      : state.analyzed.filter(x => !state.processedUnfollowMids.has(Number(x.mid)));

    if (!rawMode) {
      if (state.filter === '候选') rows = rows.filter(x => x.candidate);
      if (state.filter === '活跃') rows = rows.filter(x => x.status === '活跃');
      if (state.filter === '不活跃') rows = rows.filter(x => ['自动近期未更','自动半年未更','自动一年未更','自动无公开投稿'].includes(x.targetGroup));
      if (state.filter === '异常') rows = rows.filter(x => x.isAbnormal || x.status === '疑似异常');
      if (state.filter === '白名单') rows = rows.filter(x => x.isWhiteListed);
    }
    if (state.filter === '特别关注') rows = rows.filter(x => x.isSpecial);

    const kw = state.search.trim().toLowerCase();
    if (kw) rows = rows.filter(x => `${x.uname} ${x.mid} ${x.targetGroup} ${x.lastTitle} ${x.reason} ${x.localRemark}`.toLowerCase().includes(kw));
    return rows;
  }

  // === 虚拟滚动引擎 ===
  class VirtualScroll {
    constructor(container, options) {
      this.container = container;
      this.rowHeight = options.rowHeight || 58;
      this.overscan = options.overscan || 8;
      this.renderRow = options.renderRow;
      this.data = [];
      this.renderedRange = { start: -1, end: -1 };
      this._init();
    }

    _init() {
      this.container.innerHTML = '';
      this.wrapper = document.createElement('div');
      this.wrapper.className = 'bfm-vs-container';
      this.spacerTop = document.createElement('div');
      this.spacerTop.className = 'bfm-vs-spacer';
      this.viewport = document.createElement('div');
      this.viewport.className = 'bfm-vs-viewport';
      this.spacerBottom = document.createElement('div');
      this.spacerBottom.className = 'bfm-vs-spacer';
      this.wrapper.appendChild(this.spacerTop);
      this.wrapper.appendChild(this.viewport);
      this.wrapper.appendChild(this.spacerBottom);
      this.container.appendChild(this.wrapper);
      this._scrollHandler = () => requestAnimationFrame(() => this._render());
      this.container.addEventListener('scroll', this._scrollHandler, { passive: true });
    }

    setData(data) {
      this.data = data;
      this.renderedRange = { start: -1, end: -1 };
      this._render();
    }

    _render() {
      const scrollTop = this.container.scrollTop;
      const viewH = this.container.clientHeight;
      const startIdx = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.overscan);
      const endIdx = Math.min(this.data.length, Math.ceil((scrollTop + viewH) / this.rowHeight) + this.overscan);

      if (startIdx === this.renderedRange.start && endIdx === this.renderedRange.end) return;
      this.renderedRange = { start: startIdx, end: endIdx };

      this.spacerTop.style.height = `${startIdx * this.rowHeight}px`;
      this.spacerBottom.style.height = `${Math.max(0, (this.data.length - endIdx) * this.rowHeight)}px`;

      const frag = document.createDocumentFragment();
      for (let i = startIdx; i < endIdx; i++) frag.appendChild(this.renderRow(this.data[i], i));
      this.viewport.innerHTML = '';
      this.viewport.appendChild(frag);
      this._bindRowEvents();
    }

    _bindRowEvents() {
      $$('.bfm-row-check', this.viewport).forEach(chk => {
        chk.addEventListener('change', () => {
          const mid = Number(chk.dataset.mid);
          if (chk.checked) state.selected.add(mid); else state.selected.delete(mid);
          updateStats();
        });
      });
      $$('.bfm-mini[data-open]', this.viewport).forEach(btn => {
        btn.addEventListener('click', () => window.open(`https://space.bilibili.com/${btn.dataset.open}`, '_blank', 'noopener'));
      });
      $$('.bfm-lock-btn', this.viewport).forEach(btn => {
        btn.addEventListener('click', async () => {
          const mid = String(btn.dataset.mid);
          if (state.whitelist.has(mid)) {
            await callBackground('whitelist:remove', { mid }).catch(() => {});
            state.whitelist.delete(mid);
            log('INFO', `已移除白名单: mid=${mid}`);
          } else {
            await callBackground('whitelist:add', { mid, remark: '' }).catch(() => {});
            state.whitelist.set(mid, { isWhiteListed: true, localRemark: '', addedAt: new Date().toISOString() });
            log('OK', `已加入白名单: mid=${mid}`);
          }
          const item = state.analyzed.find(x => String(x.mid) === mid) || state.follows.find(x => String(x.mid) === mid);
          if (item) { item.isWhiteListed = state.whitelist.has(mid); item.isProtected = isProtected(Number(mid)); }
          renderTable();
        });
      });
      $$('.bfm-remark-btn', this.viewport).forEach(btn => {
        btn.addEventListener('click', async () => {
          const mid = String(btn.dataset.mid);
          const current = state.whitelist.get(mid)?.localRemark || '';
          const remark = prompt('输入备注（留空清除）:', current);
          if (remark === null) return;
          await callBackground('remark:update', { mid, remark }).catch(() => {});
          const entry = state.whitelist.get(mid) || { isWhiteListed: false, addedAt: new Date().toISOString() };
          entry.localRemark = remark;
          state.whitelist.set(mid, entry);
          const item = state.analyzed.find(x => String(x.mid) === mid) || state.follows.find(x => String(x.mid) === mid);
          if (item) item.localRemark = remark;
          renderTable();
        });
      });
    }

    destroy() { this.container.removeEventListener('scroll', this._scrollHandler); }
  }

  let virtualScroll = null;

  function createTableRow(item) {
    const div = document.createElement('div');
    const wl = state.whitelist.has(String(item.mid));
    div.className = `bfm-vrow${item.isAbnormal ? ' abnormal' : ''}${wl ? ' whitelisted' : ''}`;
    const face = escapeHtml(item.face || '');
    const remark = item.localRemark || state.whitelist.get(String(item.mid))?.localRemark || '';
    const remarkHtml = remark ? `<span class="remark-tag" title="${escapeHtml(remark)}">${escapeHtml(remark)}</span>` : '';
    const pillClass = item.isAbnormal ? 'abnormal' : (item.candidate ? 'danger' : 'safe');
    const lockClass = wl ? 'lock-active' : '';
    div.innerHTML = `
      <div><input type="checkbox" class="bfm-row-check" data-mid="${item.mid}" ${state.selected.has(item.mid) ? 'checked' : ''} ${item.isProtected ? 'disabled title="受保护，不参与取关"' : ''}></div>
      <div class="bfm-user-cell"><img src="${face}" loading="lazy" referrerpolicy="no-referrer" alt=""><div class="info"><a href="https://space.bilibili.com/${item.mid}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.uname)}</a><small>mid: ${item.mid}${item.isSpecial ? ' ｜特别关注' : ''}${wl ? ' ｜白名单' : ''}</small>${remarkHtml}</div></div>
      <div>${escapeHtml(item.followDate || '-')}<br><small>${item.followAgeDays ?? '-'}天</small></div>
      <div>${escapeHtml(item.lastPubDate || '-')}<br><small>${item.lastPubDays ?? '-'}天未更</small></div>
      <div><span class="bfm-pill ${pillClass}">${escapeHtml(item.status)}</span><br><small title="${escapeHtml(item.lastTitle || '')}">${escapeHtml(item.reason || '')}</small></div>
      <div><span class="bfm-pill group">${escapeHtml(item.targetGroup)}</span></div>
      <div class="bfm-ops">
        <button class="bfm-mini" data-open="${item.mid}">主页</button>
        <button class="bfm-mini bfm-lock-btn ${lockClass}" data-mid="${item.mid}" title="${wl ? '移除白名单' : '加入白名单'}">🔒</button>
        <button class="bfm-mini bfm-remark-btn" data-mid="${item.mid}" title="编辑备注">📝</button>
      </div>
    `;
    return div;
  }

  function renderTable() {
    const container = $('#bfm-table-wrap');
    if (!container) return;
    const rows = filteredRows();

    if (!virtualScroll) {
      virtualScroll = new VirtualScroll(container, { rowHeight: 58, overscan: 8, renderRow: createTableRow });
    }
    virtualScroll.setData(rows);

    const modeText = state.analyzed.length === 0 && state.follows.length ? '未分析关注列表' : '分析结果';
    const infoEl = $('#bfm-table-info');
    if (infoEl) infoEl.textContent = `${modeText}：共 ${rows.length} 条，已选 ${state.selected.size}`;
  }

  // === 核心任务 ===
  async function selfCheck() {
    if (state.running) return;
    setRunning(true); state.stop = false; setProgress(0);
    try {
      getParams();
      log('INFO', '开始自检登录态、csrf、分组接口与特别关注接口。');
      const csrfResult = await callBili('csrf');
      if (csrfResult?.data?.csrf) log('OK', 'csrf 已读取。');
      else log('ERROR', 'csrf 未读取。请确认已登录B站并刷新页面。');
      const nav = await callBili('nav');
      if (nav.code === 0 && nav.data?.isLogin) {
        state.self = { mid: nav.data.mid, uname: nav.data.uname };
        log('OK', `登录态正常：${nav.data.uname} / mid=${nav.data.mid}`);
      } else { log('ERROR', `登录态异常：${nav.message || '未登录'}`); }
      const tags = await callBili('tags');
      if (tags.code === 0) log('OK', `关注分组接口正常，当前分组数：${tags.data?.length || 0}`);
      else log('WARNING', `关注分组接口异常：${tags.code}`);
      const special = await callBili('specialMids');
      if (special.code === 0) {
        state.specialMids = specialMidSetFromData(special.data);
        log('OK', `特别关注接口正常，特别关注数：${state.specialMids.size}`);
      } else { log('WARNING', `特别关注接口异常：${special.code}`); }
      await loadWhitelist();
      log('OK', `白名单已加载，共 ${state.whitelist.size} 个`);
      setProgress(100);
    } catch (err) { log('ERROR', err.message || String(err)); }
    finally { setRunning(false); }
  }

  async function readFollowings() {
    if (state.running) return;
    setRunning(true); state.stop = false; setProgress(0);
    try {
      getParams();
      const nav = await callBili('nav');
      if (!(nav.code === 0 && nav.data?.isLogin)) throw new Error('未检测到登录态，请先登录B站并刷新页面。');
      state.self = { mid: nav.data.mid, uname: nav.data.uname };
      try {
        const special = await callBili('specialMids');
        if (special.code === 0) state.specialMids = specialMidSetFromData(special.data);
      } catch (e) { log('WARNING', `特别关注列表读取失败：${e.message}`); }
      await loadWhitelist();
      state.follows = []; state.analyzed = []; state.selected.clear();
      state.processedUnfollowMids.clear(); state.unfollowRecords = [];
      virtualScroll = null;
      updateStats(); renderTable();
      log('INFO', `开始读取关注列表：${state.self.uname} / mid=${state.self.mid}`);
      let pn = 1; const ps = 50; let total = null;
      while (!state.stop) {
        const json = await callBili('followings', { vmid: state.self.mid, pn, ps }, 45000);
        if (json.code !== 0) throw new Error(`读取关注列表失败：${json.code} / ${json.message}`);
        const list = json.data?.list || [];
        total = Number(json.data?.total ?? total ?? 0);
        state.follows.push(...list.map(normalizeFollowRow));
        updateStats();
        log('INFO', `已读取 ${state.follows.length}${total ? '/'+total : ''} 个关注`);
        setProgress(total ? (state.follows.length / total) * 100 : 0);
        if (!list.length || (total && state.follows.length >= total)) break;
        pn++;
        await sleep(120);
      }
      log('OK', `关注列表读取完成，共 ${state.follows.length} 个。`);
      renderTable(); setProgress(100);
    } catch (err) { log('ERROR', err.message || String(err)); }
    finally { setRunning(false); }
  }

  async function analyzeFollowings() {
    if (state.running) return;
    const params = getParams();
    if (!state.follows.length) { log('WARNING', '请先点击"读取关注列表"。'); return; }
    setRunning(true); state.stop = false; setProgress(0);
    try {
      log('INFO', `分析参数：未更新阈值=${params.inactiveDays}天；关注超过=${params.followAgeDays}天才列候选；并发=${params.analyzeConcurrency}；间隔=${params.requestInterval}ms；动态预过滤=${params.feedPages}页`);
      const targets = params.maxAnalyze === 0 ? [...state.follows] : state.follows.slice(0, params.maxAnalyze);
      state.analyzed = []; state.selected.clear(); state.processedUnfollowMids.clear();
      virtualScroll = null; updateStats(); renderTable();

      // 动态 Feed 预过滤
      state.feedActiveUids = await prefetchDynamicFeed(params.feedPages);
      const thirtyDaysAgo = Date.now() / 1000 - 30 * 86400;

      let done = 0;
      const pool = new PromisePool(params.analyzeConcurrency);
      state.activePool = pool;
      updatePerfMonitor();

      const tasks = targets.map(user => () => (async () => {
        if (state.stop) return;
        const mid = Number(user.mid);

        // 命中动态预过滤池：直接标记活跃，跳过WBI请求
        if (state.feedActiveUids.has(mid)) {
          const ts = state.feedActiveUids.get(mid);
          const fakeResult = { code: 0, data: { page: { count: 1 }, list: { vlist: [{ created: ts, title: '(动态预过滤命中)', typename: '' }] } } };
          const result = computeAnalysis(user, fakeResult, params);
          result._feedHit = true;
          state.analyzed.push(result);
          if (result.candidate) state.selected.add(result.mid);
        } else {
          // 正常 WBI 请求（含抖动和退避）
          await sleep(jitter(params.requestInterval));
          try {
            const json = await callLatestArchiveWithRetry(user, params);
            if ([-352, -412, -429].includes(Number(json?.code))) {
              log('ERROR', `接口返回风控码 ${json.code}，已自动停止`);
              state.stop = true;
            }
            const result = computeAnalysis(user, json, params);
            state.analyzed.push(result);
            if (result.candidate) state.selected.add(result.mid);
            if (params.debug === '开启') log('OK', `分析: ${result.uname} -> ${result.targetGroup}`);
          } catch (err) {
            const result = computeAnalysis(user, { code: -999, message: err.message || String(err) }, params);
            state.analyzed.push(result);
            log('WARNING', `分析异常：${user.uname || user.mid} / ${result.reason}`);
          }
        }
        done++;
        if (done % 30 === 0 || done === targets.length) {
          updateStats(); renderTable();
          log('INFO', `进度 ${done}/${targets.length}，候选 ${state.analyzed.filter(x => x.candidate).length}，并发 ${pool.active}/${pool.max}`);
        }
        setProgress((done / targets.length) * 100);
        updatePerfMonitor();
      })());

      await Promise.all(tasks.map(t => pool.add(t)));
      state.activePool = null;
      updateStats(); renderTable();
      const feedHits = state.analyzed.filter(x => x._feedHit).length;
      if (state.stop) log('WARNING', `分析已停止：已完成 ${done}/${targets.length}`);
      else log('OK', `分析完成：已分析 ${state.analyzed.length}，候选 ${state.analyzed.filter(x => x.candidate).length}，动态预过滤命中 ${feedHits} 个（节省 ${feedHits} 次WBI请求），特别关注/白名单保护 ${state.analyzed.filter(x => x.isProtected).length}`);
      setProgress(100);
    } catch (err) { log('ERROR', err.message || String(err)); }
    finally { state.activePool = null; setRunning(false); updatePerfMonitor(); }
  }

  // === 分组操作 ===
  async function refreshTags() {
    const json = await callBili('tags');
    if (json.code !== 0) throw new Error(`查询分组失败：${json.code} / ${json.message}`);
    state.tagsByName.clear(); state.tagsById.clear();
    for (const t of json.data || []) { state.tagsByName.set(t.name, t); state.tagsById.set(Number(t.tagid), t); }
    return json.data || [];
  }

  async function ensureAutoGroups() {
    await refreshTags();
    for (const name of AUTO_GROUPS) {
      if (state.tagsByName.has(name)) continue;
      const res = await callBili('createTag', { name });
      if (res.code === 0) log('OK', `分组已创建：${name}`);
      else if (res.code === 22106) log('INFO', `分组已存在：${name}`);
      else throw new Error(`分组创建失败：${name} / ${res.code}`);
      await sleep(200);
    }
    await refreshTags();
  }

  function groupByOperation() {
    const autoIds = new Set(AUTO_GROUPS.map(n => Number(state.tagsByName.get(n)?.tagid)).filter(Number.isFinite));
    const operations = new Map(); let already = 0;
    for (const user of state.analyzed) {
      const target = state.tagsByName.get(user.targetGroup);
      if (!target) continue;
      const targetId = Number(target.tagid);
      const currentAuto = safeTagsArray(user.currentTagIds).filter(id => autoIds.has(Number(id)) && Number(id) !== -10);
      const uniqueAuto = Array.from(new Set(currentAuto));
      if (uniqueAuto.length === 1 && uniqueAuto[0] === targetId) { already++; continue; }
      let op;
      if (uniqueAuto.length > 0) op = { type: 'moveUsers', beforeTagids: uniqueAuto.join(','), afterTagids: String(targetId), targetGroup: user.targetGroup, fids: [] };
      else op = { type: 'copyUsers', tagids: String(targetId), targetGroup: user.targetGroup, fids: [] };
      const key = JSON.stringify({ type: op.type, beforeTagids: op.beforeTagids, afterTagids: op.afterTagids, tagids: op.tagids, targetGroup: op.targetGroup });
      if (!operations.has(key)) operations.set(key, op);
      operations.get(key).fids.push(user.mid);
    }
    return { operations: Array.from(operations.values()), already };
  }

  async function sendGroupOperation(op, fids, params) {
    if (!fids.length) return { ok: 0, skip: 0 };
    const payload = op.type === 'moveUsers' ? { beforeTagids: op.beforeTagids, afterTagids: op.afterTagids, fids: fids.join(',') } : { tagids: op.tagids, fids: fids.join(',') };
    const res = await callBili(op.type, payload, 60000);
    if (res.code === 0) return { ok: fids.length, skip: 0 };
    if (Number(res.code) === -352) throw new Error(`触发风控 -352：${res.message || '请暂停后再试'}`);
    if (fids.length > 1 && [22105, -400, 22104].includes(Number(res.code))) {
      log('WARNING', `${op.targetGroup} 批次返回 ${res.code}，拆分重试`);
      const mid = Math.ceil(fids.length / 2);
      const a = await sendGroupOperation(op, fids.slice(0, mid), params);
      await sleep(params.groupInterval);
      const b = await sendGroupOperation(op, fids.slice(mid), params);
      return { ok: a.ok + b.ok, skip: a.skip + b.skip };
    }
    log('WARNING', `跳过 ${fids.join(',')} -> ${op.targetGroup} / ${res.code}`);
    return { ok: 0, skip: fids.length };
  }

  async function applySingleAutoGroups() {
    if (state.running) return;
    const params = getParams();
    if (!state.analyzed.length) { log('WARNING', '请先完成分析。'); return; }
    setRunning(true); state.stop = false; setProgress(0);
    try {
      log('INFO', `分组参数：批量=${params.groupBatch}；间隔=${params.groupInterval}ms`);
      await ensureAutoGroups();
      const { operations, already } = groupByOperation();
      const total = operations.reduce((s, op) => s + op.fids.length, 0);
      log('INFO', `分组计划：已正确 ${already} 个；需处理 ${total} 个`);
      let done = 0, ok = 0, skip = 0;
      for (const op of operations) {
        if (state.stop) break;
        for (let i = 0; i < op.fids.length; i += params.groupBatch) {
          if (state.stop) break;
          const batch = op.fids.slice(i, i + params.groupBatch);
          const r = await sendGroupOperation(op, batch, params);
          ok += r.ok; skip += r.skip; done += batch.length;
          log('INFO', `${op.targetGroup}：+${batch.length}，进度 ${done}/${total}`);
          setProgress(total ? (done / total) * 100 : 100);
          await sleep(params.groupInterval);
        }
      }
      if (state.stop) log('WARNING', `分组已停止：${done}/${total}`);
      else log('OK', `唯一自动分组完成：成功 ${ok}，跳过 ${skip}，原本已正确 ${already}`);
      setProgress(100);
    } catch (err) { log('ERROR', err.message || String(err)); }
    finally { setRunning(false); }
  }

  async function syncToOfficialGroups() {
    if (state.running) return;
    if (!state.analyzed.length) { log('WARNING', '请先完成分析。'); return; }
    const params = getParams();
    setRunning(true); state.stop = false; setProgress(0);
    try {
      log('INFO', '[官方分组同步] 开始同步分析结果到B站官方分组...');
      await ensureAutoGroups();
      const groupMap = new Map();
      for (const user of state.analyzed) {
        if (!groupMap.has(user.targetGroup)) groupMap.set(user.targetGroup, []);
        groupMap.get(user.targetGroup).push(user.mid);
      }
      let totalDone = 0; const totalUsers = state.analyzed.length;
      for (const [groupName, mids] of groupMap) {
        if (state.stop) break;
        const tag = state.tagsByName.get(groupName);
        if (!tag) continue;
        for (let i = 0; i < mids.length; i += params.groupBatch) {
          if (state.stop) break;
          const batch = mids.slice(i, i + params.groupBatch);
          const res = await callBili('addUsersToTag', { fids: batch.join(','), tagids: String(tag.tagid) });
          if (res.code === 0) { totalDone += batch.length; log('OK', `[官方分组同步] ${groupName}: +${batch.length} (${totalDone}/${totalUsers})`); }
          else log('WARNING', `[官方分组同步] ${groupName} 失败: ${res.code}/${res.message}`);
          setProgress((totalDone / totalUsers) * 100);
          await sleep(params.groupInterval);
        }
      }
      log('OK', `[官方分组同步] 完成，已同步 ${totalDone} 个用户`);
      setProgress(100);
    } catch (err) { log('ERROR', err.message || String(err)); }
    finally { setRunning(false); }
  }

  // === 取关操作 ===
  function selectCurrentCandidates() {
    let count = 0;
    for (const item of filteredRows()) {
      if (item.candidate && !item.isProtected && !state.processedUnfollowMids.has(Number(item.mid))) {
        state.selected.add(item.mid); count++;
      }
    }
    updateStats(); renderTable();
    log('OK', `已勾选候选 ${count} 个；特别关注/白名单自动跳过`);
  }

  function clearSelected() { state.selected.clear(); updateStats(); renderTable(); log('INFO', '已清空勾选。'); }

  function inverseCurrentSelection() {
    let changed = 0;
    for (const item of filteredRows()) {
      const mid = Number(item.mid);
      if (item.isProtected || state.processedUnfollowMids.has(mid)) continue;
      if (state.selected.has(mid)) state.selected.delete(mid); else state.selected.add(mid);
      changed++;
    }
    updateStats(); renderTable();
    log('OK', `已反选 ${changed} 个；特别关注/白名单自动跳过`);
  }

  function isAlreadyUnfollowedResponse(res) {
    return /未关注|没有关注|不再关注|已取消|已经取消|不是关注/.test(String(res?.message || ''));
  }

  function markUnfollowProcessed(item, res, statusText) {
    const mid = Number(item.mid);
    state.processedUnfollowMids.add(mid);
    state.selected.delete(mid);
    const record = {
      mid, uname: item.uname, face: item.face || '',
      targetGroup: item.targetGroup, reason: item.reason,
      lastPubDate: item.lastPubDate, status: statusText,
      code: res?.code ?? '', message: res?.message ?? '',
      unfollowedAt: new Date().toISOString(), canRefollow: true
    };
    state.unfollowRecords.push(record);
    callBackground('history:add', { record }).catch(() => {});
    state.analyzed = state.analyzed.filter(x => Number(x.mid) !== mid);
    state.follows = state.follows.filter(x => Number(x.mid) !== mid);
  }

  async function unfollowSelected() {
    if (state.running) return;
    const params = getParams();
    if ($('#bfm-confirm')?.value.trim() !== '确认取关') { log('WARNING', '请在确认框输入：确认取关'); return; }
    const selected = state.analyzed.filter(x => state.selected.has(Number(x.mid)) && !state.processedUnfollowMids.has(Number(x.mid)));
    if (!selected.length) { log('WARNING', '当前没有可处理的勾选账号。'); updateStats(); renderTable(); return; }
    const protectedItems = selected.filter(x => x.isProtected);
    const targets = selected.filter(x => !x.isProtected).slice(0, params.unfollowMax);
    const leftAfter = Math.max(0, selected.filter(x => !x.isProtected).length - targets.length);
    if (!targets.length) {
      for (const item of protectedItems) state.selected.delete(Number(item.mid));
      updateStats(); renderTable();
      log('WARNING', `本次勾选中只有受保护账号 ${protectedItems.length} 个，已跳过`);
      return;
    }
    setRunning(true); state.stop = false; setProgress(0);
    try {
      log('INFO', `取关参数：本批最多=${params.unfollowMax}；实际=${targets.length}；间隔=${params.unfollowInterval}ms；受保护跳过=${protectedItems.length}`);
      if (leftAfter > 0) log('INFO', `本批后仍待处理 ${leftAfter} 个，再次点击继续`);
      let done = 0, ok = 0, already = 0, failed = 0;
      for (const item of targets) {
        if (state.stop) break;
        const res = await callBili('unfollow', { fid: item.mid }, 45000);
        if (res.code === 0) { ok++; log('OK', `取关成功：${item.uname}`); markUnfollowProcessed(item, res, '取关成功'); }
        else if (isAlreadyUnfollowedResponse(res)) { already++; log('OK', `已不在关注中：${item.uname}`); markUnfollowProcessed(item, res, '已不再关注'); }
        else if (Number(res.code) === -352) { log('ERROR', `触发风控 -352，已停止`); break; }
        else if ([-101, -111].includes(Number(res.code))) { failed++; log('ERROR', `登录态异常，已停止：${item.uname}`); break; }
        else { failed++; state.selected.delete(Number(item.mid)); log('WARNING', `取关失败：${item.uname} / ${res.code} / ${res.message}`); }
        done++; setProgress((done / targets.length) * 100); updateStats(); renderTable();
        await sleep(params.unfollowInterval);
      }
      for (const item of protectedItems) state.selected.delete(Number(item.mid));
      updateStats(); renderTable();
      const remaining = state.analyzed.filter(x => state.selected.has(Number(x.mid)) && !x.isProtected && !state.processedUnfollowMids.has(Number(x.mid))).length;
      if (protectedItems.length) log('OK', `受保护账号已跳过：${protectedItems.length} 个`);
      log('OK', `本批取关结束：成功 ${ok}，已不再关注 ${already}，失败 ${failed}；仍待处理 ${remaining} 个`);
      if (remaining > 0) log('INFO', '继续处理：保持"确认取关"，再次点击"取关已勾选"即可');
      setProgress(100);
    } catch (err) { log('ERROR', err.message || String(err)); }
    finally { setRunning(false); }
  }

  // === 历史面板 ===
  async function showHistoryPanel() {
    let history = [];
    try { history = await callBackground('history:get'); } catch (_) { history = state.unfollowRecords; }
    const overlay = document.createElement('div');
    overlay.className = 'bfm-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'bfm-modal';
    modal.innerHTML = `
      <div class="bfm-modal-head">
        <b>取关历史记录（共 ${history.length} 条）</b>
        <div style="display:flex;gap:8px">
          <button id="bfm-history-clear" style="border:none;background:#fee2e2;color:#dc2626;border-radius:8px;padding:6px 12px;cursor:pointer;font-weight:700;font-size:12px">清空历史</button>
          <button id="bfm-history-close" style="border:none;background:#f1f5f9;border-radius:8px;padding:6px 12px;cursor:pointer;font-weight:700;font-size:12px">关闭</button>
        </div>
      </div>
      <div class="bfm-modal-body" id="bfm-history-list"></div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const listEl = modal.querySelector('#bfm-history-list');
    if (!history.length) { listEl.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px">暂无取关记录</p>'; }
    else {
      const frag = document.createDocumentFragment();
      for (const h of history) {
        const div = document.createElement('div');
        div.className = 'bfm-history-item';
        div.innerHTML = `
          <img src="${escapeHtml(h.face || '')}" referrerpolicy="no-referrer" alt="">
          <div class="info">
            <div class="name"><a href="https://space.bilibili.com/${h.mid}" target="_blank" rel="noopener noreferrer" style="color:#0369a1;text-decoration:none">${escapeHtml(h.uname)}</a> <small style="color:#94a3b8">mid:${h.mid}</small></div>
            <div class="meta">${escapeHtml(h.targetGroup)} · ${escapeHtml(h.reason || '')} · ${h.unfollowedAt ? h.unfollowedAt.slice(0,10) : ''}</div>
          </div>
          <button class="btn-refollow" data-mid="${h.mid}" data-uname="${escapeHtml(h.uname)}" ${!h.canRefollow ? 'disabled' : ''}>${h.canRefollow ? '重新关注' : '已关注'}</button>
        `;
        frag.appendChild(div);
      }
      listEl.appendChild(frag);
      listEl.querySelectorAll('.btn-refollow').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true; btn.textContent = '处理中...';
          try {
            const res = await callBili('refollow', { fid: Number(btn.dataset.mid) });
            if (res.code === 0) { btn.textContent = '已关注'; log('OK', `重新关注成功：${btn.dataset.uname}`); await callBackground('history:markRefollowed', { mid: btn.dataset.mid }).catch(() => {}); }
            else { btn.disabled = false; btn.textContent = '重新关注'; log('ERROR', `重新关注失败：${btn.dataset.uname} / ${res.code}`); }
          } catch (err) { btn.disabled = false; btn.textContent = '重新关注'; log('ERROR', err.message); }
        });
      });
    }

    modal.querySelector('#bfm-history-close').addEventListener('click', () => overlay.remove());
    modal.querySelector('#bfm-history-clear').addEventListener('click', async () => {
      if (!confirm('确认清空所有取关历史？')) return;
      await callBackground('history:clear').catch(() => {});
      state.unfollowRecords = [];
      overlay.remove();
      log('INFO', '取关历史已清空');
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // === 导出 ===
  function exportData(type) {
    const rows = state.analyzed.length ? state.analyzed : state.follows;
    if (!rows.length) { log('WARNING', '当前没有可导出的数据。'); return; }
    const filename = `bili-follow-report-${new Date().toISOString().slice(0,10)}.${type}`;
    if (type === 'json') {
      download(filename, JSON.stringify(rows, null, 2), 'application/json;charset=utf-8');
    } else {
      const headers = ['mid','昵称','特别关注','白名单','本地备注','关注日期','已关注天数','最近投稿日期','未更新天数','状态','是否候选','唯一目标分组','原因','最近标题'];
      const lines = [headers.join(',')];
      for (const x of rows) {
        lines.push([x.mid, x.uname, x.isSpecial?'是':'否', x.isWhiteListed?'是':'否', x.localRemark||'', x.followDate||secondsToDate(x.mtime), x.followAgeDays??daysSince(x.mtime)??'', x.lastPubDate||'', x.lastPubDays??'', x.status||'', x.candidate?'是':'否', x.targetGroup||'', x.reason||'', x.lastTitle||''].map(csvEscape).join(','));
      }
      download(filename, '﻿' + lines.join('\n'), 'text/csv;charset=utf-8');
    }
    log('OK', `已导出：${filename}`);
  }

  function csvEscape(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; }
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function stopTask() { state.stop = true; if (state.activePool) state.activePool.clear(); log('WARNING', '已请求停止，正在等待当前接口返回。'); }

  // === UI 挂载 ===
  function mountUI() {
    if ($('#bfm-floating')) return;
    const btn = document.createElement('button');
    btn.id = 'bfm-floating';
    btn.innerHTML = 'B管';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'bfm-panel';
    panel.innerHTML = `
      <div class="bfm-head">
        <div>
          <b>B站关注生态管理大师 v2.0</b>
          <span>高并发防封 · 动态预过滤 · 白名单锁 · 取关后悔药 · 虚拟滚动</span>
        </div>
        <button id="bfm-close">×</button>
      </div>
      <div class="bfm-body">
        <div class="bfm-dashboard">
          <div class="bfm-dash-card">
            <b id="bfm-dash-total">0</b><span>总关注数</span>
          </div>
          <div class="bfm-dash-card">
            <b id="bfm-dash-analyzed">0</b><span>已分析数</span>
          </div>
          <div class="bfm-dash-card warn">
            <b id="bfm-dash-abnormal">0%</b><span>异常账号比例</span>
          </div>
          <div class="bfm-perf-monitor">
            <div class="bfm-perf-row"><span class="dot" id="bfm-perf-dot"></span><span>并发</span><b id="bfm-perf-conc">0/0</b></div>
            <div class="bfm-perf-row"><span>网络</span><b id="bfm-perf-health">空闲</b></div>
          </div>
        </div>
        <div class="bfm-actions">
          <button class="bfm-action" id="bfm-self">0. 自检</button>
          <button class="bfm-action primary" id="bfm-read">1. 读取关注</button>
          <button class="bfm-action primary" id="bfm-analyze">2. 分析投稿</button>
          <button class="bfm-action warn" id="bfm-stop" data-allow-during-run="true" disabled>停止</button>
          <button class="bfm-action success" id="bfm-sync-groups">同步到官方分组</button>
          <button class="bfm-action" id="bfm-history">取关历史</button>
          <button class="bfm-action" id="bfm-export-csv">导出 CSV</button>
          <button class="bfm-action" id="bfm-export-json">导出 JSON</button>
        </div>
        <div class="bfm-grid">
          <label>未更新阈值/天<input id="bfm-inactiveDays" type="number"></label>
          <label>关注超过/天才候选<input id="bfm-followAgeDays" type="number"></label>
          <label>最多分析，0=全部<input id="bfm-maxAnalyze" type="number"></label>
          <label>分析并发<input id="bfm-analyzeConcurrency" type="number"></label>
          <label>请求间隔/ms<input id="bfm-requestInterval" type="number"></label>
          <label>分组批量<input id="bfm-groupBatch" type="number"></label>
          <label>分组间隔/ms<input id="bfm-groupInterval" type="number"></label>
          <label>取关每批最多<input id="bfm-unfollowMax" type="number"></label>
          <label>取关间隔/ms<input id="bfm-unfollowInterval" type="number"></label>
          <label>动态预过滤页数<input id="bfm-feedPages" type="number"></label>
          <label>调试日志<select id="bfm-debug"><option>开启</option><option>关闭</option></select></label>
        </div>
        <p class="bfm-help">核心规则：每个UP只获得一个目标自动分组。动态预过滤可跳过30-50%的WBI请求。白名单锁与特别关注享有同等保护，批量取关时强制拦截。</p>
        <div id="bfm-progress"><div id="bfm-progress-inner"></div></div>
        <div id="bfm-log"></div>
        <div class="bfm-stats">
          <div><b id="bfm-stat-follow">0</b><span>关注总数</span></div>
          <div><b id="bfm-stat-analyzed">0</b><span>已分析</span></div>
          <div><b id="bfm-stat-candidate">0</b><span>取关候选</span></div>
          <div><b id="bfm-stat-inactive">0</b><span>不活跃</span></div>
          <div><b id="bfm-stat-special">0</b><span>特别关注/白名单</span></div>
        </div>
        <div class="bfm-actions second">
          <button id="bfm-select-candidates">勾选当前候选</button>
          <button id="bfm-inverse-selected">反选当前列表</button>
          <button id="bfm-clear-selected">清空勾选</button>
          <button class="primary" id="bfm-group">创建/应用唯一自动分组</button>
          <input id="bfm-confirm" placeholder="输入：确认取关">
          <button class="danger" id="bfm-unfollow">取关已勾选</button>
        </div>
        <p class="bfm-help">已勾选：<b id="bfm-selected-count">0</b>。取关成功的账号实时从列表移除；特别关注/白名单账号在取关阶段强制跳过。</p>
        <div class="bfm-filter">
          <select id="bfm-filter">
            <option>候选</option><option>全部</option><option>特别关注</option>
            <option>活跃</option><option>不活跃</option><option>异常</option><option>白名单</option>
          </select>
          <input id="bfm-search" placeholder="搜索昵称 / mid / 分组 / 标题 / 备注">
          <span id="bfm-table-info">共 0 条，已选 0</span>
        </div>
        <div class="bfm-table-header">
          <div>选</div><div>账号</div><div>关注时间</div><div>最近投稿</div>
          <div>状态/原因</div><div>唯一目标分组</div><div>操作</div>
        </div>
        <div class="bfm-table-wrap" id="bfm-table-wrap"></div>
      </div>
    `;
    document.body.appendChild(panel);

    btn.addEventListener('click', () => panel.classList.toggle('open'));
    $('#bfm-close').addEventListener('click', () => panel.classList.remove('open'));
    $('#bfm-self').addEventListener('click', selfCheck);
    $('#bfm-read').addEventListener('click', readFollowings);
    $('#bfm-analyze').addEventListener('click', analyzeFollowings);
    $('#bfm-stop').addEventListener('click', stopTask);
    $('#bfm-sync-groups').addEventListener('click', syncToOfficialGroups);
    $('#bfm-history').addEventListener('click', showHistoryPanel);
    $('#bfm-export-csv').addEventListener('click', () => exportData('csv'));
    $('#bfm-export-json').addEventListener('click', () => exportData('json'));
    $('#bfm-group').addEventListener('click', applySingleAutoGroups);
    $('#bfm-select-candidates').addEventListener('click', selectCurrentCandidates);
    $('#bfm-inverse-selected').addEventListener('click', inverseCurrentSelection);
    $('#bfm-clear-selected').addEventListener('click', clearSelected);
    $('#bfm-unfollow').addEventListener('click', unfollowSelected);
    $('#bfm-filter').addEventListener('change', e => { state.filter = e.target.value; renderTable(); });
    $('#bfm-search').addEventListener('input', e => { state.search = e.target.value; renderTable(); });
    $$('.bfm-grid input, .bfm-grid select').forEach(el => el.addEventListener('change', getParams));

    loadParams().then(async () => {
      await loadWhitelist();
      log('INFO', 'B站关注生态管理大师 v2.0 已加载。');
      log('INFO', '新功能：动态预过滤 · 指数退避防封 · 白名单锁 · 取关后悔药 · 虚拟滚动');
      log('INFO', '建议顺序：自检 → 读取关注 → 分析投稿 → 唯一自动分组 → 导出核对 → 取关');
    });
  }

  mountUI();
})();
