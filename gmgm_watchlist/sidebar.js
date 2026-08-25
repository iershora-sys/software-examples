'use strict';

const GW_DEFAULT_REMARK_COLOR = '#E9AE4D'; // дефолт цвета метки (пользователь может сменить — см. remarkColorInput ниже); rgb(233,174,77), как у "TESTS" в GMGN
const GW_BOT_REASON = 'P_GMGN_IN_FOLLOW_BOT'; // GMGN определил адрес как бота — подписка невозможна
const GW_BATCH_SIZE = 10; // сколько кошельков добавляем параллельно (Promise.all) за раз

// Иконка бота (предоставлена пользователем, iconify "robots"). fill заменён
// на currentColor — цвет наследуется от .gw-status-bot (var(--danger)),
// один источник правды для оттенка красного вместо жёстко зашитого #ff5252.
const GW_BOT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 32 32" fill="currentColor"><path d="M28.586 18H28a8 8 0 0 0-8-8h-2V8.445a4 4 0 1 0-4 0V10h-2a8 8 0 0 0-8 8h-.586A1.414 1.414 0 0 0 2 19.414v3.172A1.414 1.414 0 0 0 3.414 24H4v1a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3v-1h.586A1.414 1.414 0 0 0 30 22.586v-3.172A1.414 1.414 0 0 0 28.586 18M11 22a3 3 0 1 1 3-3a3 3 0 0 1-3 3m10 0a3 3 0 1 1 3-3a3 3 0 0 1-3 3"/></svg>';

const tokenSectionEl = document.getElementById('tokenSection');
const tokenTickerEl = document.getElementById('tokenTicker');
const tokenNameEl = document.getElementById('tokenName');
const tokenAddressEl = document.getElementById('tokenAddress');

const selectedSectionEl = document.getElementById('selectedSection');
const selectedTbody = document.getElementById('selectedTable');
const selectedEmptyEl = document.getElementById('selectedEmpty');
const prefixInput = document.getElementById('prefixInput');
const groupInput = document.getElementById('groupInput');
const groupListEl = document.getElementById('groupList');
const addBtn = document.getElementById('addToWatchlistBtn');
const addResultEl = document.getElementById('addResult');

// Цвет метки (remark), которым помечаются добавленные в GMGN кошельки.
// Изначально был жёстко зашит красным ("просили красный"), затем сделан
// настраиваемым (1.14.1). Дефолт сменён на жёлтый #E9AE4D — по образцу
// цвета надписи "TESTS" в самом GMGN (rgb(233,174,77), снято пользователем
// через их же color picker). Хранится в chrome.storage.local, пользователь
// может сменить на что угодно через remarkColorInput.
const remarkColorInput = document.getElementById('remarkColorInput');
const remarkColorHexEl = document.getElementById('remarkColorHex');
let _remarkColor = GW_DEFAULT_REMARK_COLOR;

async function loadRemarkColor() {
  const res = await chrome.storage.local.get('gw_remark_color');
  _remarkColor = res.gw_remark_color || GW_DEFAULT_REMARK_COLOR;
  remarkColorInput.value = _remarkColor;
  remarkColorHexEl.textContent = _remarkColor.toUpperCase();
}

remarkColorInput.addEventListener('input', () => {
  _remarkColor = remarkColorInput.value;
  remarkColorHexEl.textContent = _remarkColor.toUpperCase();
  chrome.storage.local.set({ gw_remark_color: _remarkColor }).catch(() => {});
});

loadRemarkColor();

const trackedSectionEl = document.getElementById('trackedSection');
const trackedTbody = document.getElementById('trackedTable');
const trackedEmptyEl = document.getElementById('trackedEmpty');
const unfollowBtn = document.getElementById('unfollowSelectedBtn');
const unfollowResultEl = document.getElementById('unfollowSelectedResult');

// Горячая клавиша — теперь через нативный chrome.commands (manifest.json),
// пользователь может сменить её сам на chrome://extensions/shortcuts.
// Показываем РЕАЛЬНО назначенную комбинацию (не хардкод) — если юзер её
// уже поменял, hardcoded "Ctrl+Shift+G" в разметке было бы враньём.
const hotkeyHintEl = document.getElementById('hotkeyHint');

async function loadHotkeyHint() {
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === 'toggle-panel');
    hotkeyHintEl.textContent = (cmd?.shortcut || 'не назначена') + ' · изменить';
  } catch (e) {
    hotkeyHintEl.textContent = 'изменить горячую клавишу';
  }
}

hotkeyHintEl.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

loadHotkeyHint();

async function getActiveGmgnTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.includes('gmgn.ai')) return tab;
  return null;
}

