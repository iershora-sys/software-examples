(function () {
  // Ждёт появления непустого списка групп в chrome.storage.local (пишет
  // его content.js любой вкладки после пассивного перехвата
  // business_group_multi_chain/list — storage общий на всё расширение,
  // не важно, в какой вкладке произошёл перехват).
  function gwWaitForGroups(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;

      function finish(groups) {
        if (done) return;
        done = true;
        chrome.storage.onChanged.removeListener(listener);
        clearTimeout(timer);
        resolve(groups || []);
      }

      function listener(changes, area) {
        if (area !== 'local' || !changes.gmgn) return;
        const next = changes.gmgn.newValue;
        if (next && next.loaded && Array.isArray(next.groups) && next.groups.length) {
          finish(next.groups);
        }
      }

      chrome.storage.onChanged.addListener(listener);
      timer = setTimeout(() => finish([]), timeoutMs);

      // На случай если группы появились ровно между refreshGroups() и
      // подпиской на onChanged — проверяем ещё раз сразу.
      window.__GMGN_STORAGE__.getState().then((state) => {
        if (state && state.loaded && Array.isArray(state.groups) && state.groups.length) {
          finish(state.groups);
        }
      });
    });
  }

  // GMGN возвращает группы business_group_multi_chain/list СРАЗУ для
  // нескольких business-чейнов (например default/sol + default/evm), даже
  // если в запросе просили только chain:["robinhood"] (см. скриншот
  // сайдбара — 2 записи "default"). Простое ".find(name==='default')"
  // могло схватить группу НЕ того чейна, в зависимости от порядка в
  // ответе API — тихий баг, который бы сработал через раз. chain=
  // "robinhood" на бэкенде маппится на group.chain === "evm".
  // По аналогии остальные EVM-сети (bsc/base/eth/arbitrum) маппятся туда
  // же — на стороне GMGN это одна "business chain" категория evm.
  const CHAIN_TO_GROUP_CHAIN = {
    robinhood: 'evm',
    bsc: 'evm',
    base: 'evm',
    eth: 'evm',
    arbitrum: 'evm',
  };

  function pickDefaultGroup(groups, chain) {
    const wantChain = CHAIN_TO_GROUP_CHAIN[chain] || chain;
    return (
      groups.find((g) => g.name === 'default' && g.chain === wantChain) ||
      groups.find((g) => g.chain === wantChain) ||
      groups.find((g) => g.name === 'default') ||
      groups[0]
    );
  }

  async function follow(walletAddress, { chain = 'robinhood', groupIds } = {}) {
    let ids = groupIds;
    if (!ids || !ids.length) {
      // Намеренно НЕ читаем закэшированный список группы (getGroups()) —
      // всегда дергаем свежий refreshGroups() прямо перед follow. Баг:
      // "Invalid group" (P_GMGN_IN_INVALID_ARGUMENT) на второй попытке
      // добавить кошелек — закэшированный group_id к этому моменту мог
      // разойтись с текущим состоянием на бэкенде GMGN.
      let groups = await window.__GMGN_GROUPS__.refreshGroups(chain);

      if (!groups.length) {
        // Групп нет вообще (например authHeaders ещё не пойманы, или это
        // вообще первый запуск и /follow ни разу не открывался). Вместо
        // немедленной ошибки — просим фон открыть /follow?chain=robinhood
        // в новой вкладке и ждём, пока пассивный перехват их поймает
        // (chrome.tabs недоступен из content script, поэтому через
        // сообщение в background.js).
        try {
          await chrome.runtime.sendMessage({ type: 'gw-bootstrap-now' });
        } catch (e) {
          // Фон мог быть неактивен/перезапускается — не критично, всё
          // равно попробуем дождаться групп ниже (могут появиться и без
          // этого запроса, если перехват уже случился в другой вкладке).
        }
        groups = await gwWaitForGroups(25000);
      }

      const def = pickDefaultGroup(groups, chain);
      if (!def) {
        throw new Error(
          'GMGN: группы так и не удалось получить за 25с. ' +
          'Открылась вкладка https://gmgn.ai/follow?chain=robinhood — проверьте, что вы залогинены, и повторите.'
        );
      }
      ids = [def.id];
    }

    const result = await window.__GMGN_API__.request('/api/v1/follow/follow_wallet', {
      method: 'POST',
      body: {
        chain,
        group_ids: ids,
        remark_addresses: [],
        wallet_addresses: [walletAddress]
      }
    });

    // group_ids в ответе — чтобы при ошибке сразу было видно, какой ID
    // реально ушел на сервер (без необходимости лезть в devtools).
    return { ...result, group_ids: ids };
  }

  // Подтверждено дампом: unfollow_wallet не требует group_ids, но дублирует
  // адрес в двух полях (address + wallet_addresses) и добавляет network
  // (равен chain во всех примерах из дампа).
  async function unfollow(walletAddress, { chain = 'robinhood', network } = {}) {
    return window.__GMGN_API__.request('/api/v1/follow/unfollow_wallet', {
      method: 'POST',
      body: {
        address: walletAddress,
        chain,
        network: network || chain,
        remark_addresses: [],
        wallet_addresses: [walletAddress]
      }
    });
  }

  // Подтверждено дампом (remark_wallet_v2): именование + цвет метки кошелька.
  // remark_addresses — массив ТРОЕК [address, name, colorHex], не массив
  // объектов. resBody возвращает remark_wallets[].remark_name_color и т.п.
  async function remark(walletAddress, name, color, { chain = 'robinhood' } = {}) {
    return window.__GMGN_API__.request('/api/v1/remark_wallet_v2', {
      method: 'POST',
      body: {
        chain,
        operation_type: 'name',
        remark_addresses: [[walletAddress, name || '', color || '']]
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Эмодзи и оповещения кошелька (v1.19.0).
  //
  // Формы запросов сняты не наугад, а из фронтенд-бандла gmgn.ai
  // (_next/static/chunks) — там же, где живёт их собственный UI:
  //
  //   эмодзи  — enum operation_type = {Name:"name", Emoji:"emoji", Image:"image"},
  //             вызов: hF({chain, remark_addresses:[[addr, emoji]],
  //                        operation_type: SP.Emoji}) -> POST /api/v1/remark_wallet_v2
  //             ВАЖНО: тройка [addr, name, color] тут превращается в ПАРУ
  //             [addr, emoji] — третьего элемента нет, это не цвет.
  //
  //   алерты  — W = POST /api/v1/follow/follow_alert, тело плоское:
  //             {chain, wallet_address, <поле>: bool}. Их UI дёргает по
  //             одному полю на клик (K/V/H/ug), но собственный импортёр
  //             GMGN собирает те же поля в ОДИН объект wallet_settings на
  //             адрес — значит бэкенд понимает и комбинацию, шлём разом.
  //
  // Соответствие полей взято из импортёра GMGN — он уже умеет читать
  // формат трекинг-бота, и это его же таблица:
  //   alertsOnToast  -> tips_alert_enabled    (Toast Notif)
  //   alertsOnFeed   -> tg_alert_enabled      (Feed Alerts)
  //   alertsOnBubble -> kline_avatar_enabled  (аватар на графике)
  //   sound (непустой) -> sound_alert_enabled
  // ─────────────────────────────────────────────────────────────────────────
  async function setEmoji(walletAddress, emoji, { chain = 'robinhood' } = {}) {
    return window.__GMGN_API__.request('/api/v1/remark_wallet_v2', {
      method: 'POST',
      body: {
        chain,
        operation_type: 'emoji',
        remark_addresses: [[walletAddress, emoji || '']]
      }
    });
  }

  async function setAlerts(walletAddress, alerts, { chain = 'robinhood' } = {}) {
    const body = { chain, wallet_address: walletAddress };
    // Только явно заданные поля: undefined означает "не трогать текущее
    // значение", а не "выключить". Иначе добавление кошелька гасило бы
    // настройки, которых пользователь в панели вообще не касался.
    if (typeof alerts.toast === 'boolean') body.tips_alert_enabled = alerts.toast;
    if (typeof alerts.feed === 'boolean') body.tg_alert_enabled = alerts.feed;
    if (typeof alerts.bubble === 'boolean') body.kline_avatar_enabled = alerts.bubble;
    if (typeof alerts.sound === 'string') {
      body.sound_alert_enabled = alerts.sound !== '';
      if (alerts.sound) body.sound_setting = alerts.sound;
    }
    // Кроме chain/wallet_address ничего не набралось — запрос был бы пустым.
    if (Object.keys(body).length <= 2) return null;

    return window.__GMGN_API__.request('/api/v1/follow/follow_alert', {
      method: 'POST',
      body
    });
  }

  // Пакетное добавление в вачлист: follow() + remark() одним вызовом на
  // кошелёк. follow — обязательное условие успеха; remark — best-effort
  // (если упал, follow всё равно засчитан, чтобы при повторном клике
  // "Добавить" не пытаться подписаться на уже подписанный кошелёк заново —
  // это может само по себе вернуть ошибку от GMGN).
  // Ищет группы по имени, введённому пользователем. Сравнение без учёта
  // регистра и краевых пробелов — в UI GMGN имена вида "RICH WHALE" легко
  // ввести с лишним пробелом. Группу НЕ создаёт: если имени нет среди
  // существующих, бросает ошибку со списком доступных, чтобы в сайдбаре
  // сразу было видно, из чего выбирать.
  async function resolveGroupIdsByName(groupName, chain = 'robinhood') {
    const wanted = String(groupName || '').trim().toLowerCase();
    if (!wanted) return null; // пустое поле — обычное поведение (группа по умолчанию)

    // Как и в follow(): всегда свежий список, чтобы не поймать разъехавшийся
    // закэшированный group_id (см. комментарий про P_GMGN_IN_INVALID_ARGUMENT).
    let groups = await window.__GMGN_GROUPS__.refreshGroups(chain);
    if (!groups.length) groups = await gwWaitForGroups(25000);

    const wantChain = CHAIN_TO_GROUP_CHAIN[chain] || chain;
    const byName = groups.filter((g) => String(g.name || '').trim().toLowerCase() === wanted);
    // Одно и то же имя может существовать в разных сетях — берём группу
    // текущей сети, а если такой нет, довольствуемся первым совпадением.
    const hit = byName.find((g) => g.chain === wantChain) || byName[0];

    if (!hit) {
      const available = groups.map((g) => g.name).join(', ') || '(список пуст)';
      throw new Error(`GMGN: группа "${groupName}" не найдена. Доступные: ${available}`);
    }
    return [hit.id];
  }

  async function addToWatchlist(walletAddress, { chain = 'robinhood', name, color, groupIds, groupName, emoji, alerts } = {}) {
    // groupIds имеет приоритет; groupName — то, что руками ввели в сайдбаре.
    let ids = groupIds;
    if ((!ids || !ids.length) && groupName) ids = await resolveGroupIdsByName(groupName, chain);

    const followResult = await follow(walletAddress, { chain, groupIds: ids });
    const followOk = !!(followResult && followResult.status === 200 && followResult.data && followResult.data.code === 0);
    // reason из тела ответа GMGN при неуспехе — например P_GMGN_IN_FOLLOW_BOT
    // (адрес определён как бот, подписка невозможна). Прокидываем наружу,
    // чтобы sidebar.js мог различить "бот" от прочих ошибок и не ретраить.
    const followReason = (!followOk && followResult && followResult.data && followResult.data.reason) || null;

    let remarkResult = null;
    let remarkOk = false;
    if (followOk && name) {
      remarkResult = await remark(walletAddress, name, color, { chain });
      remarkOk = !!(remarkResult && remarkResult.status === 200 && remarkResult.data && remarkResult.data.code === 0);
    }

    // Эмодзи и оповещения — тоже best-effort, как и remark: подписка уже
    // засчитана, и ронять из-за них весь результат нельзя (иначе повторный
    // клик "Добавить" пошёл бы подписываться на уже подписанный кошелёк).
    // Ошибку не глотаем молча, а возвращаем наружу — sidebar пишет её в
    // консоль вместе с сырыми ответами.
    let emojiResult = null;
    let emojiOk = false;
    if (followOk && emoji) {
      try {
        emojiResult = await setEmoji(walletAddress, emoji, { chain });
        emojiOk = !!(emojiResult && emojiResult.status === 200 && emojiResult.data && emojiResult.data.code === 0);
      } catch (e) {
        emojiResult = { error: String(e && e.message || e) };
      }
    }

    let alertsResult = null;
    let alertsOk = false;
    if (followOk && alerts) {
      try {
        alertsResult = await setAlerts(walletAddress, alerts, { chain });
        alertsOk = !!(alertsResult && alertsResult.status === 200 && alertsResult.data && alertsResult.data.code === 0);
      } catch (e) {
        alertsResult = { error: String(e && e.message || e) };
      }
    }

    return {
      followOk, remarkOk, emojiOk, alertsOk, followReason,
      followResult, remarkResult, emojiResult, alertsResult
    };
  }

  window.__GMGN_FOLLOW__ = { follow, unfollow, remark, setEmoji, setAlerts, addToWatchlist, resolveGroupIdsByName };
})();
