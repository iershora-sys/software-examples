// Изолированный мир контент-скрипта. chrome.storage доступен напрямую.
(function () {
  const KEY = 'gmgn';

  async function getState() {
    const res = await chrome.storage.local.get(KEY);
    return res[KEY] || null;
  }

  async function setState(patch) {
    const current = (await getState()) || {};
    const next = Object.assign({}, current, patch, { updated: Date.now() });
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  window.__GMGN_STORAGE__ = { getState, setState, KEY };
})();