// Определяет chain для follow()/unfollow() из URL вкладки: на странице
// токена — сегмент пути (/{chain}/token/...), на /follow — query-параметр
// ?chain=... Без этого follow/unfollow всегда уходили бы с chain:'robinhood'
// (дефолт в gmgn/follow.js), даже когда реальная сеть страницы другая.
function chainFromTabUrl(tabUrl) {
  try {
    const u = new URL(tabUrl);
    const m = u.pathname.match(/^\/([a-z0-9_-]+)\/token\//i);
    if (m) return m[1].toLowerCase();
    const q = u.searchParams.get('chain');
    if (q) return q.toLowerCase();
  } catch (e) {
    // невалидный URL вкладки — используем дефолт ниже
  }
  return 'robinhood';
}

// Инфо о токене со страницы https://gmgn.ai/{chain}/token/... — пишет
// gmgn/wallet_scanner.js в chrome.storage.local['gw_current_token'].
let _prefixTouched = false; // юзер сам отредактировал поле — больше не перезатираем автозначением
prefixInput.addEventListener('input', () => { _prefixTouched = true; loadSelected(); });

let _lastTicker = null; // для пересчёта автозаполнения при переключении "Нумеровать"

// Нумерация кошельков при добавлении: ИМЯ_1, ИМЯ_2, ... По умолчанию
// ВЫКЛЮЧЕНА — все кошельки получают одно и то же имя (ИМЯ), без номера.
const numberingInput = document.getElementById('numberingEnabled');
let _numberingEnabled = false;

async function loadNumberingPref() {
  const res = await chrome.storage.local.get('gw_numbering_enabled');
  _numberingEnabled = !!res.gw_numbering_enabled;
  numberingInput.checked = _numberingEnabled;
}

numberingInput.addEventListener('change', () => {
  _numberingEnabled = numberingInput.checked;
  chrome.storage.local.set({ gw_numbering_enabled: _numberingEnabled }).catch(() => {});
  applyAutoPrefix(); // "_" на конце имеет смысл только если нумерация включена
  loadSelected(); // _1/_2/_3 должны появиться/пропасть в таблице сразу
});

loadNumberingPref();

// Единая точка автозаполнения префикса из тикера — учитывает состояние
// "Нумеровать": включена — "{TICKER}_" (готово к конкатенации с номером),
// выключена — просто "{TICKER}" (лишнее подчёркивание в конце без номера
// смотрелось бы странно). Не трогает поле, если юзер уже сам его отредактировал.
function applyAutoPrefix() {
  if (_prefixTouched || !_lastTicker) return;
  prefixInput.value = _numberingEnabled ? `${_lastTicker}_` : _lastTicker;
}

let _currentTokenAddr = null; // используется для скоупинга "Выбранные кошельки" ниже
let _pageContext = null; // 'token' | 'follow' | null — определяется НАПРЯМУЮ из URL активной вкладки (см. ниже)

// Секции "Токен"/"Выбранные кошельки со страницы токена" не имеют смысла
// на странице /follow. Симметрично прячем "Отслеживаемые кошельки" на
// странице токена — она там не нужна.
function applySectionVisibility() {
  const showToken = _pageContext !== 'follow' && !!_currentTokenAddr;
  tokenSectionEl.style.display = showToken ? '' : 'none';
  selectedSectionEl.style.display = _pageContext === 'follow' ? 'none' : '';
  trackedSectionEl.style.display = _pageContext === 'token' ? 'none' : '';
  // Экспорт живёт на тех же данных, что и 'Выбранные' — прячем вместе с ними.
  // getElementById здесь, а не в общий const наверху: одноимённый
  // exportSectionEl уже объявлен в export.js, а классические скрипты делят
  // глобальный лексический скоуп — второй const был бы SyntaxError.
  const exp = document.getElementById('exportSection');
  if (exp) exp.style.display = _pageContext === 'follow' ? 'none' : '';
  if (window.__gwRenderExport) window.__gwRenderExport();
}

// ══════════════════════════════════════════════════════════════════════════════
// Трекинг активной вкладки браузера в реальном времени.
//
// Раньше "текущая страница" определялась через chrome.storage.local
// ['gw_page_context'], который писали сами content scripts при загрузке/
// мутации DOM. Проблема: если открыто НЕСКОЛЬКО вкладок gmgn.ai
// одновременно (например одна на /follow, другая на странице токена — у
// каждой свой собственный докинг-сайдбар, panel.js создаёт его в каждой
// вкладке отдельно), их content scripts пишут в ОДИН И ТОТ ЖЕ ключ
// storage — переключение фокуса между уже загруженными вкладками само по
// себе НИЧЕГО не триггерит, ни один script не перезапускается и ничего не
// перезаписывает. Значит storage хранит то, что написала вкладка, которая
// писала последней — не обязательно та, что сейчас активна. Отсюда и был
// баг: пришлось обновлять страницу, чтобы sidebar "понял", что теперь мы
// на другой странице.
//
// Правильный источник истины — сам браузер (chrome.tabs), а не storage.
// Спрашиваем НАПРЯМУЮ, какая вкладка активна, и вычисляем контекст из её
// URL. Реагируем на события (мгновенно), плюс подстраховочный poll на
// случай гонки/пропущенного события.
// ══════════════════════════════════════════════════════════════════════════════

const GW_TAB_POLL_MS = 1500;
let _lastPolledTabId = null;
let _lastPolledUrl = null;

async function pollActiveTab() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    return;
  }
  if (!tab || !tab.url) return;

  if (tab.id === _lastPolledTabId && tab.url === _lastPolledUrl) return; // ничего не изменилось
  _lastPolledTabId = tab.id;
  _lastPolledUrl = tab.url;

  let url;
  try {
    url = new URL(tab.url);
  } catch (e) {
    return;
  }
  if (url.hostname !== 'gmgn.ai') {
    _pageContext = null;
    applySectionVisibility();
    return;
  }

  const isToken = /^\/(robinhood|bsc|base|eth|arbitrum)\/token\//.test(url.pathname);
  const isFollow = /^\/follow(\/|$)/.test(url.pathname);
  _pageContext = isToken ? 'token' : (isFollow ? 'follow' : null);
  applySectionVisibility();

  if (isToken) {
    // Не ждём, пока wallet_scanner.js САМ перепишет gw_current_token (это
    // тоже общий на все вкладки ключ, той же природы гонка возможна, если
    // одновременно открыты ДВЕ РАЗНЫЕ токен-вкладки) — сразу подглядываем
    // тикер/адрес прямо в DOM активной вкладки.
    refreshTokenFromActiveTab(tab.id);
  }
}

