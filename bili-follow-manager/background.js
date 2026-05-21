(() => {
  'use strict';

  const STORAGE_KEYS = {
    WHITELIST: 'bfm_whitelist',
    HISTORY: 'bfm_unfollow_history',
    TASK_STATE: 'bfm_task_state',
    PARAMS: 'bfmParamsSafeV2'
  };

  const HISTORY_MAX = 5000;

  async function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  async function storageSet(data) {
    return chrome.storage.local.set(data);
  }

  async function getWhitelist() {
    const result = await storageGet([STORAGE_KEYS.WHITELIST]);
    return result[STORAGE_KEYS.WHITELIST] || {};
  }

  async function addToWhitelist(mid, remark = '') {
    const wl = await getWhitelist();
    wl[String(mid)] = {
      isWhiteListed: true,
      localRemark: remark,
      addedAt: new Date().toISOString()
    };
    await storageSet({ [STORAGE_KEYS.WHITELIST]: wl });
    return wl;
  }

  async function removeFromWhitelist(mid) {
    const wl = await getWhitelist();
    delete wl[String(mid)];
    await storageSet({ [STORAGE_KEYS.WHITELIST]: wl });
    return wl;
  }

  async function updateRemark(mid, remark) {
    const wl = await getWhitelist();
    const key = String(mid);
    if (wl[key]) {
      wl[key].localRemark = remark;
    } else {
      wl[key] = { isWhiteListed: false, localRemark: remark, addedAt: new Date().toISOString() };
    }
    await storageSet({ [STORAGE_KEYS.WHITELIST]: wl });
    return wl;
  }

  async function getUnfollowHistory() {
    const result = await storageGet([STORAGE_KEYS.HISTORY]);
    return result[STORAGE_KEYS.HISTORY] || [];
  }

  async function addUnfollowRecord(record) {
    const history = await getUnfollowHistory();
    history.unshift({
      ...record,
      unfollowedAt: record.unfollowedAt || new Date().toISOString(),
      canRefollow: true
    });
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    await storageSet({ [STORAGE_KEYS.HISTORY]: history });
    return history;
  }

  async function markRefollowed(mid) {
    const history = await getUnfollowHistory();
    const entry = history.find(h => Number(h.mid) === Number(mid));
    if (entry) {
      entry.canRefollow = false;
      entry.refollowedAt = new Date().toISOString();
      await storageSet({ [STORAGE_KEYS.HISTORY]: history });
    }
    return history;
  }

  async function clearUnfollowHistory() {
    await storageSet({ [STORAGE_KEYS.HISTORY]: [] });
    return [];
  }

  async function saveTaskState(state) {
    await storageSet({ [STORAGE_KEYS.TASK_STATE]: { ...state, savedAt: new Date().toISOString() } });
  }

  async function loadTaskState() {
    const result = await storageGet([STORAGE_KEYS.TASK_STATE]);
    return result[STORAGE_KEYS.TASK_STATE] || null;
  }

  async function clearTaskState() {
    await chrome.storage.local.remove(STORAGE_KEYS.TASK_STATE);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { action } = message;
    let promise;

    switch (action) {
      case 'whitelist:get':
        promise = getWhitelist();
        break;
      case 'whitelist:add':
        promise = addToWhitelist(message.mid, message.remark);
        break;
      case 'whitelist:remove':
        promise = removeFromWhitelist(message.mid);
        break;
      case 'remark:update':
        promise = updateRemark(message.mid, message.remark);
        break;
      case 'history:get':
        promise = getUnfollowHistory();
        break;
      case 'history:add':
        promise = addUnfollowRecord(message.record);
        break;
      case 'history:markRefollowed':
        promise = markRefollowed(message.mid);
        break;
      case 'history:clear':
        promise = clearUnfollowHistory();
        break;
      case 'task:save':
        promise = saveTaskState(message.state);
        break;
      case 'task:load':
        promise = loadTaskState();
        break;
      case 'task:clear':
        promise = clearTaskState();
        break;
      default:
        sendResponse({ error: `未知操作: ${action}` });
        return false;
    }

    promise
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));

    return true;
  });

  chrome.alarms.create('bfm-keepalive', { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'bfm-keepalive') {
      // no-op: keeps service worker alive during long tasks
    }
  });
})();
