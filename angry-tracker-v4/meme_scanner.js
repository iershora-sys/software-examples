// Angry Tracker — Meme Scanner (MAIN world)
// Работает только на /meme/*?chain=sol
// Ищет кошельки во вкладках Holders / Top Traders и добавляет кубики блеклиста
'use strict';

const AT_CUBE_CLS  = 'at-bl-cube';
const AT_BAD_CLS   = 'at-bl-cube--bad';
const AT_CUBE_ATTR = 'data-at-bl-addr';
const AXIOM_RED    = '#f23645';

const AT_ICO_OUTLINE = '<svg class="at-bl-ico-outline" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M10.46 13.895H4.927C2.381 13.895 5.691 3 7.515 3h12.521c.532 0 .964.424.964.947v9.385a.95.95 0 0 1-.502.832c-2.062 1.106-4.481 2.012-5.678 4.129l-1.28 2.266a.87.87 0 0 1-.762.441c-3.18 0-2.237-4.63-1.805-6.47a.52.52 0 0 0-.513-.635"/></svg>';
const AT_ICO_SOLID   = '<svg class="at-bl-ico-solid" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M14.193 20.928a1.62 1.62 0 0 1-1.415.822c-1.005 0-1.773-.38-2.282-1.048c-.477-.628-.664-1.43-.723-2.189c-.106-1.37.188-2.908.404-3.868h-5.25c-.661 0-1.117-.389-1.364-.882c-.225-.446-.301-1.004-.312-1.556c-.021-1.124.23-2.564.607-3.956c.38-1.4.902-2.813 1.459-3.893c.276-.536.577-1.02.894-1.383c.28-.321.725-.725 1.304-.725h12.521c.935 0 1.714.748 1.714 1.697v9.385c0 .628-.349 1.199-.898 1.493m0 0c-.39.21-.773.402-1.148.591c-.68.343-1.335.673-1.973 1.07c-.958.596-1.746 1.27-2.258 2.176l-1.28 2.266"/></svg>';

// Пилюли: определения цветов
const AT_PILL_DEFS = {
  tracker: { label: 'TRACKER', color: '#a78bfa', bg: 'rgba(124,58,237,0.20)', border: 'rgba(124,58,237,0.45)' },
  fresh:   { label: 'FRESH',   color: '#7FFF00', bg: 'rgba(127,255,0,0.15)',  border: 'rgba(127,255,0,0.35)'  },
  devs:    { label: 'DEVS',    color: '#fb923c', bg: 'rgba(251,146,60,0.20)', border: 'rgba(251,146,60,0.45)' },
};

let _atMemeBlSet = new Set();
let _atMemeObs = null;
let _atMemeLastUrl = '';

// Lookup кеш
var _atLookupCache = new Map();  // addr → result
var _atLookupQueue = new Set();  // адреса в очереди
var _atLookupTimer = null;

// ── CSS ───────────────────────────────────────────────────────────────────────
// ── Pill builders ─────────────────────────────────────────────────────────────
function atBuildTypePill(key) {
  var p = AT_PILL_DEFS[key];
  var el = document.createElement('span');
  el.textContent = p.label;
  el.style.cssText = [
    'color:' + p.color, 'background:' + p.bg, 'border:1px solid ' + p.border,
    'display:inline-flex', 'align-items:center', 'height:14px', 'padding:0 5px',
    'border-radius:3px', 'font-size:10px', 'font-weight:600',
    'font-family:ui-monospace,monospace', 'white-space:nowrap', 'line-height:1',
  ].join(';');
  return el;
}

function atBuildGroupPill(name, color) {
  var r = parseInt(color.slice(1,3),16);
  var g = parseInt(color.slice(3,5),16);
  var b = parseInt(color.slice(5,7),16);
  var el = document.createElement('span');
  el.textContent = name;
  el.style.cssText = [
    'color:' + color, 'background:transparent',
    'border:1px solid rgba(' + r + ',' + g + ',' + b + ',0.40)',
    'display:inline-flex', 'align-items:center', 'height:14px', 'padding:0 5px',
    'border-radius:3px', 'font-size:11px', 'font-weight:600',
    'font-family:ui-monospace,monospace', 'white-space:nowrap',
    'overflow:hidden', 'text-overflow:ellipsis', 'max-width:200px', 'line-height:1',
  ].join(';');
  return el;
}