async function refreshTokenFromActiveTab(tabId) {
  let result;
  try {
    const [{ result: r } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const m = location.pathname.match(/^\/[a-z0-9_-]+\/token\/(0x[a-fA-F0-9]{40})/i);
        const address = m ? m[1].toLowerCase() : null;
        const symbolEl = document.querySelector('#token-base-symbol');
        const ticker = symbolEl?.textContent?.trim() || null;
        let name = null;
        if (symbolEl) {
          const wrap = symbolEl.parentElement?.parentElement;
          name = wrap?.children?.[1]?.textContent?.trim() || null;
        }
        return { address, ticker, name };
      }
    });
    result = r;
  } catch (e) {
    return; // вкладка могла ещё не догрузиться — следующий тик/событие поправит
  }
  if (!result || !result.address) return;

  tokenTickerEl.textContent = result.ticker || '—';
  tokenNameEl.textContent = result.name || '';
  tokenAddressEl.textContent = result.address;
  tokenAddressEl.title = result.address;

  if (result.ticker) _lastTicker = result.ticker;
  applyAutoPrefix();

  const changed = _currentTokenAddr !== result.address;
  _currentTokenAddr = result.address;
  applySectionVisibility();
  if (changed) loadSelected();
}

// Мгновенная реакция на переключение вкладки и на SPA-навигацию (смену URL
// без перезагрузки — changeInfo.url приходит и для history.pushState).
chrome.tabs.onActivated.addListener(() => { pollActiveTab(); });
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status === 'complete')) pollActiveTab();
});
// Подстраховочный poll — на случай гонки или пропущенного события.
setInterval(pollActiveTab, GW_TAB_POLL_MS);

async function loadToken() {
  const res = await chrome.storage.local.get('gw_current_token');
  const t = res.gw_current_token;
  const prevTokenAddr = _currentTokenAddr;

  if (!t || !t.address) {
    _currentTokenAddr = null;
  } else {
    tokenTickerEl.textContent = t.ticker || '—';
    tokenNameEl.textContent = t.name || '';
    tokenAddressEl.textContent = t.address;
    tokenAddressEl.title = t.address;
    _currentTokenAddr = t.address;

    if (t.ticker) _lastTicker = t.ticker;
    applyAutoPrefix();
  }

  applySectionVisibility();

  // Таблица "Выбранные кошельки" привязана к адресу токена (см.
  // loadSelected) — при смене токена (переход по ленте наверху, без
  // перезагрузки страницы) её надо перерисовать даже если gw_selected
  // сам по себе не менялся.
  if (_currentTokenAddr !== prevTokenAddr) loadSelected();
}


