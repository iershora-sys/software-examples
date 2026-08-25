'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// GMGN Tracked Wallets Scanner — ISOLATED world, https://gmgn.ai/follow*
//
// Аналог gmgn/wallet_scanner.js (страница токена), но для страницы списка
// отслеживаемых кошельков. Верстка здесь другая — без data-testid (это не
// та же таблица, что на странице токена; тут drag-and-drop список через
// dnd-kit). Проверено по HTML-дампу страницы: [aria-roledescription=
// "sortable"] даёт ровно 1 элемент на кошелёк, 22 из 22 совпало 1-в-1,
// внутри каждого — a[href^="/{chain}/address/0x..."] с полным адресом
// (в отличие от Top Traders на странице токена, здесь огрызков нет вообще
// — резолвинг через API не нужен).
//
// Смысл чекбоксов здесь ОБРАТНЫЙ вачлист-сценарию: отмеченные адреса идут
// не на follow(), а на unfollow() — кнопка в сайдбаре так и называется
// "Отписать выбранные". Хранится отдельно от gw_selected (тот привязан к
// tokenAddr, здесь такого контекста нет) — chrome.storage.local['gw_tracking_selected'].
// ══════════════════════════════════════════════════════════════════════════════

if (window.__gwTrackedScannerActive) {
  // guard от двойной инициализации — см. паттерн в gmgn/inject.js
} else {
window.__gwTrackedScannerActive = true;

const ROW_SELECTOR = '[aria-roledescription="sortable"]';
const ADDR_RE = /0x[a-fA-F0-9]{40}/;

function injectStyles() {
  if (document.getElementById('gw-tracked-style')) return;
  const s = document.createElement('style');
  s.id = 'gw-tracked-style';
  s.textContent = `
    input.gw-tracked-cb {
      width:14px; height:14px; margin:0 8px 0 0; flex-shrink:0;
      cursor:pointer; accent-color:#ff4f29; vertical-align:middle;
    }
  `;
  (document.head || document.documentElement).appendChild(s);
}

// ══════════════════════════════════════════════════════════════════════════════
// Состояние — тот же паттерн, что в wallet_scanner.js: локальный Map как
// кэш, storage как источник истины (реконсиляция при удалении из сайдбара).
// ══════════════════════════════════════════════════════════════════════════════

const _table = new Map(); // addr -> { addr, ts }
let _applyingRemoteChange = false;

function persistSelected() {
  if (_applyingRemoteChange) return;
  chrome.storage.local
    .set({ gw_tracking_selected: [..._table.values()] })
    .catch(() => {});
}

function addToTable(addr) {
  if (_table.has(addr)) return;
  _table.set(addr, { addr, ts: Date.now() });
  persistSelected();
}

function removeFromTable(addr) {
  if (!_table.has(addr)) return;
  _table.delete(addr);
  persistSelected();
}

// ══════════════════════════════════════════════════════════════════════════════
// Извлечение адреса и чекбоксы
// ══════════════════════════════════════════════════════════════════════════════

function findAddrInRow(row) {
  const a = row.querySelector('a[href*="/address/0x"]');
  if (!a) return null;
  const m = a.getAttribute('href').match(ADDR_RE);
  return m ? m[0].toLowerCase() : null;
}

function syncAllCheckboxes() {
  document.querySelectorAll('input.gw-tracked-cb[data-addr]').forEach((cb) => {
    cb.checked = _table.has(cb.dataset.addr);
  });
}

// Аватарка — ПЕРВЫЙ прямой потомок <a href="/{chain}/address/0x...">.
// Раньше искали через "подняться от <img> вверх до первого предка с
// соседом" (как на странице токена) — не сработало стабильно здесь: у
// кошельков С кастомным именем (remark) аватарка обёрнута в кнопку
// редактирования emoji (UserAvatarWithEmojiEdit), у безымянных кошельков
// (показывают сырой адрес вместо имени) этой кнопки нет вообще — глубина
// вложенности от <img> до ближайшего соседа отличалась на 3 уровня между
// этими двумя случаями, из-за чего чекбокс вставал на разной высоте
// вложенности и визуально "плясал" по горизонтали между строками.
// Проверено HTML-дампом страницы: <a> всегда содержит РОВНО 3 прямых
// потомка (аватарка / имя+адрес / иконка копирования) — стабильно на всех
// 22 строках дампа, независимо от наличия кнопки редактирования.
//
// Возвращаем САМУ ССЫЛКУ целиком (не её первого потомка) — чекбокс
// вставляется ПЕРЕД ней, СНАРУЖИ. <a> — часть поддерева, которым React
// управляет через reconciliation; вставка живого DOM-узла ВНУТРЬ такого
// поддерева — риск для любого другого кода, дорисовывающего что-то в то
// же поддерево (конкретный кейс от пользователя: с чекбоксом внутри <a>
// на странице токена другое расширение переставало рисовать свою подпись
// под адресом — та же причина применима и здесь).
function findAvatarBlock(row) {
  const link = row.querySelector('a[href*="/address/0x"]');
  if (!link) return null;
  const firstChild = link.firstElementChild;
  return (firstChild && firstChild.querySelector('img')) ? link : null;
}

function ensureCheckbox(row) {
  let cb = row.querySelector('input.gw-tracked-cb');
  if (cb) return cb;

  cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'gw-tracked-cb';
  // Строка сама role="button" aria-roledescription="sortable" (drag-n-drop,
  // dnd-kit) — stopPropagation, чтобы клик по чекбоксу не триггерил драг/клик по строке.
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('mousedown', (e) => e.stopPropagation());
  cb.addEventListener('change', (e) => {
    e.stopPropagation();
    const addr = row.dataset.gwAddr;
    if (!addr) return;
    if (cb.checked) addToTable(addr);
    else removeFromTable(addr);
  });

  const avatarBlock = findAvatarBlock(row);
  if (avatarBlock && avatarBlock.parentElement) {
    // avatarBlock — теперь сама <a>-ссылка целиком (см. комментарий у
    // findAvatarBlock выше), вставляем чекбокс ПЕРЕД ней — визуально перед
    // аватаркой (она первая внутри ссылки), но структурно СНАРУЖИ ссылки.
    avatarBlock.parentElement.insertBefore(cb, avatarBlock);
  } else {
    row.insertBefore(cb, row.firstElementChild || null);
  }
  return cb;
}

function scanRows() {
  document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
    const addr = findAddrInRow(row);
    if (!addr) return;
    row.dataset.gwAddr = addr;
    const cb = ensureCheckbox(row);
    cb.dataset.addr = addr;
    cb.checked = _table.has(addr);
    cb.title = addr;
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Массовое выделение мышью — тот же приём, что на странице токена.
// ══════════════════════════════════════════════════════════════════════════════

function handleSelectionMouseUp() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  if (!selection.toString().trim()) return;

  const range = selection.getRangeAt(0);
  let checkedCount = 0;

  document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
    if (!range.intersectsNode(row)) return;
    const addr = row.dataset.gwAddr || findAddrInRow(row);
    if (!addr) return;
    row.dataset.gwAddr = addr;
    const cb = ensureCheckbox(row);
    cb.dataset.addr = addr;
    cb.checked = true;
    addToTable(addr);
    checkedCount++;
  });

  if (checkedCount) selection.removeAllRanges();
}