function atBuildSeparator() {
  var el = document.createElement('span');
  el.textContent = '|';
  el.style.cssText = 'color:rgba(255,255,255,0.25);font-size:11px;line-height:1;flex-shrink:0;';
  return el;
}

// ── ResizeObserver для пересчёта слота при сдвиге боковой панели ──────────────
var _atSlotRo = null;
var _atSlotRoContainer = null;

function atUpdateSlotRight(row, slot) {
  var cols = Array.from(row.children).filter(function(c) { return c !== slot; });
  var cutoff = cols[3];
  if (!cutoff || !row.isConnected) return;
  var rowRect    = row.getBoundingClientRect();
  var cutoffRect = cutoff.getBoundingClientRect();
  slot.style.right = Math.max(0, rowRect.right - cutoffRect.left) + 'px';
}

function atRecalcAllSlots() {
  document.querySelectorAll('.at-badge-slot').forEach(function(slot) {
    var row = slot.parentElement;
    if (row && row.isConnected) atUpdateSlotRight(row, slot);
  });
}

function atEnsureResizeObserver(row) {
  var container = row.parentElement && row.parentElement.parentElement;
  if (!container || container === _atSlotRoContainer) return;
  if (_atSlotRo) _atSlotRo.disconnect();
  _atSlotRo = new ResizeObserver(atRecalcAllSlots);
  _atSlotRo.observe(container);
  _atSlotRoContainer = container;
}

// ── Прижимаем первые 4 колонки к верху ───────────────────────────────────────
function atPinColumnsToTop(row) {
  if (row.dataset.atPinned) return;
  row.dataset.atPinned = '1';
  var cols = Array.from(row.children);
  for (var i = 0; i < Math.min(4, cols.length); i++) {
    cols[i].style.alignSelf = 'flex-start';
    cols[i].style.marginTop = '4px';
  }
}

// ── Badge slot ────────────────────────────────────────────────────────────────
function atInjectBadgeSlot(row, address) {
  if (row.dataset.atSlot) {
    if (address && !row.querySelector('.at-badge-slot').dataset.address) {
      row.querySelector('.at-badge-slot').dataset.address = address;
    }
    return;
  }
  row.dataset.atSlot = '1';
  row.style.position = 'relative';

  var slot = document.createElement('div');
  slot.className = 'at-badge-slot';
  slot.dataset.address = address || '';
  slot.style.cssText = [
    'position:absolute', 'bottom:1px', 'left:16px', 'height:20px',
    'border:none', 'box-sizing:border-box', 'pointer-events:none',
    'display:flex', 'align-items:center', 'gap:4px', 'padding:0 4px',
  ].join(';');
  row.appendChild(slot);

  requestAnimationFrame(function() {
    atUpdateSlotRight(row, slot);
    atEnsureResizeObserver(row);

    var cube = row.querySelector('.' + AT_CUBE_CLS);
    if (cube) {
      var slotRect = slot.getBoundingClientRect();
      var cubeRect = cube.getBoundingClientRect();
      var offset   = cubeRect.left - slotRect.left - 8;
      if (offset > 0) {
        var spacer = document.createElement('span');
        spacer.className = 'at-slot-spacer';
        spacer.style.cssText = 'display:inline-block;width:' + offset + 'px;flex-shrink:0;';
        slot.prepend(spacer);
      }
    }
  });
}

// ── Покраска заголовка meme-страницы ─────────────────────────────────────────
// Логика: смотрим кеш lookup всех видимых кошельков.
//   • Есть фармеры (group_id=3) → красный
//   • Есть трекер-кошельки (tables includes 'tracker') → оранжевый
//   • Ничего → снимаем цвет

var _atMemeHeaderEl = null;