// Кошельки, отмеченные чекбоксом/выделением на странице токена — пишет
// gmgn/wallet_scanner.js в chrome.storage.local['gw_selected']. Удаление
// строки здесь синхронно снимает чекбокс на странице (через onChanged
// в wallet_scanner.js — storage единый источник истины).
//
// Список ГЛОБАЛЬНЫЙ в storage (адреса со всех когда-либо посещённых
// токенов, каждый помечен tokenAddr), но ПОКАЗЫВАЕМ и ОБРАБАТЫВАЕМ только
// записи ТЕКУЩЕГО токена (_currentTokenAddr) — иначе при переходе на другой
// токен в сайдбаре продолжали бы висеть чужие кошельки предыдущего токена.
async function loadSelected() {
  const res = await chrome.storage.local.get('gw_selected');
  const all = res.gw_selected || [];
  const list = _currentTokenAddr ? all.filter((x) => x.tokenAddr === _currentTokenAddr) : [];

  selectedTbody.innerHTML = '';
  selectedEmptyEl.style.display = list.length ? 'none' : '';

  // Для столбца "Имя" у ещё не добавленных строк — ЖИВОЙ предпросмотр
  // того имени, которое получится при клике "Добавить адреса в вачлист"
  // ПРЯМО СЕЙЧАС (текущий prefix + состояние "Нумеровать"). Формула
  // 1-в-1 совпадает с addSelectedToWatchlist() — pendingIndex считается
  // так же (растёт только для !followed && !botAddress строк, в том же
  // порядке), иначе предпросмотр и реальный результат добавления могли
  // бы разойтись.
  const previewPrefix = prefixInput.value.trim() || (_numberingEnabled ? 'WALLET_' : 'WALLET');
  const alreadySkippedCount = list.filter((x) => x.followed || x.botAddress).length;
  let pendingIndex = 0;

  list.forEach((item, i) => {
    const tr = document.createElement('tr');

    const tdN = document.createElement('td');
    tdN.textContent = i + 1;

    const tdAddr = document.createElement('td');
    tdAddr.className = 'gw-mono';
    tdAddr.style.cursor = 'pointer';
    tdAddr.title = 'Клик — скопировать';
    tdAddr.textContent = item.addr;
    tdAddr.addEventListener('click', () => {
      navigator.clipboard?.writeText(item.addr).catch(() => {});
    });

    const tdName = document.createElement('td');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'gw-name-cell';
    let nameText;
    let isPreview = false;
    if (item.followed) {
      nameText = item.remarkName || '';
    } else if (item.botAddress) {
      nameText = '—';
    } else {
      // Ещё не добавлен (или упал не из-за бота) — превью, не факт.
      nameText = _numberingEnabled
        ? `${previewPrefix}${alreadySkippedCount + pendingIndex + 1}`
        : previewPrefix;
      isPreview = true;
      pendingIndex++;
    }
    nameSpan.textContent = nameText;
    // Полное имя видно при наведении, даже если обрезано многоточием.
    nameSpan.title = isPreview ? `${nameText} (предпросмотр — присвоится при добавлении)` : nameText;
    tdName.appendChild(nameSpan);

    const tdStatus = document.createElement('td');
    if (item.followed) {
      tdStatus.className = 'gw-status-ok';
      tdStatus.textContent = '✓';
      tdStatus.title = item.remarkName
        ? `Добавлен как "${item.remarkName}"${item.remarkOk ? '' : ' (метка не применилась)'}`
        : 'Добавлен в вачлист';
    } else if (item.botAddress) {
      // GMGN считает адрес ботом — follow() принципиально не пройдёт,
      // повторные попытки бессмысленны (см. addSelectedToWatchlist).
      tdStatus.className = 'gw-status-bot';
      tdStatus.innerHTML = GW_BOT_ICON_SVG;
      tdStatus.title = 'GMGN определил адрес как бота — подписка невозможна';
    } else if (item.lastError) {
      tdStatus.className = 'gw-status-error';
      tdStatus.textContent = '!';
      tdStatus.title = 'Ошибка при добавлении: ' + item.lastError;
    } else {
      tdStatus.className = 'gw-status-pending';
      tdStatus.textContent = '—';
      tdStatus.title = 'Ещё не пытались добавить';
    }

    const tdDel = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'gw-btn';
    delBtn.style.padding = '2px 6px';
    delBtn.textContent = '✕';
    delBtn.title = 'Убрать из списка (в GMGN уже добавленное не отписывает)';
    delBtn.addEventListener('click', async () => {
      const cur = (await chrome.storage.local.get('gw_selected')).gw_selected || [];
      // Фильтр по паре (addr, tokenAddr) — тот же адрес мог быть отдельно
      // выбран и на ДРУГОМ токене (см. комментарий про составной ключ в
      // wallet_scanner.js), трогать ту запись нельзя.
      await chrome.storage.local.set({
        gw_selected: cur.filter((x) => !(x.addr === item.addr && x.tokenAddr === item.tokenAddr))
      });
    });
    tdDel.appendChild(delBtn);

    tr.append(tdN, tdAddr, tdName, tdStatus, tdDel);
    selectedTbody.appendChild(tr);
  });

  // Нечего добавлять — либо список пуст, либо все записи текущего токена
  // уже followed/botAddress. Кнопка неактивна, чтобы не провоцировать
  // повторный клик впустую (см. addSelectedToWatchlist — он бы и сам не
  // отправил лишних запросов, но лучше явно показать, что делать нечего).
  const pendingCount = list.filter((x) => !x.followed && !x.botAddress).length;
  addBtn.disabled = pendingCount === 0;

  // Список изменился — предпросмотр экспорта строится на тех же записях.
  if (window.__gwRenderExport) window.__gwRenderExport();
}