document.addEventListener('mouseup', () => {
  setTimeout(() => {
    try {
      handleSelectionMouseUp();
    } catch (err) {
      // не критично
    }
  }, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// Реконсиляция из storage (сайдбар удалил адрес — снимаем чекбокс здесь)
// ══════════════════════════════════════════════════════════════════════════════

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.gw_tracking_selected) return;
  const next = changes.gw_tracking_selected.newValue || [];
  const nextMap = new Map(next.map((item) => [item.addr, item]));

  const sameSize = _table.size === nextMap.size;
  const sameKeys = sameSize && [..._table.keys()].every((k) => nextMap.has(k));
  if (sameKeys) return;

  _applyingRemoteChange = true;
  _table.clear();
  for (const [k, v] of nextMap) _table.set(k, v);
  _applyingRemoteChange = false;

  syncAllCheckboxes();
});

// ══════════════════════════════════════════════════════════════════════════════
// Init — старт/стоп сканирования по URL, тот же приём, что уже был в
// wallet_scanner.js. Раньше этот скрипт инжектился ТОЛЬКО если страница
// уже была /follow* в момент ПОЛНОЙ загрузки (manifest matches). Если
// пользователь SPA-навигацией переходил на /follow с другой страницы gmgn.ai
// (например со страницы токена, без перезагрузки), скрипт вообще ни разу
// не запускался в этой вкладке — никакой поллинг ВНУТРИ него не помог бы,
// потому что его просто не было. Починено: matches в manifest.json расширен
// до всего gmgn.ai (скрипт теперь грузится везде), а активное сканирование
// (чекбоксы, MutationObserver) включается/выключается по факту URL —
// изменение самого пути отслеживается тем же поллингом location.href, что
// у "живых таблиц" на странице токена.
// ══════════════════════════════════════════════════════════════════════════════

function isOnFollowPage() {
  return /^\/follow(\/|$)/.test(location.pathname);
}

let _pendingScan = false;
const obs = new MutationObserver(() => {
  if (_pendingScan) return;
  _pendingScan = true;
  setTimeout(() => {
    _pendingScan = false;
    try {
      scanRows();
    } catch (err) {
      // не критично, следующая мутация DOM пересканирует
    }
  }, 120);
});

let _scanningActive = false;

function startScanning() {
  if (_scanningActive) return;
  _scanningActive = true;

  chrome.storage.local.get('gw_tracking_selected').then((res) => {
    const arr = res.gw_tracking_selected || [];
    for (const item of arr) _table.set(item.addr, item);
    if (arr.length) syncAllCheckboxes();
  }).catch(() => {});

  scanRows();
  obs.observe(document.body, { childList: true, subtree: true });
}

function stopScanning() {
  if (!_scanningActive) return;
  _scanningActive = false;
  obs.disconnect();
}

function init() {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', init);
    return;
  }
  injectStyles();
  if (isOnFollowPage()) startScanning();
}

let _lastUrl = location.href;
setInterval(() => {
  const url = location.href;
  if (url === _lastUrl) return;
  _lastUrl = url;
  if (isOnFollowPage()) {
    if (!_scanningActive) startScanning();
    else scanRows(); // уже сканировали — просто досканировать на смену URL (например другая страница /follow)
  } else {
    stopScanning();
  }
}, 500);

init();

} // конец guard __gwTrackedScannerActive
