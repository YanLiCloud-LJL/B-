(() => {
  'use strict';

  if (window.__BILI_FOLLOW_MANAGER_INJECTED__) return;
  window.__BILI_FOLLOW_MANAGER_INJECTED__ = true;

  const API = 'https://api.bilibili.com';
  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45,
    35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
    41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60,
    51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52
  ];

  let wbiCache = null;
  let wbiLockPromise = null;

  // === 指数退避引擎 ===
  const backoff = {
    active: false,
    attempt: 0,
    maxAttempt: 8,
    baseDelay: 1000,
    maxDelay: 120000,
    cooldownUntil: 0,
    jitterRange: 300
  };

  function getBackoffDelay() {
    const delay = Math.min(backoff.baseDelay * Math.pow(2, backoff.attempt), backoff.maxDelay);
    return delay + Math.floor(Math.random() * backoff.jitterRange);
  }

  function triggerBackoff(code) {
    backoff.active = true;
    backoff.attempt = Math.min(backoff.attempt + 1, backoff.maxAttempt);
    const delay = getBackoffDelay();
    backoff.cooldownUntil = Date.now() + delay;
    window.postMessage({
      source: 'BFM_INJECTED',
      type: 'backoff_status',
      active: true,
      delay,
      resumeAt: backoff.cooldownUntil,
      attempt: backoff.attempt,
      triggerCode: code
    }, '*');
    return delay;
  }

  function resetBackoff() {
    if (backoff.active || backoff.attempt > 0) {
      backoff.active = false;
      backoff.attempt = 0;
      backoff.cooldownUntil = 0;
      window.postMessage({
        source: 'BFM_INJECTED',
        type: 'backoff_status',
        active: false,
        attempt: 0
      }, '*');
    }
  }

  // === 基础工具 ===
  function getCookie(name) {
    const arr = document.cookie ? document.cookie.split('; ') : [];
    for (const item of arr) {
      const idx = item.indexOf('=');
      const key = idx >= 0 ? item.slice(0, idx) : item;
      const val = idx >= 0 ? item.slice(idx + 1) : '';
      if (key === name) return decodeURIComponent(val);
    }
    return '';
  }

  function csrf() { return getCookie('bili_jct'); }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  // === 网络层（含退避 + 抖动） ===
  async function fetchJson(url, options = {}) {
    const wait = backoff.cooldownUntil - Date.now();
    if (wait > 0) await sleep(wait);

    await sleep(Math.floor(Math.random() * backoff.jitterRange));

    const res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      ...options,
      headers: { ...(options.headers || {}) }
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      if (res.status === 412 || res.status === 429) {
        const delay = triggerBackoff(res.status);
        throw new Error(`接口频率受限：HTTP ${res.status}，退避 ${Math.round(delay / 1000)}s`);
      }
      throw new Error(`接口返回不是JSON：HTTP ${res.status} / ${text.slice(0, 120)}`);
    }

    const code = Number(json?.code);
    if (res.status === 412 || res.status === 429 || [-412, -429, -352].includes(code)) {
      triggerBackoff(code || res.status);
    } else if (json?.code === 0) {
      resetBackoff();
    }

    return json;
  }

  function queryString(params) {
    const sp = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    });
    return sp.toString();
  }

  async function get(path, params = {}) {
    const qs = queryString(params);
    return fetchJson(`${API}${path}${qs ? '?' + qs : ''}`);
  }

  async function post(path, params = {}) {
    const body = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
    });
    return fetchJson(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body
    });
  }

  // === WBI 签名 ===
  async function getNav() { return get('/x/web-interface/nav'); }

  async function getWbiKeys() {
    const now = Date.now();
    if (wbiCache && now - wbiCache.time < 5 * 60 * 60 * 1000) return wbiCache;
    if (wbiLockPromise) return wbiLockPromise;

    wbiLockPromise = (async () => {
      try {
        const nav = await getNav();
        const imgUrl = nav?.data?.wbi_img?.img_url || '';
        const subUrl = nav?.data?.wbi_img?.sub_url || '';
        const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1, imgUrl.lastIndexOf('.'));
        const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1, subUrl.lastIndexOf('.'));
        if (!imgKey || !subKey) throw new Error('WBI key 获取失败');
        wbiCache = { imgKey, subKey, time: Date.now() };
        return wbiCache;
      } finally {
        wbiLockPromise = null;
      }
    })();
    return wbiLockPromise;
  }

  function getMixinKey(orig) {
    return MIXIN_KEY_ENC_TAB.map(n => orig[n]).join('').slice(0, 32);
  }

  function signedQuery(params, imgKey, subKey) {
    const mixinKey = getMixinKey(imgKey + subKey);
    const normalized = { ...params, wts: Math.round(Date.now() / 1000) };
    const chrFilter = /[!'()*]/g;
    const query = Object.keys(normalized)
      .sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(normalized[key]).replace(chrFilter, ''))}`)
      .join('&');
    return `${query}&w_rid=${md5(query + mixinKey)}`;
  }

  async function wbiGet(path, params = {}) {
    const keys = await getWbiKeys();
    const qs = signedQuery(params, keys.imgKey, keys.subKey);
    return fetchJson(`${API}${path}?${qs}`);
  }

  // === API 端点 ===
  async function getFollowings(payload) {
    return get('/x/relation/followings', {
      vmid: payload.vmid, pn: payload.pn || 1, ps: payload.ps || 50,
      order: 'desc', order_type: 'attention'
    });
  }

  async function getLatestArchive(payload) {
    return wbiGet('/x/space/wbi/arc/search', {
      mid: payload.mid, pn: 1, ps: 1, order: 'pubdate',
      platform: 'web', web_location: 1550101
    });
  }

  async function getFeedAll(payload) {
    const params = { type: 'all' };
    if (payload.offset) params.offset = payload.offset;
    if (payload.page) params.page = payload.page;
    return get('/x/polymer/web-dynamic/v1/portal/feed/all', params);
  }

  async function getCard(payload) {
    return get('/x/web-interface/card', { mid: payload.mid, photo: 0 });
  }

  async function getTags() { return get('/x/relation/tags'); }

  async function createTag(payload) {
    return post('/x/relation/tag/create', { tag: payload.name, csrf: csrf() });
  }

  async function copyUsers(payload) {
    return post('/x/relation/tags/copyUsers', { fids: payload.fids, tagids: payload.tagids, csrf: csrf() });
  }

  async function moveUsers(payload) {
    return post('/x/relation/tags/moveUsers', {
      beforeTagids: payload.beforeTagids, afterTagids: payload.afterTagids,
      fids: payload.fids, csrf: csrf()
    });
  }

  async function addUsersToTag(payload) {
    return post('/x/relation/tags/addUsers', { fids: payload.fids, tagids: payload.tagids, csrf: csrf() });
  }

  async function unfollow(payload) {
    return post('/x/relation/modify', { fid: payload.fid, act: 2, re_src: 11, csrf: csrf() });
  }

  async function refollow(payload) {
    return post('/x/relation/modify', { fid: payload.fid, act: 1, re_src: 11, csrf: csrf() });
  }

  async function relations(payload) {
    return get('/x/relation/relations', { fids: payload.fids });
  }

  async function specialMids() { return get('/x/relation/tag/special'); }

  // === 命令路由 ===
  async function handle(cmd, payload) {
    switch (cmd) {
      case 'csrf': return { code: 0, data: { csrf: csrf() } };
      case 'nav': return getNav();
      case 'followings': return getFollowings(payload || {});
      case 'latestArchive': return getLatestArchive(payload || {});
      case 'feedAll': return getFeedAll(payload || {});
      case 'card': return getCard(payload || {});
      case 'tags': return getTags();
      case 'createTag': return createTag(payload || {});
      case 'copyUsers': return copyUsers(payload || {});
      case 'moveUsers': return moveUsers(payload || {});
      case 'addUsersToTag': return addUsersToTag(payload || {});
      case 'unfollow': return unfollow(payload || {});
      case 'refollow': return refollow(payload || {});
      case 'relations': return relations(payload || {});
      case 'specialMids': return specialMids();
      case 'sleep': await sleep(payload?.ms || 0); return { code: 0, message: 'ok' };
      default: throw new Error(`未知命令：${cmd}`);
    }
  }

  window.addEventListener('message', async event => {
    const msg = event.data;
    if (!msg || msg.source !== 'BFM_CONTENT' || !msg.id || !msg.cmd) return;
    try {
      const data = await handle(msg.cmd, msg.payload || {});
      window.postMessage({ source: 'BFM_INJECTED', id: msg.id, ok: true, data }, '*');
    } catch (err) {
      window.postMessage({ source: 'BFM_INJECTED', id: msg.id, ok: false, error: String(err?.message || err) }, '*');
    }
  });

  // === MD5 (WBI签名用) ===
  function md5(input) {
    function rotateLeft(v, s) { return (v << s) | (v >>> (32 - s)); }
    function addUnsigned(x, y) {
      const x4 = (x & 0x40000000), y4 = (y & 0x40000000);
      const x8 = (x & 0x80000000), y8 = (y & 0x80000000);
      const r = (x & 0x3FFFFFFF) + (y & 0x3FFFFFFF);
      if (x4 & y4) return (r ^ 0x80000000 ^ x8 ^ y8);
      if (x4 | y4) return (r & 0x40000000) ? (r ^ 0xC0000000 ^ x8 ^ y8) : (r ^ 0x40000000 ^ x8 ^ y8);
      return (r ^ x8 ^ y8);
    }
    function F(x, y, z) { return (x & y) | ((~x) & z); }
    function G(x, y, z) { return (x & z) | (y & (~z)); }
    function H(x, y, z) { return (x ^ y ^ z); }
    function I(x, y, z) { return (y ^ (x | (~z))); }
    function FF(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac)), s), b); }
    function GG(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac)), s), b); }
    function HH(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac)), s), b); }
    function II(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac)), s), b); }
    function utf8Encode(s) { return unescape(encodeURIComponent(s)); }
    function convertToWordArray(str) {
      str = utf8Encode(str);
      const len = str.length;
      const nw = (((len + 8 - ((len + 8) % 64)) / 64) + 1) * 16;
      const wa = new Array(nw).fill(0);
      for (let i = 0; i < len; i++) wa[(i - (i % 4)) / 4] |= (str.charCodeAt(i) << ((i % 4) * 8));
      wa[(len - (len % 4)) / 4] |= (0x80 << ((len % 4) * 8));
      wa[nw - 2] = len << 3;
      wa[nw - 1] = len >>> 29;
      return wa;
    }
    function wordToHex(v) {
      let s = '';
      for (let i = 0; i <= 3; i++) { const b = '0' + ((v >>> (i * 8)) & 255).toString(16); s += b.substr(b.length - 2, 2); }
      return s;
    }
    const x = convertToWordArray(input);
    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    for (let k = 0; k < x.length; k += 16) {
      const AA = a, BB = b, CC = c, DD = d;
      a=FF(a,b,c,d,x[k+0],7,0xD76AA478);d=FF(d,a,b,c,x[k+1],12,0xE8C7B756);c=FF(c,d,a,b,x[k+2],17,0x242070DB);b=FF(b,c,d,a,x[k+3],22,0xC1BDCEEE);
      a=FF(a,b,c,d,x[k+4],7,0xF57C0FAF);d=FF(d,a,b,c,x[k+5],12,0x4787C62A);c=FF(c,d,a,b,x[k+6],17,0xA8304613);b=FF(b,c,d,a,x[k+7],22,0xFD469501);
      a=FF(a,b,c,d,x[k+8],7,0x698098D8);d=FF(d,a,b,c,x[k+9],12,0x8B44F7AF);c=FF(c,d,a,b,x[k+10],17,0xFFFF5BB1);b=FF(b,c,d,a,x[k+11],22,0x895CD7BE);
      a=FF(a,b,c,d,x[k+12],7,0x6B901122);d=FF(d,a,b,c,x[k+13],12,0xFD987193);c=FF(c,d,a,b,x[k+14],17,0xA679438E);b=FF(b,c,d,a,x[k+15],22,0x49B40821);
      a=GG(a,b,c,d,x[k+1],5,0xF61E2562);d=GG(d,a,b,c,x[k+6],9,0xC040B340);c=GG(c,d,a,b,x[k+11],14,0x265E5A51);b=GG(b,c,d,a,x[k+0],20,0xE9B6C7AA);
      a=GG(a,b,c,d,x[k+5],5,0xD62F105D);d=GG(d,a,b,c,x[k+10],9,0x02441453);c=GG(c,d,a,b,x[k+15],14,0xD8A1E681);b=GG(b,c,d,a,x[k+4],20,0xE7D3FBC8);
      a=GG(a,b,c,d,x[k+9],5,0x21E1CDE6);d=GG(d,a,b,c,x[k+14],9,0xC33707D6);c=GG(c,d,a,b,x[k+3],14,0xF4D50D87);b=GG(b,c,d,a,x[k+8],20,0x455A14ED);
      a=GG(a,b,c,d,x[k+13],5,0xA9E3E905);d=GG(d,a,b,c,x[k+2],9,0xFCEFA3F8);c=GG(c,d,a,b,x[k+7],14,0x676F02D9);b=GG(b,c,d,a,x[k+12],20,0x8D2A4C8A);
      a=HH(a,b,c,d,x[k+5],4,0xFFFA3942);d=HH(d,a,b,c,x[k+8],11,0x8771F681);c=HH(c,d,a,b,x[k+11],16,0x6D9D6122);b=HH(b,c,d,a,x[k+14],23,0xFDE5380C);
      a=HH(a,b,c,d,x[k+1],4,0xA4BEEA44);d=HH(d,a,b,c,x[k+4],11,0x4BDECFA9);c=HH(c,d,a,b,x[k+7],16,0xF6BB4B60);b=HH(b,c,d,a,x[k+10],23,0xBEBFBC70);
      a=HH(a,b,c,d,x[k+13],4,0x289B7EC6);d=HH(d,a,b,c,x[k+0],11,0xEAA127FA);c=HH(c,d,a,b,x[k+3],16,0xD4EF3085);b=HH(b,c,d,a,x[k+6],23,0x04881D05);
      a=HH(a,b,c,d,x[k+9],4,0xD9D4D039);d=HH(d,a,b,c,x[k+12],11,0xE6DB99E5);c=HH(c,d,a,b,x[k+15],16,0x1FA27CF8);b=HH(b,c,d,a,x[k+2],23,0xC4AC5665);
      a=II(a,b,c,d,x[k+0],6,0xF4292244);d=II(d,a,b,c,x[k+7],10,0x432AFF97);c=II(c,d,a,b,x[k+14],15,0xAB9423A7);b=II(b,c,d,a,x[k+5],21,0xFC93A039);
      a=II(a,b,c,d,x[k+12],6,0x655B59C3);d=II(d,a,b,c,x[k+3],10,0x8F0CCC92);c=II(c,d,a,b,x[k+10],15,0xFFEFF47D);b=II(b,c,d,a,x[k+1],21,0x85845DD1);
      a=II(a,b,c,d,x[k+8],6,0x6FA87E4F);d=II(d,a,b,c,x[k+15],10,0xFE2CE6E0);c=II(c,d,a,b,x[k+6],15,0xA3014314);b=II(b,c,d,a,x[k+13],21,0x4E0811A1);
      a=II(a,b,c,d,x[k+4],6,0xF7537E82);d=II(d,a,b,c,x[k+11],10,0xBD3AF235);c=II(c,d,a,b,x[k+2],15,0x2AD7D2BB);b=II(b,c,d,a,x[k+9],21,0xEB86D391);
      a=addUnsigned(a,AA);b=addUnsigned(b,BB);c=addUnsigned(c,CC);d=addUnsigned(d,DD);
    }
    return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
  }
})();