// Очищает записи ТОЛЬКО указанного токена — иначе улетели бы и сохранённые
// выборки для других токенов, которые в этот момент даже не видны.
// tokenAddr — явный параметр (не читаем живую _currentTokenAddr внутри),
// чтобы автоочистка после добавления (см. addSelectedToWatchlist) чистила
// именно тот токен, для которого шёл прогон, а не то что вдруг стало
// текущим за прошедшую секунду ожидания (маловероятно, но дёшево сделать
// правильно).
async function clearSelectedForToken(tokenAddr) {
  const cur = (await chrome.storage.local.get('gw_selected')).gw_selected || [];
  await chrome.storage.local.set({
    gw_selected: cur.filter((x) => x.tokenAddr !== tokenAddr)
  });
}

document.getElementById('clearSelectedBtn').addEventListener('click', () => {
  clearSelectedForToken(_currentTokenAddr);
});

// Пакетное добавление в вачлист: follow() + remark(имя, выбранный
// пользователем цвет — см. remarkColorInput выше) на каждый ЕЩЁ НЕ
// добавленный кошелёк. Каждый кошелёк — по-прежнему ОТДЕЛЬНЫЙ
// follow_wallet/remark_wallet_v2 запрос (не батч-эндпоинт), но сами запросы
// теперь идут ПАЧКАМИ по GW_BATCH_SIZE ПАРАЛЛЕЛЬНО (Promise.all) — не все
// разом (не спамим API) и не строго по одному (быстрее). Уже добавленные
// (item.followed === true) пропускаются — идемпотентно, повторный клик не
// дублирует подписку. Имя — "{префикс}{N}", нумерация — по ПОЗИЦИИ в списке
// (не по порядку завершения запроса — параллельность не гарантирует
// порядок ответов).
// decor — { emoji, alerts } из секции экспорта, или null. null, когда
// галочка "Применять эмодзи и оповещения в GMGN" снята: тогда addToWatchlist
// ведёт себя ровно как до 1.19.0 и настройки уже добавленных кошельков не
// трогает.
async function runOneAdd(tabId, item, name, chain, groupIds, decor) {
  let execResult;
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (addr, nm, color, ch, gids, dec) => {
        try {
          const r = await window.GMGN.addToWatchlist(addr, {
            name: nm, color, chain: ch, groupIds: gids,
            emoji: dec && dec.emoji, alerts: dec && dec.alerts
          });
          // Лог прямо в консоли вкладки gmgn.ai (это тут реально сходил fetch) —
          // полный сырой ответ API, а не наша интерпретация ok/not-ok.
          console.log(
            `[GMGN Watchlist] addToWatchlist(${addr}) →`,
            'follow:', r.followResult,
            'remark:', r.remarkResult,
            'emoji:', r.emojiResult,
            'alerts:', r.alertsResult
          );
          return { ok: true, r };
        } catch (e) {
          console.warn(`[GMGN Watchlist] addToWatchlist(${addr}) exception:`, e);
          return { ok: false, error: String(e) };
        }
      },
      args: [item.addr, name, _remarkColor, chain, groupIds || null, decor || null]
    });
    execResult = result;
  } catch (e) {
    execResult = { ok: false, error: String(e) };
  }

  // Тот же ответ — ещё и в консоли сайдбара (правый клик по сайдбару →
  // "Проверить" → своя вкладка Console, отдельная от консоли страницы
  // gmgn.ai), чтобы не переключаться между двумя DevTools.
  console.log(`[GMGN Watchlist sidebar] ${item.addr} (${name}):`, execResult);

  const followed = !!(execResult?.ok && execResult.r?.followOk);
  const remarkOk = !!(execResult?.ok && execResult.r?.remarkOk);
  const emojiOk = !!(execResult?.ok && execResult.r?.emojiOk);
  const alertsOk = !!(execResult?.ok && execResult.r?.alertsOk);
  const followReason = execResult?.ok ? execResult.r?.followReason : null;
  const isBot = followReason === GW_BOT_REASON;

  return { item, name, execResult, followed, remarkOk, emojiOk, alertsOk, isBot, followReason };
}

