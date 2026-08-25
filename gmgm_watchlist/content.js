// Изолированный мир. Слушает сообщения от gmgn/inject.js (MAIN world)
// и сохраняет перехваченные группы через chrome.storage.
(function () {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'gmgn-watchlist-inject' || msg.type !== 'GROUPS_RESPONSE') return;
    handleGroupsResponse(msg.payload, msg.queryParams);
  });

  async function handleGroupsResponse(resBody, queryParams) {
    if (!resBody || resBody.code !== 0) return;
    const list = resBody.data && resBody.data.list;
    if (!Array.isArray(list)) return;

    const groups = list.map((g) => ({
      id: g.group_id,
      name: g.group_name,
      chain: g.chain,
      walletNums: g.wallet_nums
    }));

    const patch = { loaded: true, groups };
    if (queryParams) patch.queryParams = queryParams;

    await window.__GMGN_STORAGE__.setState(patch);
    window.dispatchEvent(new CustomEvent('gmgn-watchlist-ready'));
  }
})();
