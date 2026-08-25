'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// GMGN Wallet Scanner — ISOLATED world, https://gmgn.ai/{chain}/token/*
// chain ∈ SUPPORTED_CHAINS (robinhood, bsc, base, eth, arbitrum)
//
// Порт логики сканирования из test-gmgn-ext (Top Holders / Top Traders /
// Activity, чекбоксы, массовое выделение мышью, резолвинг адресов
// трейдеров через API-огрызок). Отличие от оригинала: там был отдельный
// плавающий #gmgn-ext-panel — здесь его нет, вместо этого пишем в
// chrome.storage.local (ключи gw_selected / gw_current_token), а
// отображает это наш докинг-сайдбар (sidebar.html/js). Storage — общий
// источник истины: сайдбар может удалить адрес, и чекбокс на странице
// сам снимется (см. chrome.storage.onChanged в конце файла).
// ══════════════════════════════════════════════════════════════════════════════

if (window.__gwWalletScannerActive) {
  // guard от двойной инициализации — см. паттерн в gmgn/inject.js
} else {
window.__gwWalletScannerActive = true;

const ADDR_RE = /0x[a-fA-F0-9]{40}/;

// EVM-сети, на которых работает сканер (страница токена /{chain}/token/*).
const SUPPORTED_CHAINS = ['robinhood', 'bsc', 'base', 'eth', 'arbitrum'];
const TOKEN_PAGE_RE = new RegExp('^/(' + SUPPORTED_CHAINS.join('|') + ')/token/', 'i');

// ── Селекторы ячеек с адресом кошелька в разных таблицах ───────────────────────
const ROW_SELECTORS = {
  holder: '[data-testid="table-cell-holder"]',   // Top Holders — есть href
  trader: '[data-testid="table-cell-trader"]',   // Top Traders — адреса в DOM нет
  maker:  '[data-testid="table-cell-maker"]',    // Activity / All Traders — есть href
};

const KIND_LABEL = { holder: 'Holder', trader: 'Trader', maker: 'Activity' };

// ══════════════════════════════════════════════════════════════════════════════
// Стили — только чекбокс, своей панели больше нет (она в сайдбаре)
// ══════════════════════════════════════════════════════════════════════════════

function injectStyles() {
  if (document.getElementById('gw-scanner-style')) return;
  const s = document.createElement('style');
  s.id = 'gw-scanner-style';
  s.textContent = `
    input.gw-cb {
      width:14px; height:14px; margin:0 8px 0 0; flex-shrink:0;
      cursor:pointer; accent-color:#ff4f29; vertical-align:middle;
    }
    input.gw-cb:disabled { opacity:0.4; cursor:wait; }
  `;
  (document.head || document.documentElement).appendChild(s);
}

// ══════════════════════════════════════════════════════════════════════════════
// Инфо о токене (тикер / имя / адрес) — пишем в storage вместо своей панели
// ══════════════════════════════════════════════════════════════════════════════

function getTokenAddress() {
  const m = location.pathname.match(/^\/[a-z0-9_-]+\/token\/(0x[a-fA-F0-9]{40})/i);
  if (m) return m[1].toLowerCase();
  const el = document.querySelector('#token-base-address');
  return el?.dataset?.addr?.toLowerCase() || null;
}

function getTokenTicker() {
  return document.querySelector('#token-base-symbol')?.textContent?.trim() || null;
}

function getTokenName() {
  const symbolEl = document.querySelector('#token-base-symbol');
  if (!symbolEl) return null;
  // symbolEl -> span(тикер) -> общий родитель -> второй span = имя токена
  const wrap = symbolEl.parentElement?.parentElement;
  const nameEl = wrap?.children?.[1];
  return nameEl?.textContent?.trim() || null;
}

let _lastTokenInfo = null;

function updateTokenInfo() {
  const ticker = getTokenTicker();
  const name = getTokenName();
  const address = getTokenAddress();
  const chain = getChainSlug();

  // Шапка токена дорисовывается SPA асинхронно — в момент document_idle
  // (и даже спустя ~500мс после него) #token-base-symbol может ещё не
  // существовать. Раньше updateTokenInfo() вызывался только один раз при
  // инициализации и один раз при смене URL — если в этот момент DOM ещё
  // не готов, тикер так и оставался null навсегда. Теперь функция ещё и
  // передёргивается из MutationObserver (см. низ файла) при каждом
  // изменении DOM — как только шапка дорендерится, тикер поймается.
  // Дедуп ниже — чтобы не спамить storage.set на каждый чих обсёрвера.
  const changed = !_lastTokenInfo
    || _lastTokenInfo.ticker !== ticker
    || _lastTokenInfo.name !== name
    || _lastTokenInfo.address !== address
    || _lastTokenInfo.chain !== chain;

  _lastTokenInfo = { ticker, name, address, chain };
  if (!changed) return;

  chrome.storage.local
    .set({ gw_current_token: { ticker, name, address, chain, updatedAt: Date.now() } })
    .catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════════
// Состояние собранных адресов — локальный кэш в памяти вкладки, но каждое
// изменение синхронно пишется в chrome.storage.local['gw_selected'], откуда
// его читает сайдбар. Источник истины — storage: удаление из сайдбара (или
// из другой вкладки) прилетает обратно сюда через onChanged и снимает
// чекбокс на странице (см. низ файла).
// ══════════════════════════════════════════════════════════════════════════════

// Ключ теперь составной "tokenAddr::addr", а не просто addr — один и тот же
// кошелёк вполне может встретиться в таблицах ДВУХ РАЗНЫХ токенов (трейдер,
// торгующий несколькими монетами); без привязки к токену второе выделение
// того же адреса на другом токене тихо схлопывалось бы в первую запись
// (addToTable увидел бы _table.has(addr) === true и вышел бы рано, хотя
// это по сути другой "выбор" — в контексте другого токена).
const _table = new Map(); // "tokenAddr::addr" -> { addr, kind, tokenAddr, tokenTicker, ts }
let _applyingRemoteChange = false; // подавляем эхо при реконсиляции из onChanged

function tableKey(tokenAddr, addr) {
  return (tokenAddr || 'unknown') + '::' + addr;
}

function currentTokenAddr() {
  return (_lastTokenInfo && _lastTokenInfo.address) || getTokenAddress();
}

function persistSelected() {
  if (_applyingRemoteChange) return; // это состояние и так уже пришло из storage
  chrome.storage.local
    .set({ gw_selected: [..._table.values()] })
    .catch(() => {});
}

function addToTable(addr, kind) {
  const token = _lastTokenInfo || {};
  const key = tableKey(token.address, addr);
  if (_table.has(key)) return;
  _table.set(key, {
    addr,
    kind,
    tokenAddr: token.address || null,
    tokenTicker: token.ticker || null,
    ts: Date.now(),
  });
  persistSelected();
}

function removeFromTable(addr) {
  const key = tableKey(currentTokenAddr(), addr);
  if (!_table.has(key)) return;
  _table.delete(key);
  persistSelected();
}

// Разовый сид _table из storage при старте скрипта (до первого onChanged —
// дальше onChanged-реконсиляция ниже уже держит _table полным зеркалом
// gw_selected сама, отдельная догрузка при SPA-переходах не нужна).
async function seedTableFromStorage() {
  try {
    const res = await chrome.storage.local.get('gw_selected');
    const arr = res.gw_selected || [];
    for (const item of arr) {
      _table.set(tableKey(item.tokenAddr, item.addr), item);
    }
    if (arr.length) syncAllCheckboxes();
  } catch (e) {
    // storage недоступен — при следующем изменении onChanged всё равно
    // подтянет актуальное состояние.
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Извлечение адреса из DOM (Holders / Activity — есть href)
// Для Top Traders href нет — там матчим по огрызку через _traderSnippetMap
// ══════════════════════════════════════════════════════════════════════════════

const SNIPPET_RE = /0x[0-9a-fA-F]{2}\.\.\.[0-9a-fA-F]{4}/;

function findSnippetInCell(cell) {
  const m = (cell.textContent || '').match(SNIPPET_RE);
  return m ? m[0].toLowerCase() : null;
}

function findAddrInCell(cell, kind) {
  const a = cell.querySelector('a[href*="/address/0x"]');
  if (a) {
    const m = a.getAttribute('href').match(ADDR_RE);
    if (m) return m[0].toLowerCase();
  }
  if (kind === 'trader') {
    const snippet = findSnippetInCell(cell);
    if (snippet && _traderSnippetMap.has(snippet)) {
      return _traderSnippetMap.get(snippet);
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// API gmgn: /vas/api/v1/token_traders/{chain}/{token} — отдаёт полные адреса
// топ-трейдеров. Свой же домен (gmgn.ai), CSP страницы тут не мешает, fetch
// идёт напрямую из ISOLATED world с куками вкладки.
// ══════════════════════════════════════════════════════════════════════════════

const TRADERS_LIMIT = 100;
const TRADERS_ORDER_BY = 'profit';
const TRADERS_DIRECTION = 'desc';
const TRADERS_MAX_PAGES = 3; // защита от бесконечной пагинации по cursor

let _traderSnippetMap = new Map(); // '0xNN...NNNN' -> полный адрес
let _tradersLoadedForToken = null;

function getChainSlug() {
  const m = location.pathname.match(/^\/([a-z0-9_-]+)\/token\//i);
  return m ? m[1] : 'robinhood';
}

function buildSnippet(addr) {
  return '0x' + addr.slice(2, 4) + '...' + addr.slice(-4);
}

async function fetchTradersPage(chain, token, cursor) {
  const url = new URL(`https://gmgn.ai/vas/api/v1/token_traders/${chain}/${token}`);
  url.searchParams.set('limit', TRADERS_LIMIT);
  url.searchParams.set('orderby', TRADERS_ORDER_BY);
  url.searchParams.set('direction', TRADERS_DIRECTION);
  if (cursor) url.searchParams.set('cursor', cursor);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json();
  if (body.code !== 0) throw new Error('API code ' + body.code + ': ' + (body.message || body.reason || ''));
  return body.data || {};
}

async function ensureTraderSnippetMap() {
  const token = getTokenAddress();
  if (!token || token === _tradersLoadedForToken) return;
  _tradersLoadedForToken = token; // помечаем сразу — не запускаем параллельные загрузки

  const chain = getChainSlug();
  const map = new Map();
  let cursor = null;
  let collisions = 0;
  let total = 0;

  for (let page = 0; page < TRADERS_MAX_PAGES; page++) {
    let data;
    try {
      data = await fetchTradersPage(chain, token, cursor);
    } catch (err) {
      break;
    }
    const list = data.list || [];
    for (const item of list) {
      const addr = item.address?.toLowerCase();
      if (!addr) continue;
      total++;
      const snippet = buildSnippet(addr);
      const existing = map.get(snippet);
      if (existing && existing !== addr) {
        collisions++;
      }
      map.set(snippet, addr); // при коллизии остаётся последний — это осознанное ограничение
    }
    if (!data.next || !list.length) break;
    cursor = data.next;
  }

  _traderSnippetMap = map;
  try {
    scanRows(); // подхватить уже отрисованные строки Top Traders новой картой
  } catch (err) {
    // не критично — следующий scanRows() (по MutationObserver) досканирует
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Чекбоксы
// ══════════════════════════════════════════════════════════════════════════════

function syncAllCheckboxes() {
  const tokenAddr = currentTokenAddr();
  document.querySelectorAll('input.gw-cb[data-addr]').forEach((cb) => {
    cb.checked = _table.has(tableKey(tokenAddr, cb.dataset.addr));
  });
}

function setRowChecked(cell, kind, checked) {
  const cb = ensureCheckbox(cell, kind);

  if (checked) {
    const addr = findAddrInCell(cell, kind);
    if (!addr) {
      cb.checked = false;
      return false;
    }
    cb.dataset.addr = addr;
    cb.checked = true;
    addToTable(addr, kind);
    return true;
  }

  cb.checked = false;
  const addr = cb.dataset.addr;
  if (addr) removeFromTable(addr);
  return true;
}

function onCheckboxChange(e) {
  e.stopPropagation();
  const cb = e.target;
  const cell = cb.closest('[data-testid^="table-cell-"]');
  setRowChecked(cell, cb.dataset.kind, cb.checked);
}

// Аватарка — единственный <img> в ячейке (иконки вокруг — все <svg>).
// Поднимаемся от неё вверх, пока не найдём узел с nextElementSibling —
// это и есть «блок аватарки», сразу после которого нужно воткнуть чекбокс,
// перед блоком с текстом адреса.
// Аватарка — единственный <img> в ячейке (иконки вокруг — все <svg>).
// Картинка обёрнута в <a href="/{chain}/address/0x...">, которая же
// оборачивает и адрес/имя кошелька. Вставляем чекбокс ПЕРЕД этой ссылкой
// целиком, СНАРУЖИ от неё — не внутрь, как было раньше (сразу после
// аватарки, но всё ещё внутри <a>).
//
// Почему это важно: страница React-приложение, и <a> — часть поддерева,
// которым React управляет через reconciliation (сверяет виртуальный DOM
// с реальным по позиции детей, без key — обычное дело для не-списковых
// элементов). Вставка живого DOM-узла ВНУТРЬ такого поддерева — риск для
// любого другого кода, который тоже что-то дорисовывает в то же
// поддерево (например ещё одно расширение, рисующее подпись под адресом
// — конкретный кейс, с которым столкнулся пользователь: с нашим
// чекбоксом внутри <a> чужая подпись переставала отрисовываться).
// Вставка СНАРУЖИ <a> эту категорию конфликтов убирает — мы больше не
// трогаем содержимое поддерева, которым владеет React, только добавляем
// СОСЕДА рядом с ним на уровне выше.
function findInsertionAnchor(cell) {
  const img = cell.querySelector('img');
  if (!img) return null;
  const link = img.closest('a');
  if (link && cell.contains(link) && link.parentElement) return link;
  // Фолбэк на старый алгоритм — для ячеек без <a> вокруг аватарки (в
  // данных пока не встречалось, но на всякий случай).
  let node = img;
  while (node && node !== cell && node.parentElement) {
    if (node.nextElementSibling) return node;
    node = node.parentElement;
  }
  return null;
}

function ensureCheckbox(cell, kind) {
  let cb = cell.querySelector('input.gw-cb');
  if (cb) return cb;

  cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'gw-cb';
  cb.dataset.kind = kind;
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('mousedown', (e) => e.stopPropagation());
  cb.addEventListener('change', onCheckboxChange);

  if (kind === 'holder' || kind === 'trader') {
    // На Holders/Top Traders — обратно в САМОЕ НАЧАЛО ячейки (там, где
    // рисовался изначально, при первом порте из test-gmgn-ext, до всех
    // последующих правок с якорями "перед аватаркой"/"перед <a>").
    // Перенос "перед <a>-ссылкой снаружи" (1.16.0) был попыткой решить
    // конфликт с другим расширением, дорисовывающим подпись под адресом
    // — по факту на этих двух вкладках проблема осталась (пользователь
    // проверил вживую), поэтому здесь возвращаем как было. На Activity
    // (kind === 'maker') логику "перед <a>" не трогаем — там, по словам
    // пользователя, проблемы не было.
    cell.insertBefore(cb, cell.firstChild);
  } else {
    const anchor = findInsertionAnchor(cell);
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(cb, anchor);
    } else {
      cell.insertBefore(cb, cell.firstChild);
    }
  }
  return cb;
}

// ══════════════════════════════════════════════════════════════════════════════
// Сканирование строк
// ══════════════════════════════════════════════════════════════════════════════

function scanRows() {
  const tokenAddr = currentTokenAddr();
  for (const [kind, sel] of Object.entries(ROW_SELECTORS)) {
    const cells = document.querySelectorAll(sel);
    for (const cell of cells) {
      const cb = ensureCheckbox(cell, kind);
      const addr = findAddrInCell(cell, kind);
      if (addr) {
        cb.dataset.addr = addr;
        cb.checked = _table.has(tableKey(tokenAddr, addr));
        cb.title = addr; // навести мышь — увидеть полный адрес, сверить с UI/Solscan
      } else if (!cb.dataset.addr) {
        cb.checked = false;
        cb.title = kind === 'trader' ? 'адрес пока не резолвнут (карта трейдеров грузится/не нашла)' : '';
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Массовое выделение мышью — тянем текст через несколько строк, отпускаем
// кнопку — все попавшие в выделение строки отмечаются чекбоксом.
// ══════════════════════════════════════════════════════════════════════════════

function handleSelectionMouseUp() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  if (!selection.toString().trim()) return;

  const range = selection.getRangeAt(0);
  let checkedCount = 0;
  let failedCount = 0;

  for (const [kind, sel] of Object.entries(ROW_SELECTORS)) {
    const cells = document.querySelectorAll(sel);
    for (const cell of cells) {
      const row = cell.closest('[data-testid$="-row"]') || cell;
      if (!range.intersectsNode(row)) continue;
      if (setRowChecked(cell, kind, true)) checkedCount++;
      else failedCount++;
    }
  }

  if (checkedCount || failedCount) {
    selection.removeAllRanges(); // снимаем подсветку — жест обработан
  }
}

document.addEventListener('mouseup', () => {
  // небольшая отсрочка — даём браузеру зафиксировать финальное состояние selection
  setTimeout(() => {
    try {
      handleSelectionMouseUp();
    } catch (err) {
      // не критично, следующее выделение отработает нормально
    }
  }, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// Реконсиляция из storage: сайдбар (или другая вкладка) удалили адрес —
// снимаем чекбокс здесь. Источник истины — storage, _table лишь кэш.
// ══════════════════════════════════════════════════════════════════════════════

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.gw_selected) return;
  const next = changes.gw_selected.newValue || [];
  const nextMap = new Map(next.map((item) => [tableKey(item.tokenAddr, item.addr), item]));

  const sameSize = _table.size === nextMap.size;
  const sameKeys = sameSize && [..._table.keys()].every((k) => nextMap.has(k));
  if (sameKeys) return; // это эхо нашей же записи — ничего не изменилось

  _applyingRemoteChange = true;
  _table.clear();
  for (const [k, v] of nextMap) _table.set(k, v);
  _applyingRemoteChange = false;

  // syncAllCheckboxes сверяется только с записями ТЕКУЩЕГО токена
  // (currentTokenAddr() внутри неё) — так что даже если реконсилировался
  // весь массив (все токены разом), на чекбоксах текущей страницы это
  // отражается корректно, без лишней фильтрации здесь.
  syncAllCheckboxes();
});

// ══════════════════════════════════════════════════════════════════════════════
// Init
// ══════════════════════════════════════════════════════════════════════════════

let _pendingScan = false;
const obs = new MutationObserver(() => {
  if (_pendingScan) return;
  _pendingScan = true;
  setTimeout(() => {
    _pendingScan = false;
    try {
      scanRows();
      updateTokenInfo(); // ретраит захват тикера, пока SPA не дорендерит шапку
    } catch (err) {
      // не критично, следующая мутация DOM пересканирует
    }
  }, 120);
});

function isOnTokenPage() {
  return TOKEN_PAGE_RE.test(location.pathname);
}

let _scanningActive = false;

function startScanning() {
  if (_scanningActive) return;
  _scanningActive = true;

  updateTokenInfo();

  // Подхватить то, что уже могло быть выбрано раньше (перезагрузка страницы,
  // либо адреса добавлены на другой вкладке — для любого токена, не только
  // текущего: _table держит полное зеркало storage, см. комментарий выше).
  seedTableFromStorage();

  scanRows();
  ensureTraderSnippetMap().catch(() => {});
  obs.observe(document.body, { childList: true, subtree: true });
}

function stopScanning() {
  if (!_scanningActive) return;
  _scanningActive = false;
  obs.disconnect();
}

// Раньше этот скрипт инжектился ТОЛЬКО если страница уже была
// /{chain}/token/* в момент ПОЛНОЙ загрузки (manifest matches). Если
// пользователь SPA-навигацией уходил на другую страницу gmgn.ai и потом
// возвращался на страницу токена — скрипт-то оставался жив (SPA, полной
// перезагрузки не было), но если ИЗНАЧАЛЬНАЯ загрузка вкладки была НЕ на
// токене, скрипт вообще ни разу не запускался. Починено: matches в
// manifest.json расширен до всего gmgn.ai (грузится везде), активное
// сканирование включается/выключается по факту URL через тот же
// поллинг location.href, что и раньше следил за сменой токена.
function init() {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', init);
    return;
  }
  injectStyles();
  if (isOnTokenPage()) startScanning();
}

let _lastUrl = '';
setInterval(() => {
  const url = location.href;
  if (url === _lastUrl) return;
  _lastUrl = url;
  const onToken = isOnTokenPage();
  if (onToken) {
    if (!_scanningActive) {
      startScanning();
    } else {
      try {
        updateTokenInfo();
        scanRows();
        ensureTraderSnippetMap().catch(() => {});
      } catch (err) {
        // не критично — следующий тик setInterval попробует снова
      }
    }
  } else {
    stopScanning();
  }
}, 500);

init();

} // конец guard __gwWalletScannerActive