async function addSelectedToWatchlist() {
  addResultEl.textContent = '';

  const tab = await getActiveGmgnTab();
  if (!tab) {
    addResultEl.textContent = 'Откройте вкладку на gmgn.ai';
    return;
  }

  const tokenAddrAtStart = _currentTokenAddr; // для авто-очистки в конце — см. комментарий там
  const chain = chainFromTabUrl(tab.url); // сеть текущей страницы токена

  const all = (await chrome.storage.local.get('gw_selected')).gw_selected || [];
  const list = tokenAddrAtStart ? all.filter((x) => x.tokenAddr === tokenAddrAtStart) : [];
  // botAddress: true — GMGN уже сказал, что это бот, повторные попытки
  // бессмысленны (см. рендер статуса выше и комментарий у GW_BOT_REASON).
  const pending = list.filter((x) => !x.followed && !x.botAddress);
  if (!pending.length) {
    addResultEl.textContent = list.length
      ? 'Все выбранные кошельки уже добавлены (или помечены как боты).'
      : 'Список выбранных кошельков пуст.';
    return;
  }

  const prefix = prefixInput.value.trim() || (_numberingEnabled ? 'WALLET_' : 'WALLET');
  const alreadySkippedCount = list.length - pending.length; // followed + botAddress — чтобы нумерация не переиспользовалась

  // Имена считаем сразу для всех, от ПОЗИЦИИ в pending — при параллельной
  // обработке порядок завершения запросов не гарантирован, а нумерация
  // (если включена) должна быть детерминированной независимо от того, кто
  // ответил первым. Нумерация опциональна (чекбокс "Нумеровать", по
  // умолчанию выключена) — выключена, все кошельки получают ОДНО И ТО ЖЕ
  // имя (просто prefix как есть, без номера).
  // decor — эмодзи и оповещения из секции экспорта. Считаем от позиции в
  // pending, а не в полном списке: "Авто"-эмодзи раздаётся по порядку тем,
  // кого реально добавляем, чтобы первый добавляемый получил 🐳, даже если
  // выше в таблице стоят уже подписанные.
  const jobs = pending.map((item, i) => ({
    item,
    name: _numberingEnabled ? `${prefix}${alreadySkippedCount + i + 1}` : prefix,
    decor: window.__gwGmgnDecor ? window.__gwGmgnDecor(i) : null,
  }));

  // Имя группы -> group_id резолвим ОДИН РАЗ на весь прогон, а не внутри
  // runOneAdd: иначе каждый кошелёк дёргал бы refreshGroups() заново
  // (лишний round-trip к GMGN на каждый адрес). Дальше по батчам идут
  // уже готовые id.
  const groupName = groupInput.value.trim();
  let groupIds = null;
  if (groupName) {
    addResultEl.textContent = `Ищу группу «${groupName}»…`;
    let res;
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (gn, ch) => {
          try { return { ok: true, ids: await window.GMGN.resolveGroupIdsByName(gn, ch) }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        },
        args: [groupName, chain]
      });
      res = result;
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    if (!res || !res.ok || !res.ids || !res.ids.length) {
      // Не найдено — останавливаемся, НЕ падая молча в группу по умолчанию:
      // иначе кошельки уехали бы не туда и это заметили бы не сразу.
      addResultEl.textContent = res?.error || `Группа «${groupName}» не найдена.`;
      return;
    }
    groupIds = res.ids;
    await chrome.storage.local.set({ gw_last_group: groupName });
  }

  addBtn.disabled = true;
  let okCount = 0;
  let botCount = 0;
  const debugRows = []; // для итоговой console.table в конце — быстрый обзор всех попыток разом

  for (let start = 0; start < jobs.length; start += GW_BATCH_SIZE) {
    const batch = jobs.slice(start, start + GW_BATCH_SIZE);
    addResultEl.textContent =
      `Добавляю ${start + 1}–${start + batch.length} из ${jobs.length}…`;

    // Сами запросы — параллельно, пачкой. Storage при этом НЕ трогаем
    // внутри runOneAdd — если писать read-modify-write на каждый кошелёк
    // параллельно, конкурентные записи гонялись бы друг за другом и
    // теряли обновления (классический lost update: оба читают один и тот
    // же "cur", оба пишут — выживает только последний set()).
    const results = await Promise.all(batch.map(({ item, name, decor }) => runOneAdd(tab.id, item, name, chain, groupIds, decor)));

    // Storage читаем-модифицируем-пишем ОДИН РАЗ на весь батч — так гонки
    // исключены в принципе (один read-modify-write, а не N параллельных).
    const cur = (await chrome.storage.local.get('gw_selected')).gw_selected || [];
    for (const { item, name, execResult, followed, remarkOk, emojiOk, alertsOk, isBot, followReason } of results) {
      if (followed) okCount++;
      if (isBot) botCount++;

      const idx = cur.findIndex((x) => x.addr === item.addr && x.tokenAddr === item.tokenAddr);
      if (idx !== -1) {
        cur[idx] = {
          ...cur[idx],
          followed,
          remarkOk,
          botAddress: isBot,
          remarkName: followed ? name : cur[idx].remarkName,
          lastError: followed ? null : (execResult?.error || JSON.stringify(execResult?.r?.followResult ?? execResult)),
        };
      }

      debugRows.push({
        addr: item.addr,
        name,
        followed,
        isBot,
        followStatus: execResult?.r?.followResult?.status ?? null,
        followCode: execResult?.r?.followResult?.data?.code ?? null,
        followReason: followReason || '',
        followMessage: execResult?.r?.followResult?.data?.message || '',
        remarkOk,
        emojiOk,
        alertsOk,
      });
    }
    await chrome.storage.local.set({ gw_selected: cur });
  }

  addBtn.disabled = false;
  addResultEl.textContent = `Готово: успешно ${okCount} из ${jobs.length}` +
    (botCount ? `, боты (пропущены): ${botCount}` : '') +
    (groupName ? ` → группа «${groupName}»` : '') + '.';

  console.log('[GMGN Watchlist sidebar] сводка по прогону:');
  console.table(debugRows);

  // Авто-очистка: секунду видно результат (галочки/иконки в таблице,
  // текст "Готово: ..."), затем список для ЭТОГО токена очищается сам —
  // просили явно, чтобы не накапливался и не приходилось жать "Очистить"
  // руками после каждого прогона. Чистим tokenAddrAtStart (снятый в
  // начале функции), а не живую _currentTokenAddr — если пользователь
  // за эту секунду успел переключиться на другой токен, не должны задеть
  // чужой список.
  setTimeout(() => {
    clearSelectedForToken(tokenAddrAtStart);
  }, 1000);
}

