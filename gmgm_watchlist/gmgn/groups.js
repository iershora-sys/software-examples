(function () {
  async function getGroups() {
    const state = await window.__GMGN_STORAGE__.getState();
    return (state && state.groups) || [];
  }

  // Fallback: активный запрос, если перехватить пассивно не удалось
  // (например пользователь уже был на странице до установки расширения).
  async function refreshGroups(chain = 'robinhood') {
    const { data } = await window.__GMGN_API__.request(
      '/api/v1/follow/business_group_multi_chain/list',
      { method: 'POST', body: { business_type: 'wallet', chain: [chain] } }
    );

    if (data && data.code === 0 && data.data && Array.isArray(data.data.list)) {
      const groups = data.data.list.map((g) => ({
        id: g.group_id,
        name: g.group_name,
        chain: g.chain,
        walletNums: g.wallet_nums
      }));
      await window.__GMGN_STORAGE__.setState({ loaded: true, groups });
      window.dispatchEvent(new CustomEvent('gmgn-watchlist-ready'));
      return groups;
    }
    return [];
  }

  window.__GMGN_GROUPS__ = { getGroups, refreshGroups };
})();