function atGetMemeHeader() {
  if (_atMemeHeaderEl && _atMemeHeaderEl.isConnected) return _atMemeHeaderEl;
  var divs = document.querySelectorAll('div.flex');
  for (var i = 0; i < divs.length; i++) {
    var cls = divs[i].className || '';
    if (cls.indexOf('max-h-[64px]') !== -1 && cls.indexOf('min-h-[64px]') !== -1) {
      _atMemeHeaderEl = divs[i];
      return _atMemeHeaderEl;
    }
  }
  return null;
}

function atColorMemeHeader(status) {
  var hdr = atGetMemeHeader();
  if (!hdr) return;

  var old = hdr.querySelector('.at-meme-hdr-overlay');
  if (old) old.remove();

  if (!status) {
    hdr.style.removeProperty('border-color');
    return;
  }

  var color, borderColor;
  if (status === 'bad') {
    color       = 'rgba(242,54,69,0.18)';
    borderColor = 'rgba(242,54,69,0.40)';
  } else { // 'tracker'
    color       = 'rgba(239,145,26,0.15)';
    borderColor = 'rgba(239,145,26,0.35)';
  }

  var overlay = document.createElement('div');
  overlay.className = 'at-meme-hdr-overlay';
  overlay.style.cssText =
    'position:absolute;inset:0;pointer-events:none;z-index:0;' +
    'background:linear-gradient(to right,transparent 60%,' + color + ' 100%);' +
    'border-radius:inherit;';

  hdr.style.position  = 'relative';
  hdr.style.borderColor = borderColor;
  hdr.appendChild(overlay);
}

function atUpdateMemeHeader() {
  var hasFarmer  = false;
  var hasTracker = false;

  for (var entry of _atLookupCache) {
    var info = entry[1];
    if (!info || !Array.isArray(info.tables)) continue;
    if (info.meta && info.group_id === 3) { hasFarmer = true; break; }
    // group_id живёт в tracker_group
    if (info.tracker_group && info.tracker_group.group_id === 3) { hasFarmer = true; break; }
    if (info.tables.includes('tracker')) hasTracker = true;
  }

  if (hasFarmer)       atColorMemeHeader('bad');
  else if (hasTracker) atColorMemeHeader('tracker');
  else                 atColorMemeHeader(null);
}


// ── Текущий CA страницы ─────────────────────────────────────────────────────
// Решение диалога: URL страницы (/meme/{addr}?chain=sol) — это PA (bonding_curve
// до миграции, pool_address после), НЕ минт. У нас в _tokenMeta/_afTokenMeta
// (background.js) для каждого токена, хоть раз встречавшегося через SSE, уже
// лежит именно это значение в meta.pa (см. processEvent/ingestEvent — pa:
// tokenData.PA, и onAfFeedTokenUpdate — pa: t.bonding_curve). Значит основной,
// точный путь — спросить background "у кого pa == этот URL" (см. requestCaByPaFromBackground
// ниже). DOM-эвристика (title/data-*/клик-перехват) — только фолбэк для токенов,
// которых мы вообще ещё не видели через SSE ни разу.
const AT_MINT_RE    = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AT_MINT_RE_G  = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
let _atCurrentCA    = null;
let _atCurrentCaUrl = '';
let _atTtReported   = new Set(); // dedup: `${ca}|${wallet}` — не долбим background повторно