addBtn.addEventListener('click', addSelectedToWatchlist);

// ══════════════════════════════════════════════════════════════════════════════
// Отслеживаемые кошельки со страницы /follow — противоположный сценарий:
// отмеченные адреса идут на unfollow(), не на follow(). Хранятся отдельно
// от gw_selected (тот привязан к tokenAddr, здесь такого контекста нет).
// Пишет их gmgn/tracked_wallet_scanner.js в chrome.storage.local['gw_tracking_selected'].
// ══════════════════════════════════════════════════════════════════════════════

async function loadTracked() {
  const res = await chrome.storage.local.get('gw_tracking_selected');
  const list = res.gw_tracking_selected || [];

  trackedTbody.innerHTML = '';
  trackedEmptyEl.style.display = list.length ? 'none' : '';

  list.forEach((item, i) => {
    const tr = document.createElement('tr');

    const tdN = document.createElement('td');
    tdN.textContent = i + 1;

    const tdAddr = document.createElement('td');
    tdAddr.className = 'gw-mono';
    tdAddr.style.cursor = 'pointer';
    tdAddr.title = item.addr + ' (клик — скопировать)';
    tdAddr.textContent = item.addr.slice(0, 6) + '…' + item.addr.slice(-4);
    tdAddr.addEventListener('click', () => {
      navigator.clipboard?.writeText(item.addr).catch(() => {});
    });

    const tdStatus = document.createElement('td');
    if (item.unfollowed) {
      tdStatus.className = 'gw-status-ok';
      tdStatus.textContent = '✓';
      tdStatus.title = 'Отписан';
    } else if (item.lastError) {
      tdStatus.className = 'gw-status-error';
      tdStatus.textContent = '!';
      tdStatus.title = 'Ошибка при отписке: ' + item.lastError;
    } else {
      tdStatus.className = 'gw-status-pending';
      tdStatus.textContent = '—';
      tdStatus.title = 'Ещё не пытались отписать';
    }

    const tdDel = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'gw-btn';
    delBtn.style.padding = '2px 6px';
    delBtn.textContent = '✕';
    delBtn.title = 'Убрать из списка (не отписывает от GMGN)';
    delBtn.addEventListener('click', async () => {
      const cur = (await chrome.storage.local.get('gw_tracking_selected')).gw_tracking_selected || [];
      await chrome.storage.local.set({
        gw_tracking_selected: cur.filter((x) => x.addr !== item.addr)
      });
    });
    tdDel.appendChild(delBtn);

    tr.append(tdN, tdAddr, tdStatus, tdDel);
    trackedTbody.appendChild(tr);
  });

  const pendingCount = list.filter((x) => !x.unfollowed).length;
  unfollowBtn.disabled = pendingCount === 0;
}

async function clearTracked() {
  await chrome.storage.local.set({ gw_tracking_selected: [] });
}

document.getElementById('clearTrackedBtn').addEventListener('click', clearTracked);

async function runOneUnfollow(tabId, item, chain) {
  let execResult;
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (addr, ch) => {
        try {
          const r = await window.GMGN.unfollow(addr, { chain: ch });
          console.log(`[GMGN Watchlist] unfollow(${addr}) →`, r);
          return { ok: true, r };
        } catch (e) {
          console.warn(`[GMGN Watchlist] unfollow(${addr}) exception:`, e);
          return { ok: false, error: String(e) };
        }
      },
      args: [item.addr, chain]
    });
    execResult = result;
  } catch (e) {
    execResult = { ok: false, error: String(e) };
  }

  console.log(`[GMGN Watchlist sidebar] unfollow ${item.addr}:`, execResult);

  const unfollowed = !!(execResult?.ok && execResult.r?.status === 200 && execResult.r?.data?.code === 0);
  return { item, execResult, unfollowed };
}

