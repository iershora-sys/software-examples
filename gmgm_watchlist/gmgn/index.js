// Изолированный мир. Собирает единый window.GMGN API.
// Доступен любым другим контент-скриптам этого расширения на этой странице.
(function () {
  let readyResolve;
  let resolved = false;
  const readyPromise = new Promise((resolve) => {
    readyResolve = resolve;
  });

  function resolveReady(groups) {
    if (resolved) return;
    resolved = true;
    window.__GMGN_LAST_GROUPS__ = groups || [];
    readyResolve(window.__GMGN_LAST_GROUPS__);
  }

  // Если группы уже были сохранены раньше (прошлый визит) - резолвим сразу.
  window.__GMGN_STORAGE__.getState().then((state) => {
    if (state && state.loaded) {
      resolveReady(state.groups);
    } else {
      window.__GMGN_LAST_GROUPS__ = [];
    }
  });

  // Свежий перехват на этой странице.
  window.addEventListener('gmgn-watchlist-ready', async () => {
    const state = await window.__GMGN_STORAGE__.getState();
    resolveReady(state ? state.groups : []);
  });

  window.GMGN = {
    // Дожидается первого набора групп (из кэша или из перехвата на этой странице)
    ready: () => readyPromise,
    // Синхронный снэпшот последних известных групп (может быть пустым до ready())
    get groups() {
      return window.__GMGN_LAST_GROUPS__ || [];
    },
    // Принудительно перезапросить группы у GMGN (fallback, если пассивный перехват не сработал)
    refreshGroups: (chain) => window.__GMGN_GROUPS__.refreshGroups(chain),
    // Подписать кошелек (по умолчанию - в группу "default")
    follow: (walletAddress, opts) => window.__GMGN_FOLLOW__.follow(walletAddress, opts),
    // Отписать кошелек
    unfollow: (walletAddress, opts) => window.__GMGN_FOLLOW__.unfollow(walletAddress, opts),
    // Задать имя + цвет метки кошелька (remark_wallet_v2)
    remark: (walletAddress, name, color, opts) => window.__GMGN_FOLLOW__.remark(walletAddress, name, color, opts),
    // Эмодзи кошелька (remark_wallet_v2, operation_type:'emoji').
    setEmoji: (walletAddress, emoji, opts) => window.__GMGN_FOLLOW__.setEmoji(walletAddress, emoji, opts),
    // Оповещения кошелька (follow_alert): {toast, feed, bubble, sound}.
    setAlerts: (walletAddress, alerts, opts) => window.__GMGN_FOLLOW__.setAlerts(walletAddress, alerts, opts),
    // follow() + remark() + эмодзи + оповещения одним вызовом — для пакетного добавления в вачлист.
    // opts.groupName — имя группы, введённое руками; opts.groupIds — если id уже известны.
    addToWatchlist: (walletAddress, opts) => window.__GMGN_FOLLOW__.addToWatchlist(walletAddress, opts),
    // Имя группы -> [group_id]. Бросает ошибку со списком доступных, если имени нет.
    resolveGroupIdsByName: (groupName, chain) => window.__GMGN_FOLLOW__.resolveGroupIdsByName(groupName, chain),
    // Сырое состояние из chrome.storage.local (для отладки)
    getState: () => window.__GMGN_STORAGE__.getState()
  };
})();