function getPoolAddressFromUrl() {
  var m = location.pathname.match(/\/meme\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return m ? m[1] : null;
}

// Спрашиваем background: есть ли у нас уже токен с таким pa (см. background.js
// findCaByPa). Асинхронно — результат кэшируется в _atCurrentCA, когда придёт.
function requestCaByPaFromBackground() {
  var pool = getPoolAddressFromUrl();
  if (!pool) { console.log('[TT-SCAN] getPoolAddressFromUrl: не удалось распарсить pool из URL'); return; }
  console.log('[TT-SCAN] requesting CA by PA (pool) from background:', pool);
  document.dispatchEvent(new CustomEvent('__at_resolve_ca_by_pa__', { detail: { pool: pool } }));
}

document.addEventListener('__at_resolve_ca_by_pa_res__', function(e) {
  var detail = e.detail || {};
  if (detail.pool !== getPoolAddressFromUrl()) return; // страница уже сменилась, ответ устарел
  if (detail.ok && detail.ca) {
    _atCurrentCA = detail.ca;
    _atCurrentCaUrl = location.href;
    console.log('[TT-SCAN] CA resolved via own registry (PA match, точно):', detail.ca);
    atApplyLookupResults(); // пересканировать — вдруг уже есть трекнутые кошельки в кеше lookup
  } else {
    console.log('[TT-SCAN] PA match miss — этот токен ещё не встречался через SSE, резолв уйдёт в DOM-эвристику (best-effort) при первом обращении');
  }
});

function resolveCurrentTokenCA() {
  if (_atCurrentCaUrl === location.href && _atCurrentCA) return _atCurrentCA;
  _atCurrentCaUrl = location.href;
  _atCurrentCA = null;

  var labels = Array.from(document.querySelectorAll('span, div, button, p')).filter(function(el) {
    var t = (el.textContent || '').trim();
    return t === 'CA' || t === 'CA:';
  });

  if (!labels.length) {
    console.log('[TT-SCAN] resolveCurrentTokenCA: лейбл "CA"/"CA:" не найден в DOM вообще');
    return null;
  }
  console.log('[TT-SCAN] resolveCurrentTokenCA: найдено', labels.length, 'лейбл(ов) "CA", пробую стратегии рядом с каждым');

  for (var i = 0; i < labels.length; i++) {
    var scope = labels[i];
    for (var hop = 0; hop < 5 && scope; hop++, scope = scope.parentElement) {
      // ── Стратегия 1: title="<адрес>" на любом потомке ──────────────────────
      var withTitle = scope.querySelectorAll('[title]');
      for (var j = 0; j < withTitle.length; j++) {
        var v1 = withTitle[j].getAttribute('title');
        if (v1 && AT_MINT_RE.test(v1)) {
          _atCurrentCA = v1;
          console.log('[TT-SCAN] CA resolved via title attr, hop=' + hop + ':', v1);
          return v1;
        }
      }
      // ── Стратегия 2: data-* атрибуты копирования ───────────────────────────
      var withData = scope.querySelectorAll(
        '[data-clipboard-text],[data-copy],[data-copy-text],[data-address],[data-value],[data-mint]'
      );
      for (var k = 0; k < withData.length; k++) {
        var el = withData[k];
        var v2 = el.getAttribute('data-clipboard-text') || el.getAttribute('data-copy') ||
                 el.getAttribute('data-copy-text') || el.getAttribute('data-address') ||
                 el.getAttribute('data-value') || el.getAttribute('data-mint');
        if (v2 && AT_MINT_RE.test(v2)) {
          _atCurrentCA = v2;
          console.log('[TT-SCAN] CA resolved via data-* attr, hop=' + hop + ':', v2);
          return v2;
        }
      }
      // ── Стратегия 3: клик-перехват window.open (как extractAddress) ────────
      var linkBtn = scope.querySelector(
        'button[aria-label*="olscan" i], a[aria-label*="olscan" i], ' +
        'button[aria-label*="xplorer" i], a[aria-label*="xplorer" i]'
      );
      if (linkBtn) {
        var captured = null;
        var origOpen = window.open;
        window.open = function(url) {
          if (typeof url === 'string') {
            var m = url.match(AT_MINT_RE_G);
            if (m) captured = m[0];
          }
        };
        try { linkBtn.click(); } catch (_) {}
        window.open = origOpen;
        if (captured) {
          _atCurrentCA = captured;
          console.log('[TT-SCAN] CA resolved via click-intercept, hop=' + hop + ':', captured);
          return captured;
        }
      }
    }
  }
  console.log('[TT-SCAN] could NOT resolve current CA from DOM после всех стратегий — пришлите HTML вокруг поля "CA:" в Token Info, поправлю селектор');
  return null;
}

function atApplyLookupResults() {
  var rows = Array.from(document.querySelectorAll('[class*="min-h-[48px]"]'))
    .filter(function(row) {
      return row.querySelector('button[aria-label="Open in Solscan"]') &&
             !row.querySelector('i.ri-water-flash-line');
    });

  rows.forEach(function(row) {
    var addr = row.dataset.atAddress;
    if (!addr) return;
    var info = _atLookupCache.get(addr);
    if (!info) return;
    atProcessRowInfo(row, addr, info);
  });
}

// ── Обработка одной строки: дозапись в реестр + рендер бейджей ────────────────
// (решение диалога — вынесено из atApplyLookupResults) — вызывается и батчем
// (сканирование всех строк), и СРАЗУ синхронно при инъекции слота в scanRows(),
// если инфа о кошельке уже в кеше. Второе критично против "моргания": строки
// Top Traders/Holders у Axiom виртуализированы (DOM пересоздаётся при скролле/
// частых апдейтах, особенно у Fresh-активности) — слот вставляется пустым, а
// раньше бейджи дорисовывались только на следующем батч-скане (дебаунс 120мс у
// MutationObserver) — за это время браузер успевал отрисовать пустой слот, отсюда
// видимое моргание. Теперь если info уже есть в кеше — рендерим бейджи в ТОМ ЖЕ
// синхронном тике, что и вставка слота, без видимого пустого кадра.
function atProcessRowInfo(row, addr, info) {
  var tables = info.tables || [];

  // ── Дозапись в Tracker реестр (решение диалога) ────────────────────────────
  // Не привязано к гейту "рендерим бейджи один раз" ниже — иначе если CA ещё не
  // резолвился на момент первого прохода (страница догружается), шанс теряется
  // навсегда для этой строки. Дедуп — через _atTtReported, не через DOM-флаг.
  if (tables.includes('tracker')) {
    var ca = resolveCurrentTokenCA();
    if (!ca) {
      console.log('[TT-SCAN] wallet', addr.slice(0, 8), 'is tracker, но CA страницы не резолвился — пропускаю');
    } else {
      var dedupKey = ca + '|' + addr;
      if (_atTtReported.has(dedupKey)) {
        // уже отправляли в этой сессии страницы — молчим, чтобы не спамить консоль
      } else {
        _atTtReported.add(dedupKey);
        var tg = info.tracker_group || null;
        console.log('[TT-SCAN] tracked wallet found on this token page → отправляю в background', { ca: ca, wallet: addr, group: tg && tg.group_name });
        document.dispatchEvent(new CustomEvent('__at_tt_wallet_found__', {
          detail: {
            ca:          ca,
            wallet:      addr,
            group_id:    tg ? tg.group_id : 0,
            group_name:  tg ? tg.group_name : '',
            group_color: tg ? (tg.text_bg_color || '#EF911A') : '#EF911A',
            is_bad:      !!(tg && tg.group_id === 3),
          },
        }));
      }
    }
  }

  // Дизлайк: скрываем для protected кошельков
  var cube = row.querySelector('.' + AT_CUBE_CLS);
  if (cube) cube.style.display = info.protected ? 'none' : '';

  // Слот: рендерим бейджи (один раз на ЭТОТ конкретный DOM-узел слота)
  var slot = row.querySelector('.at-badge-slot');
  if (!slot || slot.dataset.rendered) return;
  slot.dataset.rendered = '1';

  var spacer = slot.querySelector('.at-slot-spacer');
  slot.innerHTML = '';
  if (spacer) slot.appendChild(spacer);

  if (!tables.length) return;

  ['tracker', 'fresh', 'devs'].forEach(function(key) {
    if (tables.includes(key)) slot.appendChild(atBuildTypePill(key));
  });

  if (info.tracker_group) {
    slot.appendChild(atBuildSeparator());
    slot.appendChild(atBuildGroupPill(
      info.tracker_group.group_name,
      info.tracker_group.text_bg_color || '#EF911A'
    ));
  }
}

// ── Lookup scheduler ──────────────────────────────────────────────────────────
function atScheduleLookup(addr) {
  if (_atLookupCache.has(addr)) return;
  _atLookupQueue.add(addr);
  if (!_atLookupTimer) _atLookupTimer = setTimeout(atFlushLookup, 200);
}

function atFlushLookup() {
  _atLookupTimer = null;
  if (!_atLookupQueue.size) return;
  var addrs = Array.from(_atLookupQueue);
  _atLookupQueue.clear();
  document.dispatchEvent(new CustomEvent('__at_lookup_req__', {
    detail: { addresses: addrs },
  }));
}

// Слушаем ответ от bridge
document.addEventListener('__at_lookup_res__', function(e) {
  var detail = e.detail || {};
  if (!detail.ok) { console.warn('[AT][meme] lookup error:', detail.error); return; }
  var result = detail.data && detail.data.result;
  if (!result) return;
  Object.entries(result).forEach(function([addr, info]) {
    _atLookupCache.set(addr, info);
  });
  atApplyLookupResults();
  atUpdateMemeHeader();
});

function injectCubeStyles() {
  if (document.getElementById('at-cube-style')) return;
  var s = document.createElement('style');
  s.id = 'at-cube-style';
  s.textContent = `
    .at-bl-cube {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      align-self: center;
      cursor: pointer;
      transition: transform 0.1s, opacity 0.15s;
      z-index: 10;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0.8;
    }
    .at-bl-cube:hover { transform: scale(1.2); opacity: 1; }
    .at-bl-cube svg { width: 16px; height: 16px; display: block; }
    .at-bl-cube .at-bl-ico-solid   { display: none; }
    .at-bl-cube .at-bl-ico-outline { display: block; }
    .at-bl-cube.at-bl-cube--bad .at-bl-ico-outline { display: none; }
    .at-bl-cube.at-bl-cube--bad .at-bl-ico-solid   { display: block; }
    #at-meme-toast {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%);
      background: #1a1f2e;
      border: 1px solid rgba(239,68,68,0.4);
      color: #f4f7fb;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      padding: 8px 16px;
      border-radius: 8px;
      z-index: 2147483646;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s;
      white-space: nowrap;
    }
    #at-meme-toast.show { opacity: 1; }
  `;
  (document.head || document.documentElement).appendChild(s);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
var _atMemeToastTimer = null;
function showMemeToast(text) {
  if (!document.body) return;
  var el = document.getElementById('at-meme-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'at-meme-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(_atMemeToastTimer);
  _atMemeToastTimer = setTimeout(function() { el.classList.remove('show'); }, 2200);
}

// ── Storage: читаем blacklist через bridge relay ───────────────────────────────
function loadBlacklist() {
  var reqId = 'at_bl_' + Date.now();
  var handler = function(e) {
    if (e.detail.reqId !== reqId) return;
    document.removeEventListener('__at_storage_result__', handler);
    var list = e.detail.result && e.detail.result['at_wallet_bad_cache'];
    if (Array.isArray(list)) {
      _atMemeBlSet = new Set(list);
      updateAllCubes();
    }
  };
  document.addEventListener('__at_storage_result__', handler);
  document.dispatchEvent(new CustomEvent('__at_storage_get__', {
    detail: { reqId: reqId, key: 'at_wallet_bad_cache' }
  }));
  setTimeout(function() { document.removeEventListener('__at_storage_result__', handler); }, 3000);
}

// bridge уведомляет при изменении blacklist
document.addEventListener('__at_bl_updated__', function(e) {
  var list = e.detail && e.detail.list;
  if (Array.isArray(list)) {
    _atMemeBlSet = new Set(list);
    updateAllCubes();
  }
});

// Toast-фидбек от background: успех добавления или кошелёк неприкосаемый
document.addEventListener('__at_bl_toast__', function(e) {
  var text = e.detail && e.detail.text;
  if (text) showMemeToast(text);
});

// ── Обновляем цвета всех кубиков ──────────────────────────────────────────────
function updateAllCubes() {
  document.querySelectorAll('.' + AT_CUBE_CLS).forEach(function(cube) {
    var addr = cube.getAttribute(AT_CUBE_ATTR);
    if (!addr) return;
    if (_atMemeBlSet.has(addr)) cube.classList.add(AT_BAD_CLS);
    else cube.classList.remove(AT_BAD_CLS);
  });
}

// ── Извлекаем адрес из строки через window.open intercept ─────────────────────
function extractAddress(row) {
  var btn = row.querySelector('button[aria-label="Open in Solscan"]');
  if (!btn) return null;
  var captured = null;
  var origOpen = window.open;
  window.open = function(url) {
    if (url && url.includes('solscan.io/account/')) {
      captured = url.split('/account/')[1].split('?')[0];
    }
  };
  try { btn.click(); } catch (_) {}
  window.open = origOpen;
  return captured;
}

// ── Инжектируем кубик в строку ────────────────────────────────────────────────
function injectCube(row) {
  if (row.querySelector('.' + AT_CUBE_CLS)) return;
  var address = extractAddress(row);
  if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return;

  var container = row.querySelector('.flex.items-center.justify-start.gap-1')
               || row.querySelector('.flex.gap-1')
               || row.querySelector('.flex');
  if (!container) return;

  // Кубик ставим ПЕРЕД иконкой-воронкой (ri-filter-line), в начало строки.
  // Вставляем реальным flex-элементом (у группы иконок gap-[4px]) — строка
  // раздвигается, кубик не налезает на соседние элементы.
  var funnel     = row.querySelector('i.ri-filter-line');
  var funnelWrap = funnel && (funnel.closest('span.contents') || funnel.parentElement);

  var cube = document.createElement('div');
  cube.className = AT_CUBE_CLS + (_atMemeBlSet.has(address) ? ' ' + AT_BAD_CLS : '');
  cube.setAttribute(AT_CUBE_ATTR, address);
  cube.style.color = AXIOM_RED;
  cube.title = _atMemeBlSet.has(address) ? 'Remove from Blacklist' : 'Add to Blacklist';
  cube.innerHTML = AT_ICO_OUTLINE + AT_ICO_SOLID;

  cube.addEventListener('click', function(e) {
    e.stopPropagation();
    e.preventDefault();
    var isBad = _atMemeBlSet.has(address);
    document.dispatchEvent(new CustomEvent('__at_bl_action__', {
      detail: { address: address, action: isBad ? 'del' : 'add' }
    }));
    // Для 'del' — оптимистичный тост (всегда разрешено удалить из блеклиста).
    // Для 'add' — ждём фидбека от background через __at_bl_toast__:
    //   успех → '✓ Added to Blacklist', неприкосаемый → '⚠️ КОШЕЛЁК НЕПРИКОСАЕМЫЙ'
    if (isBad) showMemeToast('✓ Removed from Blacklist');
  });

  if (funnelWrap && funnelWrap.parentElement) {
    funnelWrap.parentElement.insertBefore(cube, funnelWrap); // перед воронкой
  } else {
    container.appendChild(cube); // запасной вариант — как было
  }
}

// ── Проверяем активна ли нужная вкладка ───────────────────────────────────────
function isTargetTab() {
  var buttons = document.querySelectorAll('button.group');
  for (var i = 0; i < buttons.length; i++) {
    var btn = buttons[i];
    // активная вкладка имеет элемент с border-b-[2px] в классе
    var active = btn.querySelector('[class*="border-b-"]');
    if (!active) continue;
    var text = (btn.querySelector('span') || btn).textContent.trim();
    if (text.includes('Holders') || text.includes('Top Traders')) return true;
  }
  return false;
}

// ── Сканируем строки ──────────────────────────────────────────────────────────
function scanRows() {
  if (!isTargetTab()) return;
  // Строки холдеров: min-h-[48px] в className
  var rows = document.querySelectorAll('[class*="min-h-[48px]"]');
  rows.forEach(function(row) {
    if (row.querySelector('i.ri-water-flash-line')) return; // smart money — пропускаем
    if (!row.querySelector('button[aria-label="Open in Solscan"]')) return;

    atPinColumnsToTop(row);
    injectCube(row);

    var addr = row.dataset.atAddress;
    if (!addr) {
      addr = extractAddress(row);
      if (addr) row.dataset.atAddress = addr;
    }
    if (addr) atScheduleLookup(addr);
    atInjectBadgeSlot(row, addr);

    // Если инфа уже в кеше (типичный случай для строк, вернувшихся после
    // скролла/пересоздания DOM — см. комментарий у atProcessRowInfo) — рендерим
    // бейджи ПРЯМО СЕЙЧАС, в этом же синхронном тике, а не ждём батч-скан через
    // 120мс debounce. Против моргания.
    if (addr) {
      var cachedInfo = _atLookupCache.get(addr);
      if (cachedInfo) atProcessRowInfo(row, addr, cachedInfo);
    }
  });

  // Перерисовываем из кеша все строки у которых слот ещё не отрендерен
  // (нужно для строк которые вернулись после скрола — их DOM пересоздан)
  atApplyLookupResults();
}

// ── Запуск/остановка observer ─────────────────────────────────────────────────
function startMemeObserver() {
  injectCubeStyles();
  loadBlacklist();

  if (!document.body) {
    document.addEventListener('DOMContentLoaded', function() { startMemeObserver(); });
    return;
  }

  scanRows();

  if (_atMemeObs) _atMemeObs.disconnect();

  var _scanPending = false;
  _atMemeObs = new MutationObserver(function() {
    if (_scanPending) return;
    _scanPending = true;
    setTimeout(function() { _scanPending = false; scanRows(); }, 120);
  });
  _atMemeObs.observe(document.body, { childList: true, subtree: true });
}

function stopMemeObserver() {
  if (_atMemeObs) { _atMemeObs.disconnect(); _atMemeObs = null; }
}

// ── Проверка URL — только /meme/*?chain=sol ───────────────────────────────────
function isMemePage() {
  return /\/meme\/[^?#]+(\?|&)[^#]*chain=sol/.test(location.href);
}

function checkPage() {
  var url = location.href;
  if (url === _atMemeLastUrl) return;
  _atMemeLastUrl = url;
  if (isMemePage()) {
    // Новый токен — сбрасываем кеш lookup, заголовок и CA-резолв
    _atLookupCache.clear();
    _atLookupQueue.clear();
    _atMemeHeaderEl = null;
    _atCurrentCA = null;
    _atCurrentCaUrl = '';
    _atTtReported.clear();
    atColorMemeHeader(null);
    startMemeObserver();
    requestCaByPaFromBackground(); // точный путь через уже известный PA — см. выше
  } else {
    stopMemeObserver();
  }
}

// SPA навигация
setInterval(checkPage, 500);
checkPage();

// ── Инвалидация кеша lookup при действиях из сайдбара ────────────────────────
// Сайдбар шлёт { type: 'del', address } после любого успешного действия с кошельком
// (удаление, блокировка, перемещение в группу). Сбрасываем кеш → перезапрашиваем
// lookup → перерисовываем бейджи сразу как приходит ответ 200.
(function() {
  var _atSbChannel = new BroadcastChannel('axiom_ca_logger');
  _atSbChannel.addEventListener('message', function(e) {
    var msg = e.data;
    var addr = msg && msg.address;
    if (!addr) return;

    // Сбрасываем кеш для этого адреса
    _atLookupCache.delete(addr);

    // Сбрасываем флаг rendered на слоте — позволит перерисовать бейджи
    var slots = document.querySelectorAll('.at-badge-slot[data-address="' + addr + '"]');
    slots.forEach(function(slot) {
      delete slot.dataset.rendered;
      var spacer = slot.querySelector('.at-slot-spacer');
      slot.innerHTML = '';
      if (spacer) slot.appendChild(spacer);
    });

    // Перезапрашиваем lookup и перерисовываем
    atScheduleLookup(addr);
    atUpdateMemeHeader();
  });
})();