// Тот же приём, что и с добавлением: пачками по GW_BATCH_SIZE параллельно
// (Promise.all), storage читаем-модифицируем-пишем один раз на пачку —
// иначе гонка read-modify-write теряла бы обновления при параллельной записи.
async function unfollowSelectedWallets() {
  unfollowResultEl.textContent = '';

  const tab = await getActiveGmgnTab();
  if (!tab) {
    unfollowResultEl.textContent = 'Откройте вкладку на gmgn.ai';
    return;
  }

  const list = (await chrome.storage.local.get('gw_tracking_selected')).gw_tracking_selected || [];
  const pending = list.filter((x) => !x.unfollowed);
  if (!pending.length) {
    unfollowResultEl.textContent = list.length
      ? 'Все выбранные кошельки уже отписаны.'
      : 'Список выбранных кошельков пуст.';
    return;
  }

  const chain = chainFromTabUrl(tab.url); // сеть текущей страницы /follow

  unfollowBtn.disabled = true;
  let okCount = 0;
  const debugRows = [];

  for (let start = 0; start < pending.length; start += GW_BATCH_SIZE) {
    const batch = pending.slice(start, start + GW_BATCH_SIZE);
    unfollowResultEl.textContent = `Отписываю ${start + 1}–${start + batch.length} из ${pending.length}…`;

    const results = await Promise.all(batch.map((item) => runOneUnfollow(tab.id, item, chain)));

    const cur = (await chrome.storage.local.get('gw_tracking_selected')).gw_tracking_selected || [];
    for (const { item, execResult, unfollowed } of results) {
      if (unfollowed) okCount++;

      const idx = cur.findIndex((x) => x.addr === item.addr);
      if (idx !== -1) {
        cur[idx] = {
          ...cur[idx],
          unfollowed,
          lastError: unfollowed ? null : (execResult?.error || JSON.stringify(execResult?.r ?? execResult)),
        };
      }

      debugRows.push({
        addr: item.addr,
        unfollowed,
        status: execResult?.r?.status ?? null,
        code: execResult?.r?.data?.code ?? null,
        message: execResult?.r?.data?.message || '',
      });
    }
    await chrome.storage.local.set({ gw_tracking_selected: cur });
  }

  unfollowBtn.disabled = false;
  unfollowResultEl.textContent = `Готово: успешно отписано ${okCount} из ${pending.length}.`;

  console.log('[GMGN Watchlist sidebar] сводка по отписке:');
  console.table(debugRows);

  // Авто-очистка: секунду видно результат (галочки/иконки в таблице,
  // текст "Готово: ..."), затем список отслеживаемых очищается сам — та
  // же логика, что и у "Добавить адреса в вачлист" (1.15.0), список
  // отслеживаемых глобальный (не привязан к токену), поэтому чистим
  // целиком, без параметра.
  setTimeout(() => {
    clearTracked();
  }, 1000);
}

unfollowBtn.addEventListener('click', unfollowSelectedWallets);

// ══════════════════════════════════════════════════════════════════════════════
// Подсказки по группам в поле ввода. Имена берём из того же
// chrome.storage.local['gmgn'].groups, куда их кладёт пассивный перехват
// business_group_multi_chain/list (см. gmgn/groups.js) — отдельный запрос
// ради автодополнения не делаем.
// ══════════════════════════════════════════════════════════════════════════════
async function loadGroupOptions() {
  const { gmgn, gw_last_group } = await chrome.storage.local.get(['gmgn', 'gw_last_group']);
  const groups = (gmgn && gmgn.groups) || [];

  groupListEl.innerHTML = '';
  // Дедуп по имени: одно имя может существовать в нескольких сетях, в
  // выпадашке это выглядело бы дублями.
  for (const name of [...new Set(groups.map((g) => g.name).filter(Boolean))]) {
    const opt = document.createElement('option');
    opt.value = name;
    groupListEl.appendChild(opt);
  }

  // Последнюю использованную группу подставляем обратно — обычно кошельки
  // льют пачками в одну и ту же.
  if (gw_last_group && !groupInput.value) groupInput.value = gw_last_group;
  groupInput.placeholder = groups.length
    ? `Группа (пусто — по умолчанию), доступно: ${groups.length}`
    : 'Группа (пусто — по умолчанию)';
}

// Живое обновление панели.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.gw_current_token) loadToken();
  if (changes.gw_selected) loadSelected();
  if (changes.gw_tracking_selected) loadTracked();
  if (changes.gmgn) loadGroupOptions(); // перехват принёс свежий список групп
});

pollActiveTab();
loadToken();
loadSelected();
loadTracked();
loadGroupOptions();
