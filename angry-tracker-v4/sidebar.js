'use strict';

const plog = () => {};  // console logging отключён
const slog = () => {}; // scroll debug — отключён

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// BOT_BASE_URL объявлен в botapi.js

// ── Extension context guard ───────────────────────────────────────────────────
function ctxOk() {
  try { return !!chrome.runtime?.id; } catch (_) { return false; }
}
function safeStorage() {
  if (!ctxOk()) { setTimeout(() => { try { location.reload(); } catch (_) {} }, 800); return null; }
  return chrome.storage.local;
}
async function storageGet(key) {
  const s = safeStorage(); if (!s) return {};
  try { return await s.get(key); } catch (_) { return {}; }
}
async function storageSet(obj) {
  const s = safeStorage(); if (!s) return;
  try { await s.set(obj); } catch (_) {}
}

// ── BroadcastChannel ──────────────────────────────────────────────────────────
const _sbChannel = new BroadcastChannel('axiom_ca_logger');
function broadcastDelete(address) { _sbChannel.postMessage({ type: 'del', address }); }

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast visible' + (isError ? ' error' : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('visible'), 2200);
}

// ── Toggle helper ─────────────────────────────────────────────────────────────
function makeToggle(initialValue, onChange) {
  const label = document.createElement('label');
  label.className = 'at-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = initialValue;
  input.addEventListener('change', () => onChange(input.checked));
  const slider = document.createElement('span');
  slider.className = 'at-toggle-slider';
  label.appendChild(input);
  label.appendChild(slider);
  return label;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function solscanLink(path, text, cls) {
  const a = document.createElement('a');
  a.href = 'https://solscan.io/' + path;
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = text;
  if (cls) a.className = cls;
  return a;
}

function copyToClipboard(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
  return Promise.resolve();
}

function makeCopyBtn(address) {
  const btn = document.createElement('button');
  btn.className = 'at-copy-btn';
  btn.innerHTML = AT_SVG_COPY;
  btn.title = 'Copy';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    copyToClipboard(address).then(() => {
      btn.classList.add('at-copy-btn--copied');
      setTimeout(() => btn.classList.remove('at-copy-btn--copied'), 800);
    });
  });
  return btn;
}

function makeAddrChip(address, linkPath, extraClass, displayText) {
  const wrap = document.createElement('span');
  wrap.className = 'at-addr-chip';

  const a = document.createElement('a');
  a.className = extraClass || 'wg-list-addr';
  a.textContent = displayText || address;
  a.href = 'https://solscan.io/' + (linkPath || 'account/' + address);
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  wrap.appendChild(a);

  const btn = document.createElement('button');
  btn.className = 'at-copy-btn';
  btn.innerHTML = AT_SVG_COPY;
  btn.title = 'Copy';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    copyToClipboard(address).then(() => {
      btn.classList.add('at-copy-btn--copied');
      setTimeout(() => btn.classList.remove('at-copy-btn--copied'), 800);
    });
  });
  wrap.appendChild(btn);

  return wrap;
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  GROUPS                                                                 ██
// ══════════════════════════════════════════════════════════════════════════════

const GROUPS_STORAGE_KEY    = 'at_groups_cache';

let _groups = []; // все группы с сервера

async function loadGroups() {
  // Background держит at_groups_cache актуальным через SSE — читаем мгновенно
  const r = await storageGet(GROUPS_STORAGE_KEY);
  const cached = r[GROUPS_STORAGE_KEY];
  if (cached?.length) { _groups = cached; return; }
  // Fallback: первый старт после переустановки, кэш пуст — восстанавливаем из БД
  try {
    flashApiLed();
    const res  = await fetch(BOT_BASE_URL + '/groups');
    const data = await res.json();
    if (data.status === 'OK') {
      _groups = data.result || [];
      storageSet({ [GROUPS_STORAGE_KEY]: _groups });
    }
  } catch (_) {}
}

function getGroupsByUiSection(ui_section) {
  return _groups.filter(g => g.ui_section === ui_section);
}

function getGroupById(id) {
  return _groups.find(g => g.group_id === id);
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  API-ПОИСК КАРТОЧКИ (фолбэк, когда токена нет в локальном реестре)      ██
// ══════════════════════════════════════════════════════════════════════════════
// См. API-FEED.md §2 + разбор с покраской токена: локальные _tokenRegistry/_afReg
// здесь, в sidebar, — всего лишь КОПИЯ (синхронизируется через at-state/at-signal/
// af-state/af-signal) и может отстать от настоящего источника истины —
// _tokenRegistry/_afRegistry в background.js (оттуда же берёт данные paint через
// processEvent/processAfEvent). Поэтому порядок поиска:
//   1. background: свой live-реестр (без сети, всегда актуален) — Tracker И Fresh.
//   2. только если и там пусто (Tracker) — API: /tokens/search → /token/{mint}/tracker-event,
//      мержится в реестр тем же ingestEvent(), что и live/snapshot-путь.
// Fresh-эквивалента внешнего API нет (только tracker) — см. фикс в background.js,
// для Fresh шаг 1 — единственная проверка.
const API_SEARCH_MIN_LEN  = 2;
const API_SEARCH_DEBOUNCE = 650;
let _apiSearchTimer       = null;
let _lastApiSearchedQuery = '';

// Локальные проверки (та же логика, что фильтр в createFeedManager.sorted()) —
// чтобы не дёргать background/API, если карточка и так уже на экране.
function hasLocalTrackerMatch(q) {
  const query = q.toLowerCase();
  for (const [ca, swaps] of Object.entries(_tokenRegistry)) {
    if (!swaps?.length) continue;
    const m = _tokenMeta[ca] || {};
    if ((m.symbol || '').toLowerCase().includes(query) ||
        (m.name   || '').toLowerCase().includes(query) ||
        ca.toLowerCase().includes(query)) return true;
  }
  return false;
}

function hasLocalFreshMatch(q) {
  const query = q.toLowerCase();
  for (const [ca, swaps] of Object.entries(_afReg)) {
    if (!swaps?.length) continue;
    const m = _afMeta[ca] || {};
    if ((m.symbol || '').toLowerCase().includes(query) ||
        (m.name   || '').toLowerCase().includes(query) ||
        ca.toLowerCase().includes(query)) return true;
  }
  return false;
}

function scheduleApiTokenSearch(query) {
  clearTimeout(_apiSearchTimer);
  if (query.length < API_SEARCH_MIN_LEN) return;
  _apiSearchTimer = setTimeout(() => runApiTokenSearch(query), API_SEARCH_DEBOUNCE);
}

async function runApiTokenSearch(query, immediate = false) {
  console.log('[SEARCH] runApiTokenSearch: query=', JSON.stringify(query), 'immediate=', immediate);
  if (query.length < API_SEARCH_MIN_LEN) { console.log('[SEARCH] abort: query too short'); return; }
  if (!immediate && query === _lastApiSearchedQuery) { console.log('[SEARCH] abort: same as last searched query'); return; }
  const needTracker = !hasLocalTrackerMatch(query);
  const needFresh   = !hasLocalFreshMatch(query);
  console.log('[SEARCH] needTracker=', needTracker, 'needFresh=', needFresh);
  if (!needTracker && !needFresh) { console.log('[SEARCH] abort: both sides already have a local match'); return; }
  _lastApiSearchedQuery = query;

  showToast(`Ищу «${query}»…`);

  const safeSend = (type) => chrome.runtime.sendMessage({ type, query })
      .catch((e) => ({ ok: false, reason: 'error', error: e?.message || String(e) }));

  const [atResp, afResp] = await Promise.all([
    needTracker ? safeSend('at-search-token') : Promise.resolve(null),
    needFresh   ? safeSend('af-search-token') : Promise.resolve(null),
  ]);

  console.log('[SEARCH] atResp=', JSON.stringify({...atResp, swaps: atResp?.swaps ? `[${atResp.swaps.length} items]` : undefined}));
  console.log('[SEARCH] afResp=', JSON.stringify({...afResp, swaps: afResp?.swaps ? `[${afResp.swaps.length} items]` : undefined}));

  if (_filterQuery !== query) { console.log('[SEARCH] abort: filter changed. now=', _filterQuery, 'was=', query); return; }

  // Мержим найденное НАПРЯМУЮ из ответа — не полагаемся только на отдельный
  // broadcastState()/broadcastAfState() (fire-and-forget chrome.runtime.sendMessage
  // из background, без гарантии доставки/тайминга): у нас уже есть swaps/meta
  // прямо в ответе на at-search-token/af-search-token, этого достаточно для рендера.
  if (atResp?.ok && atResp.mint) {
    console.log('[SEARCH] merging AT: mint=', atResp.mint, 'swaps=', atResp.swaps?.length,
      'maxTs=', atResp.swaps?.length ? Math.max(...atResp.swaps.map(s=>s.ts||0)) : null,
      'now=', Date.now(), 'STALE_MS=', STALE_MS, 'meta=', JSON.stringify(atResp.meta));
    if (Array.isArray(atResp.swaps) && atResp.swaps.length) _tokenRegistry[atResp.mint] = atResp.swaps;
    else console.log('[SEARCH] WARNING: atResp.swaps missing/empty — nothing merged into _tokenRegistry!', atResp.swaps);
    if (atResp.meta && typeof atResp.meta === 'object')     _tokenMeta[atResp.mint]     = atResp.meta;
    console.log('[SEARCH] _tokenRegistry[mint] now =', _tokenRegistry[atResp.mint]?.length, 'items. Calling atManager.patch()');
    atManager.patch();
    console.log('[SEARCH] atManager.patch() done. sig-list children now:', document.getElementById('sig-list')?.children.length);
  }
  if (afResp?.ok && afResp.mint) {
    console.log('[SEARCH] merging AF: mint=', afResp.mint, 'swaps=', afResp.swaps?.length,
      'maxTs=', afResp.swaps?.length ? Math.max(...afResp.swaps.map(s=>s.ts||0)) : null, 'now=', Date.now());
    if (Array.isArray(afResp.swaps) && afResp.swaps.length) _afReg[afResp.mint]  = afResp.swaps;
    else console.log('[SEARCH] WARNING: afResp.swaps missing/empty — nothing merged into _afReg!', afResp.swaps);
    if (afResp.meta && typeof afResp.meta === 'object')     _afMeta[afResp.mint] = afResp.meta;
    if (afResp.score) _afScores[afResp.mint] = { level: afResp.score.level, cardType: afResp.score.cardType };
    console.log('[SEARCH] _afReg[mint] now =', _afReg[afResp.mint]?.length, 'items. Calling afManager.patch()');
    afManager.patch();
    console.log('[SEARCH] afManager.patch() done. sig-list-fresh children now:', document.getElementById('sig-list-fresh')?.children.length);
  }

  const found = [];
  if (atResp?.ok) found.push(`Tracker: ${atResp.symbol || atResp.mint.slice(0, 8)} (${atResp.swaps_count})`);
  if (afResp?.ok) found.push(`Fresh: ${afResp.symbol || afResp.mint.slice(0, 8)} (${afResp.swaps_count})`);

  if (found.length) {
    showToast('✓ Найдено — ' + found.join(' · '));
  } else if (!needTracker || !needFresh) {
    // Хотя бы одна сторона уже была видна локально (поэтому её и не искали —
    // atResp/afResp остались null для неё) — карточка и так на экране, это не
    // "не найдено". Раньше здесь ошибочно падали в общий "не найдено" ниже.
    showToast('✓ Уже в ленте');
  } else if (atResp?.reason === 'no_tracker_activity') {
    showToast('Токен найден, но tracker-активности по нему нет', true);
  } else {
    showToast('Не найдено ни локально, ни через API', true);
  }
}

// Заполняем select элемент группами
function populateGroupSelect(selectEl, groups, allLabel = 'All groups', selectedVal = 'all') {
  selectEl.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = 'all'; allOpt.textContent = allLabel;
  selectEl.appendChild(allOpt);
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = g.group_id; opt.textContent = g.name;
    selectEl.appendChild(opt);
  }
  selectEl.value = String(selectedVal);
}

// ── Main tab switching ────────────────────────────────────────────────────────
const TAB_STORAGE_KEY = 'at_active_tab';

document.getElementById('btn-tab-tracker').addEventListener('click',  () => switchTab('tracker', true));
document.getElementById('btn-tab-groups').addEventListener('click',   () => switchTab('groups', true));

function switchTab(tab, save) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('btn-tab-' + tab).classList.add('active');
  document.getElementById('panel-' + tab).classList.add('active');
  if (tab === 'groups' && !_groupsSlotsLoaded) { _groupsSlotsLoaded = true; renderSlots(); }
  if (tab === 'groups') refreshGroupsFromApi();
  if (save) storageSet({ [TAB_STORAGE_KEY]: tab });
  updateFooter();
}


// ══════════════════════════════════════════════════════════════════════════════
// ██  LIST (slot=0)                                                           ██
// ══════════════════════════════════════════════════════════════════════════════

// ── Кеш кошельков Blacklist ──────────────────────────────────────────────────
const BL_WALLETS_CACHE_KEY = 'at_bl_wallets_cache';

let _blWallets = null;

let _blRefreshTimer = null;
function startBlacklistRefresh() {
  stopBlacklistRefresh();
  _blRefreshTimer = setInterval(() => wgRefreshBlacklistStates(), 10_000);
}
function stopBlacklistRefresh() {
  clearInterval(_blRefreshTimer);
  _blRefreshTimer = null;
}




// ══════════════════════════════════════════════════════════════════════════════
// ██  COLOR PICKER                                                           ██
// ══════════════════════════════════════════════════════════════════════════════

const AT_PALETTE = [
  '#EF911A','#FF3B30','#FF9500','#FFCC00',
  '#34C759','#00C7BE','#007AFF','#5856D6',
  '#8B0000','#FF00A8','#00FF85','#00BFFF',
  '#FFD700','#FF6A00','#7B00FF','#00FFD1',
];

let _colorPickerEl = null;

function showColorPicker(anchor, currentColor, onPick) {
  // Закрываем предыдущий
  if (_colorPickerEl) { _colorPickerEl.remove(); _colorPickerEl = null; }

  const picker = document.createElement('div');
  picker.className = 'at-color-picker';
  _colorPickerEl = picker;

  const grid = document.createElement('div');
  grid.className = 'at-color-picker-grid';

  for (const color of AT_PALETTE) {
    const swatch = document.createElement('div');
    swatch.className = 'at-color-picker-swatch';
    swatch.style.background = color;
    if (color.toLowerCase() === currentColor.toLowerCase()) {
      swatch.classList.add('active');
    }
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick(color);
      picker.remove();
      _colorPickerEl = null;
    });
    grid.appendChild(swatch);
  }

  picker.appendChild(grid);

  // Позиционируем под кнопкой
  const rect = anchor.getBoundingClientRect();
  const sidebarRect = document.body.getBoundingClientRect();
  picker.style.top  = (rect.bottom - sidebarRect.top + 4) + 'px';
  picker.style.left = (rect.left   - sidebarRect.left)    + 'px';

  document.body.appendChild(picker);

  // Закрытие по клику вне
  const closeHandler = (e) => {
    if (!picker.contains(e.target) && e.target !== anchor) {
      picker.remove(); _colorPickerEl = null;
      document.removeEventListener('click', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
}

// ── Export dropdown menu ──────────────────────────────────────────────────────

let _exportMenuEl = null;

function showExportMenu(anchor, getRows, filenameBase, opts = {}) {
  if (_exportMenuEl) { _exportMenuEl.remove(); _exportMenuEl = null; }

  const menu = document.createElement('div');
  menu.className = 'at-export-menu';
  _exportMenuEl = menu;

  const emoji     = opts.emoji  ?? '😊';
  const alertsOn  = opts.alerts ?? true;

  function doDownload(content, ext) {
    const ts       = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
    const filename = `${filenameBase}-${ts}.${ext}`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const items = [
    {
      icon: '📄',
      label: 'Export as *.txt',
      action() {
        const rows = getRows();
        if (!rows.length) { showToast('Nothing to export', true); return; }
        const addresses = rows.map(r => r.dataset.address).filter(Boolean);
        doDownload(addresses.join('\n'), 'txt');
        showToast(`✓ Exported ${addresses.length} wallets`);
      },
    },
    {
      icon: '⚡',
      label: 'Export as AXIOM',
      action() {
        const rows = getRows();
        if (!rows.length) { showToast('Nothing to export', true); return; }
        const entries = rows.map(r => r.dataset.address).filter(Boolean).map(addr => ({
          trackedWalletAddress: addr,
          name:           _walletNameCache[addr] || addr.slice(0, 8) + '…' + addr.slice(-4),
          emoji,
          alertsOnToast:  alertsOn,
          alertsOnBubble: alertsOn,
          alertsOnFeed:   alertsOn,
          groups:         ['Main'],
          sound:          'default',
        }));
        doDownload(JSON.stringify(entries, null, 2), 'json');
        showToast(`✓ Exported ${entries.length} wallets (AXIOM)`);
      },
    },
  ];

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'at-export-menu-item';
    const icon = document.createElement('span');
    icon.className = 'at-export-menu-icon';
    icon.textContent = item.icon;
    const label = document.createElement('span');
    label.textContent = item.label;
    row.appendChild(icon);
    row.appendChild(label);
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove(); _exportMenuEl = null;
      item.action();
    });
    menu.appendChild(row);
  }

  const rect       = anchor.getBoundingClientRect();
  const bodyRect   = document.body.getBoundingClientRect();
  menu.style.top   = (rect.bottom - bodyRect.top + 4) + 'px';
  menu.style.right = (bodyRect.right - rect.right) + 'px';
  document.body.appendChild(menu);

  const closeHandler = (e) => {
    if (!menu.contains(e.target) && e.target !== anchor) {
      menu.remove(); _exportMenuEl = null;
      document.removeEventListener('click', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
}



const SLOTS_ORDER_KEY = 'at_slots_order';

// ── Кэш кошельков слотов (stale-while-revalidate) ────────────────────────────
const SLOT_WALLETS_KEY = 'at_slot_wallets_cache';
let _slotWalletsCache  = {};     // group_id → wallets[]
let _slotCacheLoaded   = false;
let _slotCacheSaveTimer = null;
function scheduleSlotCacheSave() {
  clearTimeout(_slotCacheSaveTimer);
  _slotCacheSaveTimer = setTimeout(() => storageSet({ [SLOT_WALLETS_KEY]: _slotWalletsCache }), 500);
}
function renderSlotWallets(body, group, wallets) {
  body.innerHTML = '';
  if (!wallets || !wallets.length) {
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:8px 12px; font-size:11px; color:var(--text-muted);';
    hint.textContent = 'No wallets';
    body.appendChild(hint);
    return;
  }
  for (const w of wallets) body.appendChild(buildSlotWalletRow(w, group));
}

async function getSlotsOrder() {
  const r = await storageGet(SLOTS_ORDER_KEY);
  return Array.isArray(r[SLOTS_ORDER_KEY]) ? r[SLOTS_ORDER_KEY] : [];
}

async function saveSlotsOrder() {
  const container = document.getElementById('at-slots-list');
  const order = [...container.querySelectorAll('.at-slot-wrap')]
    .map(c => parseInt(c.dataset.groupId, 10));
  await storageSet({ [SLOTS_ORDER_KEY]: order });
}

async function renderSlots() {
  const container = document.getElementById('at-slots-list');
  const empty     = document.getElementById('at-slots-empty');
  container.innerHTML = '';

  // Кэш кошельков слотов — читаем один раз, дальше рисуем из него мгновенно
  if (!_slotCacheLoaded) {
    const r = await storageGet(SLOT_WALLETS_KEY);
    _slotWalletsCache = r[SLOT_WALLETS_KEY] || {};
    _slotCacheLoaded = true;
  }

  const slotGroups = getGroupsByUiSection(1);
  empty.style.display = slotGroups.length ? 'none' : '';

  // Сортируем по сохранённому порядку
  const order = await getSlotsOrder();
  if (order.length) {
    slotGroups.sort((a, b) => {
      const ia = order.indexOf(a.group_id);
      const ib = order.indexOf(b.group_id);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }

  for (const group of slotGroups) {
    container.appendChild(buildSlotCard(group));
  }

  initSlotsDnD(container);
}

// ── Drag-and-drop для слотов (iOS-style live reorder) ────────────────────────
let _slotsSortable = null;

function initSlotsDnD(container) {
  if (_slotsSortable) { _slotsSortable.destroy(); _slotsSortable = null; }
  _slotsSortable = Sortable.create(container, {
    handle:      '.at-slot-drag-handle',
    animation:   150,
    ghostClass:  'at-slot-ghost',
    chosenClass: 'at-slot-chosen',
    onEnd() { saveSlotsOrder(); },
  });
}

function buildSlotCard(group) {
  const wrap = document.createElement('div');
  wrap.className = 'at-slot-wrap';
  wrap.dataset.groupId = group.group_id;

  const card = document.createElement('div');
  card.className = 'at-slot-card';
  card.dataset.groupId = group.group_id;
  wrap.appendChild(card);

  // Drag handle — снаружи карточки, справа
  const dragHandle = document.createElement('div');
  dragHandle.className = 'at-slot-drag-handle';
  dragHandle.innerHTML = AT_SVG_MOVE_GROUP;
  dragHandle.title = 'Drag to reorder';

  wrap.appendChild(dragHandle);

  // ── Header ────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'at-slot-card-header';

  // Color picker
  const colorWrap = document.createElement('div');
  colorWrap.className = 'at-slot-color-wrap';

  const colorBtn = document.createElement('div');
  colorBtn.className = 'at-slot-color-btn';
  colorBtn.style.background = group.overlay_color || '#EF911A';
  colorBtn.title = 'Pick color';
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showColorPicker(colorBtn, group.overlay_color || '#EF911A', async (newColor) => {
      colorBtn.style.background = newColor;
      try {
        await apiGroupUpdate(group.group_id, { overlay_color: newColor, text_bg_color: newColor });
        group.overlay_color = newColor;
        group.text_bg_color = newColor;
        await storageSet({ [GROUPS_STORAGE_KEY]: _groups });
        card.querySelectorAll('.at-slot-color-btn, .at-slot-wallet-swatch').forEach(b => { b.style.background = newColor; });
      } catch (e2) { showToast(e2.message, true); colorBtn.style.background = group.overlay_color; }
    });
  });

  colorWrap.appendChild(colorBtn);
  header.appendChild(colorWrap);

  // Name input
  const nameInput = document.createElement('input');
  nameInput.className = 'at-slot-name';
  nameInput.value = group.name;
  nameInput.maxLength = 44;
  const doSlotRename = async () => {
    const newName = nameInput.value.trim();
    if (!newName || newName === group.name) { nameInput.value = group.name; return; }
    try {
      await apiGroupUpdate(group.group_id, { name: newName });
      group.name = newName;
      await storageSet({ [GROUPS_STORAGE_KEY]: _groups });
      showToast('✓ Renamed');
    } catch (e) { showToast(e.message, true); nameInput.value = group.name; }
  };
  nameInput.addEventListener('blur', doSlotRename);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } });
  header.appendChild(nameInput);

  // Delete slot button
  const slotDelBtn = document.createElement('button');
  slotDelBtn.className = 'wg-list-del';
  slotDelBtn.innerHTML = AT_SVG_TRASH;
  slotDelBtn.title     = 'Delete slot (wallets → Main)';
  slotDelBtn.addEventListener('click', async () => {
    try {
      await apiGroupDelete(group.group_id);
      const idx = _groups.findIndex(g => g.group_id === group.group_id);
      if (idx !== -1) _groups.splice(idx, 1);
      wrap.remove();
      showToast('✓ Slot deleted, wallets → Main');
      const container = document.getElementById('at-slots-list');
      if (container && !container.querySelector('.at-slot-wrap')) {
        document.getElementById('at-slots-empty').style.display = '';
      }
    } catch (e) { showToast(e.message, true); }
  });
  header.appendChild(slotDelBtn);

  card.appendChild(header);

  // ── Description ─────────────────────────────────────────────────────────
  const slotDescWrap = document.createElement('div');
  slotDescWrap.style.cssText = 'padding:6px 12px 4px; border-bottom:1px solid var(--border);';
  const slotDescArea = document.createElement('textarea');
  slotDescArea.className = 'at-slot-desc-area';
  slotDescArea.placeholder = 'description…';
  slotDescArea.rows = 1;
  const slotAutoGrow = () => { slotDescArea.style.height = 'auto'; slotDescArea.style.height = slotDescArea.scrollHeight + 'px'; };
  let _slotDescTimer;
  slotDescArea.addEventListener('input', () => {
    slotAutoGrow();
    clearTimeout(_slotDescTimer);
    _slotDescTimer = setTimeout(() => apiGroupUpdate(group.group_id, { description: slotDescArea.value || null }).catch(() => {}), 600);
  });
  slotDescArea.addEventListener('focus', () => { slotDescArea.classList.add('has-focus'); });
  slotDescArea.addEventListener('blur',  () => { slotDescArea.classList.remove('has-focus'); });
  const _slotDescInit = group.description || '';
  slotDescArea.value = _slotDescInit;
  if (_slotDescInit) slotDescArea.classList.add('has-value');
  slotAutoGrow();
  slotDescWrap.appendChild(slotDescArea);
  card.appendChild(slotDescWrap);

  // ── Settings: Transfers / Swaps / Min buy ─────────────────────────────────
  const checks = document.createElement('div');
  checks.className = 'at-group-card-checks';

  const makeSlotCheck = (label, field, currentVal) => {
    const row = document.createElement('div');
    row.className = 'at-toggle-row';
    const lbl = document.createElement('span');
    lbl.className = 'at-toggle-row-label';
    lbl.textContent = label;
    const tog = makeToggle(!!currentVal, async (val) => {
      try {
        await apiGroupUpdate(group.group_id, { [field]: val ? 1 : 0 });
        group[field] = val ? 1 : 0;
      } catch (e) { showToast(e.message, true); tog.querySelector('input').checked = !val; }
    });
    row.appendChild(lbl);
    row.appendChild(tog);
    return row;
  };

  checks.appendChild(makeSlotCheck('Transfers', 'track_transfers', group.track_transfers));
  checks.appendChild(makeSlotCheck('Swaps',     'track_swaps',     group.track_swaps));
  card.appendChild(checks);

  const buyRow = document.createElement('div');
  buyRow.className = 'at-group-card-checks';
  buyRow.style.cssText = 'border-top:1px solid var(--border); margin-top:2px; padding-top:6px;';

  const buyLabel = document.createElement('label');
  buyLabel.className = 'at-group-check'; buyLabel.style.gap = '6px';

  const buyInput = document.createElement('input');
  buyInput.type = 'number'; buyInput.className = 'settings-input';
  buyInput.min = '0'; buyInput.step = '0.0001';
  buyInput.value = group.min_buy_amount != null ? group.min_buy_amount : 0.1;
  buyInput.style.cssText = 'width:70px; font-size:11px;';
  let _slotBuyTimer = null;
  buyInput.addEventListener('input', () => {
    clearTimeout(_slotBuyTimer);
    _slotBuyTimer = setTimeout(async () => {
      let v = parseFloat(buyInput.value);
      if (!isFinite(v) || v < 0) v = 0;
      buyInput.value = v;
      try {
        await apiGroupUpdate(group.group_id, { min_buy_amount: v });
        group.min_buy_amount = v;
      } catch (e) { showToast(e.message, true); buyInput.value = group.min_buy_amount; }
    }, 600);
  });

  const buyUnit = document.createElement('span');
  buyUnit.style.cssText = 'font-size:11px; color:var(--text-muted);';
  buyUnit.textContent = 'SOL Min buy amount to track';
  buyLabel.appendChild(buyInput); buyLabel.appendChild(buyUnit);
  buyRow.appendChild(buyLabel);
  card.appendChild(buyRow);

  // ── Body: wallets ─────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'at-slot-card-body';

  // Кошельки грузятся асинхронно — карточка появляется мгновенно
  fillSlotBody(body, group);

  card.appendChild(body);

  // ── Add wallet row ────────────────────────────────────────────────────────
  const addRow = document.createElement('div');
  addRow.className = 'at-slot-add-row';

  const addInput = document.createElement('input');
  addInput.className   = 'at-slot-add-input';
  addInput.placeholder = 'Wallet address…';
  addInput.autocomplete = 'off';
  addInput.spellcheck  = false;

  const addBtn = document.createElement('button');
  addBtn.className   = 'at-slot-add-btn';
  addBtn.textContent = 'ADD';

  const doAdd = async () => {
    const addr = addInput.value.trim();
    if (!addr || !SOL_RE.test(addr)) { showToast('Invalid address', true); return; }
    try {
      await apiAddWallets([{ address: addr, good: true, group_id: group.group_id }], 'tracker');
      // Убираем "No wallets" hint если был
      body.querySelectorAll('div').forEach(d => { if (d.textContent === 'No wallets') d.remove(); });
      body.insertBefore(buildSlotWalletRow({ address: addr, state: 'new' }, group), body.firstChild);
      addInput.value = '';
      showToast('✓ Added');
    } catch (e) { showToast(e.message, true); }
  };

  addBtn.addEventListener('click', doAdd);
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  card.appendChild(addRow);

  return wrap;
}

async function fillSlotBody(body, group) {
  const gid    = group.group_id;
  const cached = _slotWalletsCache[gid];

  // 1. Мгновенно из кэша (реальные кошельки, без «Loading…»)
  if (cached) {
    renderSlotWallets(body, group, cached);
  } else {
    const loading = document.createElement('div');
    loading.style.cssText = 'padding:8px 12px; font-size:11px; color:var(--text-muted);';
    loading.textContent = 'Loading…';
    body.appendChild(loading);
  }

  // 2. Ревалидация в фоне → обновляем только при изменении
  try {
    const result  = await apiRecent('tracker', { limit: 10, group_id: gid });
    const wallets  = result?.wallets || [];
    const changed  = JSON.stringify(wallets) !== JSON.stringify(_slotWalletsCache[gid] || []);
    _slotWalletsCache[gid] = wallets;
    if (changed) scheduleSlotCacheSave();
    if (!cached || changed) renderSlotWallets(body, group, wallets);
  } catch (_) {
    if (!cached) body.innerHTML = '';
  }
}

function buildSlotWalletRow(w, group) {
  const row = document.createElement('div');
  row.className = 'at-slot-wallet-row';
  row.dataset.address = w.address;

  row.appendChild(makeAddrChip(w.address, 'account/' + w.address, 'at-slot-wallet-addr'));

  // Color swatch
  const colorSwatch = document.createElement('div');
  colorSwatch.className = 'at-slot-color-btn at-slot-wallet-swatch';
  colorSwatch.style.background = group.overlay_color || '#EF911A';
  colorSwatch.style.cursor = 'default';
  colorSwatch.style.width  = '14px';
  colorSwatch.style.height = '14px';
  row.appendChild(colorSwatch);

  const delBtn = document.createElement('button');
  delBtn.className = 'wg-list-del'; delBtn.innerHTML = AT_SVG_TRASH;
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const result = await apiDelWallet(w.address, 'tracker');
      if (result.deleted) {
        row.remove(); broadcastDelete(w.address); showToast('✓ Deleted');
      } else { showToast('Not found', true); }
    } catch (err) { showToast(err.message, true); }
  });
  row.appendChild(delBtn);
  return row;
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  GROUPS MANAGEMENT                                                      ██
// ══════════════════════════════════════════════════════════════════════════════


let _groupsListLoaded    = false;
let _groupsBlLoaded      = false;
let _groupsSlotsLoaded   = false;
let _groupsActiveSub     = 'slots';

document.querySelectorAll('[data-groups-tab]').forEach(btn => {
  btn.addEventListener('click', () => groupsSubSwitch(btn.dataset.groupsTab));
});

async function refreshGroupsFromApi() {
  try {
    flashApiLed();
    const res  = await fetch(BOT_BASE_URL + '/groups');
    const data = await res.json();
    if (data.status !== 'OK') return;
    const fresh = data.result || [];
    if (JSON.stringify(fresh) === JSON.stringify(_groups)) return;
    _groups = fresh;
    storageSet({ [GROUPS_STORAGE_KEY]: _groups });
    // Перерисовываем активную sub-панель
    _groupsSlotsLoaded = false;
    _groupsListLoaded  = false;
    _groupsBlLoaded    = false;
    groupsSubSwitch(_groupsActiveSub || 'slots');
  } catch (_) {}
}

function groupsSubSwitch(tab) {
  document.querySelectorAll('[data-groups-tab]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#panel-groups .wg-subpanel').forEach(p => p.classList.remove('active'));
  const btn = document.querySelector(`[data-groups-tab="${tab}"]`);
  if (btn) btn.classList.add('active');
  const panel = document.getElementById('groups-sub-' + tab);
  if (panel) panel.classList.add('active');
  _groupsActiveSub = tab;

  if (tab === 'slots'     && !_groupsSlotsLoaded) { _groupsSlotsLoaded = true; renderSlots(); }
  if (tab === 'list'      && !_groupsListLoaded)  { _groupsListLoaded  = true; renderGroupsPanel(0); }
  if (tab === 'blacklist' && !_groupsBlLoaded)    { _groupsBlLoaded    = true; renderGroupsPanel(99); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  PRIORITY                                                               ██
// ══════════════════════════════════════════════════════════════════════════════

function renderGroupsPanel(ui_section) {
  const isBlacklist   = ui_section === 99;
  const containerId   = isBlacklist ? 'at-groups-bl-container'  : 'at-groups-list-container';
  const emptyId       = isBlacklist ? 'at-groups-bl-empty'      : 'at-groups-list-empty';
  const container     = document.getElementById(containerId);
  const empty         = document.getElementById(emptyId);
  container.innerHTML = '';

  const groups = getGroupsByUiSection(ui_section);
  empty.style.display = groups.length ? 'none' : '';

  for (const g of groups) {
    container.appendChild(buildGroupCard(g));
  }
}

function buildGroupCard(group) {
  const ui_section  = group.ui_section;
  const isBlacklist = ui_section === 99;
  const containerId = isBlacklist ? 'at-groups-bl-container'  : 'at-groups-list-container';
  const emptyId     = isBlacklist ? 'at-groups-bl-empty'      : 'at-groups-list-empty';
  const isSleeping  = group.group_id === 7; // 7 = Sleeping group

  const card = document.createElement('div');
  card.className = 'at-slot-card';
  card.dataset.groupId = group.group_id;

  // ── Header ────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'at-slot-card-header';

  // Color swatch — text_bg_color
  const colorWrap = document.createElement('div');
  colorWrap.className = 'at-slot-color-wrap';
  const colorBtn = document.createElement('div');
  colorBtn.className = 'at-slot-color-btn';
  colorBtn.style.background = group.text_bg_color || '#EF911A';
  colorBtn.title = 'Pick label color';
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showColorPicker(colorBtn, group.text_bg_color || '#EF911A', async (newColor) => {
      colorBtn.style.background = newColor;
      try {
        await apiGroupUpdate(group.group_id, { text_bg_color: newColor });
        group.text_bg_color = newColor;
        await storageSet({ [GROUPS_STORAGE_KEY]: _groups });
      } catch (e2) { showToast(e2.message, true); colorBtn.style.background = group.text_bg_color; }
    });
  });
  colorWrap.appendChild(colorBtn);
  header.appendChild(colorWrap);

  // Name input
  const nameInput = document.createElement('input');
  nameInput.className = 'at-slot-name';
  nameInput.value     = group.name;
  nameInput.maxLength = 44;
  if (isSleeping) {
    nameInput.disabled = true;
    nameInput.style.opacity = '0.5';
    nameInput.style.cursor  = 'default';
  } else {
    const doRename = async () => {
      const newName = nameInput.value.trim();
      if (!newName || newName === group.name) { nameInput.value = group.name; return; }
      try {
        await apiGroupUpdate(group.group_id, { name: newName });
        group.name = newName;
        await storageSet({ [GROUPS_STORAGE_KEY]: _groups });
        showToast('✓ Renamed');
      } catch (e) { showToast(e.message, true); nameInput.value = group.name; }
    };
    nameInput.addEventListener('blur', doRename);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } });
  }
  header.appendChild(nameInput);

  // Delete button — hidden for Sleeping Wallets
  if (!isSleeping) {
    const delBtn = document.createElement('button');
    delBtn.className = 'wg-list-del';
    delBtn.innerHTML = AT_SVG_TRASH;
    delBtn.title     = 'Delete group (wallets → Main)';
    delBtn.addEventListener('click', async () => {
      try {
        await apiGroupDelete(group.group_id);
        const idx = _groups.findIndex(g => g.group_id === group.group_id);
        if (idx !== -1) _groups.splice(idx, 1);
        card.remove();
        showToast('✓ Group deleted, wallets → Main');
        if (!document.querySelector(`#${containerId} .at-slot-card`)) {
          document.getElementById(emptyId).style.display = '';
        }
      } catch (e) { showToast(e.message, true); }
    });
    header.appendChild(delBtn);
  }

  card.style.borderRadius = '10px'; // override at-slot-card's 10px 0 0 10px (no drag handle here)
  card.appendChild(header);


  // ── Description ─────────────────────────────────────────────────────
  const descWrap = document.createElement('div');
  descWrap.style.cssText = 'padding:6px 12px 4px; border-bottom:1px solid var(--border);';
  const descArea = document.createElement('textarea');
  descArea.className = 'at-slot-desc-area';
  descArea.placeholder = 'description…';
  descArea.rows = 1;
  // Auto-grow
  const autoGrow = () => { descArea.style.height = 'auto'; descArea.style.height = descArea.scrollHeight + 'px'; };
  let _descTimer;
  descArea.addEventListener('input', () => {
    autoGrow();
    clearTimeout(_descTimer);
    _descTimer = setTimeout(() => apiGroupUpdate(group.group_id, { description: descArea.value || null }).catch(() => {}), 600);
  });
  descArea.addEventListener('focus', () => { descArea.classList.add('has-focus'); });
  descArea.addEventListener('blur',  () => { descArea.classList.remove('has-focus'); });
  // Load from API data
  const _descInit = group.description || '';
  descArea.value = _descInit;
  if (_descInit) descArea.classList.add('has-value');
  autoGrow();
  descWrap.appendChild(descArea);
  card.appendChild(descWrap);
  // ── Settings ──────────────────────────────────────────────────────────────
  const makeCheck = (label, field, currentVal) => {
    const row = document.createElement('div');
    row.className = 'at-toggle-row';
    const lbl = document.createElement('span');
    lbl.className = 'at-toggle-row-label';
    lbl.textContent = label;
    const tog = makeToggle(!!currentVal, async (val) => {
      try {
        await apiGroupUpdate(group.group_id, { [field]: val ? 1 : 0 });
        group[field] = val ? 1 : 0;
      } catch (e) { showToast(e.message, true); tog.querySelector('input').checked = !val; }
    });
    row.appendChild(lbl);
    row.appendChild(tog);
    return row;
  };

  const checks = document.createElement('div');
  checks.className = 'at-group-card-checks';
  checks.appendChild(makeCheck('Transfers', 'track_transfers', group.track_transfers));
  checks.appendChild(makeCheck('Swaps',     'track_swaps',     group.track_swaps));
  card.appendChild(checks);

  const buyRow = document.createElement('div');
  buyRow.className = 'at-group-card-checks';
  buyRow.style.cssText = 'border-top:1px solid var(--border); margin-top:2px; padding-top:6px;';
  const buyLabel = document.createElement('label');
  buyLabel.className = 'at-group-check'; buyLabel.style.gap = '6px';
  const buyInput = document.createElement('input');
  buyInput.type = 'number'; buyInput.className = 'settings-input';
  buyInput.min = '0'; buyInput.step = '0.0001';
  buyInput.value = group.min_buy_amount != null ? group.min_buy_amount : 0.1;
  buyInput.style.cssText = 'width:70px; font-size:11px;';
  let _buyTimer = null;
  buyInput.addEventListener('input', () => {
    clearTimeout(_buyTimer);
    _buyTimer = setTimeout(async () => {
      let v = parseFloat(buyInput.value);
      if (!isFinite(v) || v < 0) v = 0;
      buyInput.value = v;
      try {
        await apiGroupUpdate(group.group_id, { min_buy_amount: v });
        group.min_buy_amount = v;
      } catch (e) { showToast(e.message, true); buyInput.value = group.min_buy_amount; }
    }, 600);
  });
  const buyUnit = document.createElement('span');
  buyUnit.style.cssText = 'font-size:11px; color:var(--text-muted);';
  buyUnit.textContent = 'SOL Min buy amount to track';
  buyLabel.appendChild(buyInput); buyLabel.appendChild(buyUnit);
  buyRow.appendChild(buyLabel);
  card.appendChild(buyRow);

  return card;
}

async function apiGroupDelete(group_id) {
  return apiFetch('/groups/delete', BOT_BASE_URL + '/groups/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id }),
  });
}

async function apiGroupMove(address, group_id) {
  return apiFetch('/groups/move', BOT_BASE_URL + '/groups/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, group_id }),
  });
}

// ── Group Picker Modal ────────────────────────────────────────────────────────
(function() {
  const modal   = document.getElementById('gp-modal');
  const closeBtn = document.getElementById('gp-modal-close');
  const list    = document.getElementById('gp-modal-list');
  const okBtn   = document.getElementById('gp-modal-ok');

  let _selectedId  = null;
  let _onConfirm   = null;

  function closeGpModal() { modal.style.display = 'none'; }
  closeBtn.addEventListener('click', closeGpModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeGpModal(); });

  okBtn.addEventListener('click', async () => {
    if (_selectedId == null) return;
    okBtn.disabled = true;
    try { await _onConfirm(_selectedId); closeGpModal(); }
    catch (e) { showToast(e.message || 'Ошибка', true); }
    finally { okBtn.disabled = false; }
  });

  window.openGroupPickerModal = function(currentGroupId, onConfirm) {
    _selectedId = null;
    _onConfirm  = onConfirm;

    // Фильтруем: убираем lock-группу (ui_section=98)
    const groups = _groups.filter(g => g.ui_section !== 98);

    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const g of groups) {
      const item = document.createElement('div');
      item.className = 'gp-group-item' + (g.group_id === currentGroupId ? ' gp-selected' : '');
      item.dataset.gid = g.group_id;
      if (g.group_id === currentGroupId) _selectedId = g.group_id;

      const dot    = document.createElement('span'); dot.className = 'gp-dot';
      const swatch = document.createElement('span'); swatch.className = 'gp-swatch';
      swatch.style.background = g.text_bg_color || '#EF911A';
      const name   = document.createElement('span'); name.className = 'gp-name';
      name.textContent = g.name;

      item.append(dot, swatch, name);
      item.addEventListener('click', () => {
        list.querySelectorAll('.gp-group-item').forEach(el => el.classList.remove('gp-selected'));
        item.classList.add('gp-selected');
        _selectedId = g.group_id;
      });
      frag.appendChild(item);
    }
    list.appendChild(frag);

    // Скроллим к текущей группе
    requestAnimationFrame(() => {
      const cur = list.querySelector('.gp-selected');
      if (cur) cur.scrollIntoView({ block: 'center' });
    });

    modal.style.display = 'flex';
  };
})();


(function () {
  const modal    = document.getElementById('dw-modal');
  const closeBtn = document.getElementById('dw-modal-close');

  function closeDwModal() { modal.style.display = 'none'; }
  closeBtn.addEventListener('click', closeDwModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeDwModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.style.display !== 'none') closeDwModal(); });

  window.openDeleteWalletModal = function(address, swap, onSuccess) {
    // Адрес
    document.getElementById('dw-addr-text').textContent = address;
    // Заменяем copy-кнопку на стандартную makeCopyBtn каждый раз при открытии
    const copyPlaceholder = document.getElementById('dw-copy-placeholder');
    copyPlaceholder.innerHTML = '';
    copyPlaceholder.appendChild(makeCopyBtn(address));
    document.getElementById('dw-solscan-btn').href = `https://solscan.io/account/${address}`;

    // Текущая группа
    const groupRow = document.getElementById('dw-group-row');
    groupRow.innerHTML = '';
    if (swap.group_name) {
      const badge = document.createElement('span');
      badge.textContent = swap.group_name;
      badge.style.cssText = `display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;font-family:ui-monospace,monospace;background:${(swap.group_color||'#EF911A')}CC;color:#fff;`;
      groupRow.appendChild(badge);
    }

    // Сбрасываем обработчики
    const setup = (id, fn) => {
      const btn = document.getElementById(id);
      btn.onclick = async () => {
        btn.disabled = true;
        try { await fn(); closeDwModal(); onSuccess && onSuccess(); }
        catch (e) { showToast(e.message || 'Ошибка', true); }
        finally { btn.disabled = false; }
      };
    };

    // [1] Удалить из БД
    setup('dw-btn-del', async () => {
      const r = await apiDelWallet(address, 'tracker');
      if (!r.deleted) throw new Error('Not deleted');
      showToast('🗑 Удалено из БД');
      broadcastDelete(address);
    });

    // [2] Удалить и заблокировать
    setup('dw-btn-lock', async () => {
      const r = await apiDelAndLockWallet(address, 'tracker');
      if (!r.locked && !r.deleted) throw new Error('Lock failed');
      showToast('🔒 Помещён в НЕПРИКАСАЕМЫЕ');
      updateLockCache(address, true).catch(() => {});
      broadcastDelete(address);
    });

    // Кнопка "Фармеры" — скрываем если уже в группе 3
    document.getElementById('dw-btn-farmer').style.display =
      swap.group_id === 3 ? 'none' : '';

    // [3] Перенести в фармеры (group_id = 3)
    setup('dw-btn-farmer', async () => {
      await apiGroupMove(address, 3);
      showToast('🌾 В фармеры');
      broadcastDelete(address);
    });

    // [4] Переместить в группу…
    document.getElementById('dw-btn-move').onclick = () => {
      openGroupPickerModal(swap.group_id, async (groupId) => {
        await apiGroupMove(address, groupId);
        const g = _groups.find(x => x.group_id === groupId);
        showToast('→ ' + (g ? g.name : groupId));
        closeDwModal();
        onSuccess && onSuccess();
      });
    };

    modal.style.display = 'flex';
  };
})();



document.getElementById('wg-move-modal-close').addEventListener('click', closeMoveModal);
document.getElementById('wg-move-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('wg-move-modal')) closeMoveModal();
});

function closeMoveModal() {
  document.getElementById('wg-move-modal').style.display = 'none';
}

// ui_section — фильтр групп для показа (0 или 99)
function openMoveModal(address, currentGroupId, ui_section, onMoved) {
  const body   = document.getElementById('wg-move-modal-body');
  const groups = getGroupsByUiSection(ui_section);

  body.innerHTML = '';

  // Добавляем Main (group_id=0) только для slot=0
  const allGroups = ui_section === 0
    ? [{ group_id: 0, name: 'Main' }, ...groups]
    : groups;

  for (const g of allGroups) {
    const row = document.createElement('div');
    row.className = 'at-move-group-row' + (g.group_id === currentGroupId ? ' at-move-group-row--current' : '');

    const swatch = document.createElement('div');
    swatch.className = 'at-move-group-swatch';
    swatch.style.background = g.text_bg_color || (ui_section === 99 ? '#BE3030' : '#EF911A');
    row.appendChild(swatch);

    const name = document.createElement('span');
    name.className   = 'at-move-group-name';
    name.textContent = g.name + (g.group_id === currentGroupId ? ' ✓' : '');
    row.appendChild(name);

    if (g.group_id !== currentGroupId) {
      row.addEventListener('click', async () => {
        try {
          await apiGroupMove(address, g.group_id);
          closeMoveModal();
          showToast(`✓ Moved to ${g.name}`);
          onMoved(g.group_id);
        } catch (err) { showToast(err.message, true); }
      });
    }

    body.appendChild(row);
  }

  document.getElementById('wg-move-modal').style.display = 'flex';
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  SIGNAL                                                                 ██
// ══════════════════════════════════════════════════════════════════════════════

const SIGNAL_MAX = 100;         // максимум карточек в ленте (решение диалога, было 50)
// TTL по возрасту убран целиком (решение диалога): было 5 минут — абсурдно мало для
// колонки на 100 карточек, отсеивало реальные найденные события. Теперь только
// capping по количеству (SIGNAL_MAX/AF_MAX_SIGNALS) — что нашли, то и рисуем,
// сортировка по recency, без отсечки по возрасту. STALE_MS оставлен как имя
// константы = 0 (а не удалён), чтобы не переписывать сигнатуры ниже — везде, где
// он передаётся как staleMs/используется в сравнении, 0 означает "фильтр выключен".
const STALE_MS   = 0;
const SWAP_COLLAPSE_LIMIT = 8;  // показываем первые N свапов, остальные под пилюлей



// Signal registry (token-grouped cards, like fresh)
let _tokenRegistry = {}; // ca → swaps[]
let _tokenMeta     = {}; // ca → {name, symbol, image, da, pa, dev_buy_sol, dev_balance_before}
let _sigCards      = new Map(); // ca → DOM element
let _filterQuery   = '';

let _signals       = [];





function formatAge(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60)    return s + 's ago';
  if (s < 3600)  return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// Короткий формат без "ago" — для карточек токенов
function formatShort(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5)     return s + 's';
  if (s < 60)    return s + 's';
  if (s < 3600)  return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

// ── Audio ─────────────────────────────────────────────────────────────────────
let _atAudioCtx      = null;
let _atLastSoundAt   = 0;
let _atAudioPending  = null; // тип ожидающего звука

let _soundSwap     = true;

const AT_SOUND_KEY          = 'at_sound_settings';

function _atGetAudioCtx() {
  if (_atAudioCtx) return _atAudioCtx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  _atAudioCtx = new Ctor();
  return _atAudioCtx;
}

(function() {
  const unlock = () => {
    const ctx = _atGetAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().then(() => {
      if (_atAudioPending) { const t = _atAudioPending; _atAudioPending = null; _atPlayTones(t); }
    }).catch(() => {});
    document.removeEventListener('click',   unlock, true);
    document.removeEventListener('keydown', unlock, true);
  };
  document.addEventListener('click',   unlock, true);
  document.addEventListener('keydown', unlock, true);
})();

const SOUND_TONES = {
  swap: [
    { freq: 660, type: 'sine', offset: 0,    dur: 0.12, vol: 0.18 },
    { freq: 880, type: 'sine', offset: 0.10, dur: 0.14, vol: 0.15 },
  ],
  transfer: [
    { freq: 520, type: 'sine', offset: 0, dur: 0.18, vol: 0.14 },
  ],
  wakeup: [
    { freq: 780, type: 'sine', offset: 0,    dur: 0.13, vol: 0.16 },
    { freq: 520, type: 'sine', offset: 0.11, dur: 0.15, vol: 0.13 },
  ],
  bundler: [
    { freq: 220, type: 'square', offset: 0,    dur: 0.10, vol: 0.20 },
    { freq: 180, type: 'square', offset: 0.09, dur: 0.10, vol: 0.18 },
    { freq: 140, type: 'square', offset: 0.18, dur: 0.12, vol: 0.16 },
  ],
};

function _atPlayTones(type) {
  try {
    const now = Date.now();
    if (now - _atLastSoundAt < 500) return;
    const ctx = _atGetAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') { _atAudioPending = type; return; }
    _atLastSoundAt = now;
    const t     = ctx.currentTime;
    const tones = SOUND_TONES[type] || SOUND_TONES.swap;
    tones.forEach(({ freq, type: wt, offset, dur, vol }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = wt;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, t + offset);
      gain.gain.linearRampToValueAtTime(0.001, t + offset + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t + offset);
      osc.stop(t + offset + dur + 0.02);
    });
  } catch (_) {}
}

function playSignalSound()   { if (_soundSwap)     _atPlayTones('swap');     }



// ── Token Card (signal) ───────────────────────────────────────────────────────

function mkIconBtn(svgHtml, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'icon-btn'; btn.title = title; btn.innerHTML = svgHtml;
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return btn;
}

function mkThumb(mint, image) {
  const img = document.createElement('img');
  img.className = 'tc-thumb'; img.alt = '';
  const primary  = image || `https://axiomtrading-v2.axiom-cdn.io/${mint}.webp`;
  const fallback = `https://axiomtrading-v2.axiom-cdn.io/${mint}.webp`;
  img.src = primary;
  img.addEventListener('error', () => {
    if (img.src !== fallback) { img.src = fallback; return; }
    img.style.visibility = 'hidden';
  });
  return img;
}

// ── Shared card utils ──────────────────────────────────────────────────────────

// Строка адреса: [copy] [↗ solscan] addr…
function buildAddrRow(lbl, addr, url) {
  const row = document.createElement('div'); row.className = 'tc-addr-row';
  row.appendChild(mkIconBtn(AT_SVG_COPY, `Copy ${lbl}`, () => copyToClipboard(addr)));
  const a = document.createElement('a'); a.className = 'tc-ss-link';
  a.href = url; a.target = '_blank'; a.title = 'Solscan'; a.textContent = '↗';
  row.appendChild(a);
  const span = document.createElement('span'); span.className = 'tc-addr-val'; span.textContent = addr; span.title = addr;
  row.appendChild(span);
  return row;
}

// Пилюля DA/PA: клик на текст → solscan, иконка → копирование
function buildAddrPill(lbl, addr, url) {
  const pill = document.createElement('span'); pill.className = 'tc-addr-pill';
  const a = document.createElement('a'); a.className = 'tc-addr-pill-lbl';
  a.href = url; a.target = '_blank'; a.title = addr; a.textContent = lbl;
  pill.appendChild(a);
  pill.appendChild(mkIconBtn(AT_SVG_COPY, `Copy ${lbl}`, () => copyToClipboard(addr)));
  return pill;
}

// ── Универсальная строка свапа ────────────────────────────────────────────────
// opts: { emoji, label, labelClass, labelStyle, labelMarquee, labelSuffix, marker,
//         solDecimals, showCluster, canDelete, onDelete }
function buildSwapRow(s, opts = {}) {
  const {
    emoji        = '🟢',
    label        = (s.wallet ? s.wallet.slice(0, 8) : '???') + '…',
    labelClass   = 'ts-name',
    labelStyle   = null,
    labelMarquee = false,
    labelSuffix  = null,   // серый текст после основного label (возраст + SOL)
    marker       = null,
    solDecimals  = 2,
    showCluster  = false,
    canDelete    = false,
    onDelete     = null,
  } = opts;

  const row = document.createElement('div'); row.className = 'token-swap-row';

  const emojiEl = document.createElement('span'); emojiEl.className = 'ts-emoji';
  emojiEl.textContent = emoji;
  row.appendChild(emojiEl);

  row.appendChild(mkIconBtn(AT_SVG_COPY, 'Copy wallet', () => copyToClipboard(s.wallet)));
  const ssLink = document.createElement('a'); ssLink.className = 'tc-ss-link';
  ssLink.href = `https://solscan.io/account/${s.wallet}`; ssLink.target = '_blank'; ssLink.title = 'Solscan'; ssLink.textContent = '↗';
  row.appendChild(ssLink);

  if (s.signature) {
    const txLink = document.createElement('a'); txLink.className = 'ts-tx-link';
    txLink.href = `https://solscan.io/tx/${s.signature}`; txLink.target = '_blank'; txLink.title = 'Transaction'; txLink.textContent = 'TX';
    row.appendChild(txLink);
  } else if (s.from_tt_scan) {
    // TT-SCAN запись (см. mergeTtWallet в background.js) — точной транзакции не
    // знаем (Top Traders не даёт signature), даём ссылку на активность аккаунта.
    const txLink = document.createElement('a'); txLink.className = 'ts-tx-link';
    txLink.href = `https://solscan.io/account/${s.wallet}#activities`; txLink.target = '_blank';
    txLink.title = 'Account activity (нет signature конкретной сделки)'; txLink.textContent = 'TX';
    row.appendChild(txLink);
  }

  const nameEl = document.createElement('span'); nameEl.className = labelClass;
  nameEl.textContent = label; nameEl.title = s.wallet;
  if (labelStyle) nameEl.style.cssText = labelStyle;

  if (labelSuffix || opts.labelSuffixSol) {
    // Общая обёртка занимает flex:1; CEX-имя внутри — shrinkable, не растягивается
    const nameWrap = document.createElement('span');
    nameWrap.style.cssText = 'display:flex;align-items:center;gap:4px;flex:1;min-width:0;overflow:hidden;';
    nameEl.style.flex    = '0 1 auto';
    nameEl.style.minWidth = '0';
    nameWrap.appendChild(nameEl);

    if (opts.labelSuffixSol > 0) {
      const badge = document.createElement('span');
      badge.className = 'tc-pill tc-pill-bal';
      badge.style.flexShrink = '0';
      badge.textContent = opts.labelSuffixSol.toFixed(1) + ' SOL';
      nameWrap.appendChild(badge);
    }
    if (labelSuffix) {
      const sfx = document.createElement('span');
      sfx.className = 'ts-label-suffix';
      sfx.textContent = labelSuffix;
      nameWrap.appendChild(sfx);
    }
    row.appendChild(nameWrap);
  } else {
    row.appendChild(nameEl);
  }
  if (labelMarquee) setupMarquee(nameEl);

  if (marker) {
    const mkr = document.createElement('span'); mkr.className = 'ts-marker';
    mkr.textContent = marker; mkr.title = marker;
    row.appendChild(mkr);
  }

  const right = document.createElement('span'); right.className = 'ts-right';
  const solEl = document.createElement('span'); solEl.className = 'ts-sol';
  solEl.textContent = (Number(s.sol) || 0).toFixed(solDecimals) + ' SOL';
  right.appendChild(solEl);
  const ageEl = document.createElement('span'); ageEl.className = 'ts-age';
  ageEl.dataset.ts = s.ts; ageEl.textContent = formatShort(s.ts);
  right.appendChild(ageEl);
  if (showCluster && s.cluster_id > 0) {
    const clEl = document.createElement('span'); clEl.className = 'ts-cluster';
    clEl.textContent = 'C' + s.cluster_id;
    right.appendChild(clEl);
  }
  row.appendChild(right);

  if (canDelete && onDelete) {
    const delBtn = document.createElement('button');
    delBtn.className = 'ts-del-btn'; delBtn.title = 'Lock wallet (move to Untouchable group)';
    delBtn.innerHTML = AT_SVG_TRASH;
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); onDelete(row, s); });
    row.appendChild(delBtn);
  }

  return row;
}

// Фабрика обработчика удаления (Tracker): открывает модалку DELETE WALLET
function makeTrackerDeleteHandler(token) {
  return function(row, s) {
    openDeleteWalletModal(s.wallet, s, function() {
      // Убираем строку и чистим реестр после любого успешного действия
      row.remove();
      if (_tokenRegistry[token]) {
        _tokenRegistry[token] = _tokenRegistry[token].filter(
          x => !(x.wallet === s.wallet && x.ts === s.ts)
        );
        if (!_tokenRegistry[token].length) delete _tokenRegistry[token];
      }
      patchSignalFeed();
    });
  };
}

// opts-фабрики для вызывающей стороны
function makeTrackerSwapOpts(s, onDelete) {
  return {
    emoji:        s.is_bad ? '🔴' : '🟢',
    label:        s.group_name || 'Main',
    labelClass:   'ts-group-badge',
    labelStyle:   `background:${(s.group_color || '#EF911A')}CC`,
    labelMarquee: true,
    marker:       s.marker || null,
    solDecimals:  2,
    canDelete:    !!onDelete,
    onDelete:     onDelete || null,
  };
}

function makeFreshSwapOpts(s) {
  const cexRaw   = s.cex_name || '';
  const cexLabel = cexRaw.split(/\s+/)[0] || (s.wallet ? s.wallet.slice(0, 8) + '…' : 'Unknown');
  const age      = s.created_at ? formatShort(s.created_at) : null;

  return {
    emoji:          s.state === 'dev' ? '🟢' : '🟡',
    label:          cexLabel,
    labelSuffix:    age || null,
    labelSuffixSol: Number(s.received_sol) || 0,
    labelClass:     'ts-name',
    solDecimals:    1,
    showCluster:    true,
  };
}

// Применяет состояние свёрнут/развёрнут — без проверки hovering.
// Используется в click-обработчиках и при таймаутах.
function applyCollapseState(card) {
  const swapList = card.querySelector('[data-role="swaps"]');
  const morePill = card.querySelector('[data-role="more-pill"]');
  if (!swapList) return;
  const rows     = swapList.querySelectorAll('.token-swap-row');
  const total    = rows.length;
  const expanded = swapList.hasAttribute('data-expanded');
  rows.forEach((r, i) => { r.style.display = (expanded || i < SWAP_COLLAPSE_LIMIT) ? '' : 'none'; });
  const over = total - SWAP_COLLAPSE_LIMIT;
  if (morePill) {
    morePill.style.display = (expanded || over <= 0) ? 'none' : '';
    if (over > 0) morePill.textContent = `▼ ${over} more`;
  }
  const collapseBtn = swapList.querySelector('.swap-collapse-btn');
  if (collapseBtn) collapseBtn.style.display = (expanded && total > SWAP_COLLAPSE_LIMIT) ? '' : 'none';
}

// Враппер для вызова из patch() — пропускает если мышь над карточкой.
function refreshCollapseUI(card) {
  if (!card || card._hovering) return;
  applyCollapseState(card);
}

// Сокращает адрес: "AbCdEf…XyZw"
function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr;
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

// ── Универсальная карточка токена ─────────────────────────────────────────────
// opts: { meta, score }
//   meta  — данные токена (из _tokenMeta или _afMeta)
//   score — null для Tracker; { level, cardType } для Fresh
function buildTokenCard(token, swaps, opts = {}) {
  const { meta = {}, score = null } = opts;
  const isScam   = score ? score.cardType === 'fresh_scam' : false;
  const isBad    = swaps.every(s => s.is_bad);
  const hasBad   = swaps.some(s => s.is_bad);
  const petColor = score
    ? (isScam ? AF_SCAM_COLOR : (AF_LEVEL_COLOR[score.level] || AF_BUY_COLOR))
    : null;
  const latestTs = Math.max(...swaps.map(x => x.ts));
  const pa       = meta.pa || token;
  const axiomUrl = `https://axiom.trade/meme/${pa}?chain=sol`;

  // ── CSS класс карточки ──────────────────────────────────────────────────────
  let cardClass = 'token-card';
  if (score)       cardClass += ' ' + (isScam ? 'tc-scam' : 'tc-buy tc-l' + score.level);
  else if (isBad)  cardClass += ' tc-bad';
  const card = document.createElement('div');
  card.className = cardClass; card.dataset.token = token;

  // ── Header ──────────────────────────────────────────────────────────────────
  const header = document.createElement('div'); header.className = 'tc-header';

  const thumbCol  = document.createElement('div'); thumbCol.className = 'tc-thumb-col';
  const thumbLink = document.createElement('a'); thumbLink.href = axiomUrl; thumbLink.target = '_blank'; thumbLink.className = 'tc-thumb-link';
  thumbLink.appendChild(mkThumb(token, meta.image));
  thumbCol.appendChild(thumbLink);
  header.appendChild(thumbCol);

  const headerRight = document.createElement('div'); headerRight.className = 'tc-header-right';

  // Title: ticker + name + badge (count badge для Tracker / level badge для Fresh)
  const titleLine = document.createElement('div'); titleLine.className = 'tc-title-line';
  const titleLink = document.createElement('a'); titleLink.href = axiomUrl; titleLink.target = '_blank'; titleLink.className = 'tc-title-link';
  const tickerEl  = document.createElement('span'); tickerEl.className = 'token-ticker';
  tickerEl.textContent = meta.symbol || shortAddr(token);
  titleLink.appendChild(tickerEl);
  if (meta.name) {
    const nameEl = document.createElement('span'); nameEl.className = 'token-name-lbl'; nameEl.textContent = meta.name;
    titleLink.appendChild(nameEl);
  }
  titleLine.appendChild(titleLink);

  if (score) {
    if (isScam) {
      const b = document.createElement('span'); b.className = 'token-lv-badge tc-title-badge';
      b.textContent = 'SCAM'; b.style.cssText = 'color:#ef4444;border-color:#ef444444;background:#ef444415;';
      titleLine.appendChild(b);
    } else if (score.level >= 1) {
      const b = document.createElement('span'); b.className = 'token-lv-badge tc-title-badge'; b.dataset.role = 'level';
      b.textContent = AF_LEVEL_LABEL[score.level];
      b.style.cssText = `color:${AF_LEVEL_COLOR[score.level]};border-color:${AF_LEVEL_COLOR[score.level]}44;background:${AF_LEVEL_COLOR[score.level]}15;`;
      titleLine.appendChild(b);
    }
  } else {
    const badgeColor = hasBad ? '#ff5e5e' : '#EF911A';
    const countBadge = document.createElement('span'); countBadge.className = 'tc-count-badge'; countBadge.dataset.role = 'count';
    countBadge.textContent = swaps.length + ' buy' + (swaps.length > 1 ? 's' : '');
    countBadge.style.cssText = `color:${badgeColor};border-color:${badgeColor}44;background:${badgeColor}15;`;
    titleLine.appendChild(countBadge);
  }
  headerRight.appendChild(titleLine);

  // CA строка
  headerRight.appendChild(buildAddrRow('CA', token, `https://solscan.io/token/${token}`));

  // DA + PA + время + balance pills
  const daPaRow = document.createElement('div'); daPaRow.className = 'tc-dapa-row';
  const timeEl  = document.createElement('span'); timeEl.className = 'token-time tc-time-pill';
  timeEl.dataset.ts = latestTs; timeEl.textContent = formatShort(latestTs);
  daPaRow.appendChild(timeEl);
  if (meta.da) daPaRow.appendChild(buildAddrPill('DA', meta.da, `https://solscan.io/account/${meta.da}`));
  if (meta.pa) daPaRow.appendChild(buildAddrPill('PA', meta.pa, `https://solscan.io/account/${meta.pa}`));

  // Balance before launch: Fresh использует creator_balance_before, Tracker — dev_balance_before
  const balance = meta.creator_balance_before ?? meta.dev_balance_before;
  if (balance != null) {
    const p = document.createElement('span'); p.className = 'tc-pill tc-pill-bal';
    p.title = 'Dev balance before launch';
    p.textContent = Number(balance).toFixed(1) + ' SOL';
    daPaRow.appendChild(p);
  }
  if (meta.dev_buy_sol != null) {
    const p = document.createElement('span'); p.className = 'tc-pill tc-pill-buy';
    p.title = 'Dev buy at launch';
    p.textContent = 'BUY ' + Number(meta.dev_buy_sol).toFixed(1) + ' SOL';
    daPaRow.appendChild(p);
  } else {
    const p = document.createElement('span'); p.className = 'tc-pill tc-pill-nobuy';
    p.title = 'Dev did not buy at launch'; p.textContent = 'NO DEV BUY';
    daPaRow.appendChild(p);
  }
  headerRight.appendChild(daPaRow);
  header.appendChild(headerRight);
  card.appendChild(header);

  // ── Секция свапов ───────────────────────────────────────────────────────────
  const swapSection  = document.createElement('div'); swapSection.className = 'tc-fresh-section';
  const sectionTitle = document.createElement('span'); sectionTitle.className = 'tc-fresh-title';
  if (score) {
    sectionTitle.dataset.role = 'count';        // обновляется в createFeedManager.patch()
    sectionTitle.textContent  = `Fresh (${swaps.length}):`;
    sectionTitle.style.color  = petColor;
  } else {
    sectionTitle.textContent = `Buys (${swaps.length}):`;
  }
  swapSection.appendChild(sectionTitle);

  const swapList     = document.createElement('div'); swapList.className = 'token-swaps'; swapList.dataset.role = 'swaps';
  const onSwapDelete = score ? null : makeTrackerDeleteHandler(token);
  for (const s of swaps) {
    swapList.appendChild(buildSwapRow(s, score ? makeFreshSwapOpts(s) : makeTrackerSwapOpts(s, onSwapDelete)));
  }

  // ── Collapse btn (последний в swapList) ────────────────────────────────────
  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'swap-collapse-btn'; collapseBtn.textContent = '▲ Свернуть';
  collapseBtn.style.display = 'none';  // управляется через applyCollapseState
  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    swapList.removeAttribute('data-expanded');
    applyCollapseState(card);
  });
  swapList.appendChild(collapseBtn);

  // ── More pill (после swapList) ─────────────────────────────────────────────
  const morePill = document.createElement('div');
  morePill.className = 'swap-more-pill'; morePill.dataset.role = 'more-pill';
  morePill.style.display = 'none';  // управляется через applyCollapseState
  morePill.addEventListener('click', () => {
    swapList.setAttribute('data-expanded', 'true');
    applyCollapseState(card);  // не проверяет hovering — пользователь сам кликнул
  });

  swapSection.appendChild(swapList);
  swapSection.appendChild(morePill);
  card.appendChild(swapSection);

  // ── Hover tracking ────────────────────────────────────────────────────────────
  // Используем JS-класс is-hovered (не CSS :hover) — он стабилен при DOM-изменениях.
  // 50ms debounce на mouseleave защищает от мерцания при мелких layout-скачках.
  card.addEventListener('mouseenter', () => {
    clearTimeout(card._leaveTimer);
    clearTimeout(card._collapseTimer);
    card._hovering = true;
    card.classList.add('is-hovered');
    slog(`ENTER  card=${token.slice(0,8)}`);
  });
  card.addEventListener('mouseleave', (e) => {
    if (card.contains(e.relatedTarget)) return;
    // Spurious mouseleave от DOM-reorder: курсор физически над карточкой
    // (anchor correction уже выполнился до того как браузер диспатчит событие)
    const r = card.getBoundingClientRect();
    const inRect = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    slog(`LEAVE  card=${token.slice(0,8)} cursor=(${e.clientX},${e.clientY}) rect=(${r.left.toFixed(0)},${r.top.toFixed(0)},${r.right.toFixed(0)},${r.bottom.toFixed(0)}) inRect=${inRect}`);
    if (inRect) return; // spurious
    card._leaveTimer = setTimeout(() => {
      card._hovering = false;
      card.classList.remove('is-hovered');
      slog(`LEAVE  card=${token.slice(0,8)} hover CLEARED`);
      card._collapseTimer = setTimeout(() => {
        if (swapList.hasAttribute('data-expanded')) {
          swapList.removeAttribute('data-expanded');
          applyCollapseState(card);
        }
      }, 400);
    }, 50);
  });

  // ── Links ───────────────────────────────────────────────────────────────────
  const linksRow = document.createElement('div'); linksRow.className = 'tc-links-row';
  const mkLink = (href, text) => {
    const a = document.createElement('a'); a.className = 'tc-ext-link'; a.href = href; a.target = '_blank'; a.textContent = text; return a;
  };
  linksRow.appendChild(mkLink(`https://dexscreener.com/solana/${token}`, 'DEX'));
  linksRow.appendChild(mkLink(`https://gmgn.ai/sol/token/${token}`, 'GMGN'));
  linksRow.appendChild(mkLink(`https://pump.fun/${token}`, 'PUMP'));
  linksRow.appendChild(mkLink(axiomUrl, 'AXIOM'));
  if (meta.website)  linksRow.appendChild(mkLink(meta.website,  'SITE'));
  if (meta.twitter)  linksRow.appendChild(mkLink(meta.twitter,  'TW'));
  if (meta.telegram) linksRow.appendChild(mkLink(meta.telegram, 'TG'));

  if (score) {
    const rightGroup = document.createElement('span'); rightGroup.className = 'tc-links-right';
    rightGroup.appendChild(petalRow(score.level, petColor));
    linksRow.appendChild(rightGroup);
  }
  card.appendChild(linksRow);

  return card;
}

function setupMarquee(el) {
  requestAnimationFrame(() => {
    if (!el.isConnected || el.classList.contains('is-marquee')) return;
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow > 4) {
      // Оборачиваем текст в inner span — анимируем его, не сам badge
      // Badge остаётся на месте; overflow:hidden на нём клипает скользящий текст
      const inner = document.createElement('span');
      inner.className = 'ts-badge-inner';
      inner.textContent = el.textContent;
      el.textContent = '';
      el.appendChild(inner);
      el.style.setProperty('--mo', `-${overflow}px`);
      el.classList.add('is-marquee');
    }
  });
}


// Wrapper: сохраняем старую сигнатуру — call sites меняются в Шаге 4
function buildTrackerTokenCard(token, swaps) {
  return buildTokenCard(token, swaps, { meta: _tokenMeta[token] || {}, score: null });
}

// ── Signal feed (token-grouped) ───────────────────────────────────────────────






// ── Wakeup polling ────────────────────────────────────────────────────────────







// ── Age pill updater (оба фида) ───────────────────────────────────────────────
setInterval(() => {
  document.querySelectorAll('[data-ts]').forEach(el => {
    el.textContent = formatShort(Number(el.dataset.ts));
  });
}, 10_000);

// ── Periodic GC: выгоняем протухшие карточки каждые 60 секунд ────────────────
setInterval(() => { patchSignalFeed(); }, 60_000);


// ══════════════════════════════════════════════════════════════════════════════
// ██  FRESH FEED — рендеринг левой колонки (интегрировано из Angry Fresh)   ██
// ══════════════════════════════════════════════════════════════════════════════

const LEAF_SVG_PATH = `M0 0 C0.89117523 -0.00315216 1.78235046 -0.00630432 2.70053101 -0.009552 C3.67027863 -0.00752777 4.64002625 -0.00550354 5.63916016 -0.00341797 C6.62945221 -0.00437469 7.61974426 -0.00533142 8.64004517 -0.00631714 C10.74001122 -0.00699919 12.83997937 -0.00514315 14.93994141 -0.00097656 C18.15743758 0.00436006 21.37479343 -0.00091487 24.59228516 -0.00732422 C26.6287438 -0.00666322 28.66520235 -0.00538161 30.70166016 -0.00341797 C31.66735931 -0.0054422 32.63305847 -0.00746643 33.62802124 -0.009552 C34.97424057 -0.00482376 34.97424057 -0.00482376 36.34765625 0 C37.13739838 0.00079559 37.9271405 0.00159119 38.74081421 0.00241089 C40.80322266 0.12939453 40.80322266 0.12939453 43.80322266 1.12939453 C45.51759356 1.22042307 47.23489817 1.2609601 48.95166016 1.27001953 C49.95712891 1.28935547 50.96259766 1.30869141 51.99853516 1.32861328 C54.1103237 1.36233963 56.22241644 1.38068685 58.33447266 1.38330078 C62.91445486 1.49457912 65.97097216 1.64031893 69.96728516 3.98876953 C74.92612636 12.47155321 72.98078396 25.2367194 73.00634766 34.90283203 C73.01340268 36.53535494 73.02053542 38.16787752 73.02774048 39.80039978 C73.0474214 45.03506885 73.05243525 50.269692 73.05322266 55.50439453 C73.05366451 56.84218271 73.05366451 56.84218271 73.0541153 58.20699692 C73.05561541 86.28026263 72.70917145 114.18102294 69.80322266 142.12939453 C69.65049896 143.6084729 69.65049896 143.6084729 69.49468994 145.11743164 C66.5921327 172.94760953 62.85849383 200.60824046 57.80322266 228.12939453 C57.6040625 229.23782715 57.40490234 230.34625977 57.19970703 231.48828125 C46.67036868 289.6076961 28.7505469 349.47080774 -2.19677734 400.12939453 C-2.68823242 400.94424316 -3.1796875 401.7590918 -3.68603516 402.59863281 C-5.36841764 405.38511004 -7.06171773 408.16463973 -8.75927734 410.94189453 C-9.289646 411.81426758 -9.82001465 412.68664062 -10.36645508 413.58544922 C-13.96582367 419.40967024 -17.92445035 424.78496864 -22.19677734 430.12939453 C-23.01749938 431.20293172 -23.83440642 432.27940552 -24.64599609 433.35986328 C-38.5269546 451.69823254 -53.88013805 469.09386324 -72.19677734 483.12939453 C-73.62763672 484.28568359 -73.62763672 484.28568359 -75.08740234 485.46533203 C-118.17226007 519.78166344 -170.87002605 536.62421801 -225.09326172 541.81982422 C-227.17939597 541.91314083 -227.17939597 541.91314083 -228.19677734 543.12939453 C-230.08847036 543.22855033 -231.98388442 543.25738765 -233.87817383 543.25878906 C-235.70027626 543.2635173 -235.70027626 543.2635173 -237.55918884 543.26834106 C-238.89541663 543.26655108 -240.23164408 543.26450008 -241.56787109 543.26220703 C-242.92928586 543.2628802 -244.29070051 543.26385033 -245.65211487 543.2651062 C-248.50954326 543.26658308 -251.36694046 543.2644293 -254.22436523 543.25976562 C-257.89096536 543.25407372 -261.5574922 543.25734396 -265.22408962 543.26333809 C-268.03701837 543.26694859 -270.8499297 543.26580276 -273.66285896 543.2632103 C-275.01488313 543.2625421 -276.36690886 543.26336571 -277.7189312 543.26568985 C-279.60794928 543.26822373 -281.49697288 543.26367825 -283.38598633 543.25878906 C-284.46218735 543.25799347 -285.53838837 543.25719788 -286.64720154 543.25637817 C-289.19677734 543.12939453 -289.19677734 543.12939453 -291.19677734 542.12939453 C-293.60700935 541.81023395 -296.00502622 541.53752845 -298.42333984 541.29736328 C-299.93241179 541.13985646 -301.44144341 540.98196289 -302.95043945 540.82373047 C-303.74465302 540.74151245 -304.53886658 540.65929443 -305.35714722 540.57458496 C-340.43102436 536.90742112 -375.49013095 530.68521262 -409.19677734 520.12939453 C-408.98342802 513.82589187 -405.78444259 510.97995076 -401.57177734 506.75439453 C-400.28322019 505.42052833 -398.99544997 504.08590144 -397.70849609 502.75048828 C-397.09409668 502.11997559 -396.47969727 501.48946289 -395.84667969 500.83984375 C-393.96122316 498.88519616 -392.15610354 496.87490643 -390.38427734 494.81689453 C-385.58587785 489.24882695 -380.63745194 483.81375583 -375.69287109 478.37548828 C-374.88978516 477.48990234 -374.08669922 476.60431641 -373.25927734 475.69189453 C-372.16292969 474.48726563 -372.16292969 474.48726563 -371.04443359 473.25830078 C-369.06350154 471.06646488 -369.06350154 471.06646488 -367.19677734 468.12939453 C-366.53677734 468.12939453 -365.87677734 468.12939453 -365.19677734 468.12939453 C-364.93775635 467.54818848 -364.67873535 466.96698242 -364.41186523 466.36816406 C-363.1040934 463.95862665 -361.65208496 462.28350344 -359.75537109 460.30908203 C-359.08957031 459.60912109 -358.42376953 458.90916016 -357.73779297 458.18798828 C-357.04363281 457.46740234 -356.34947266 456.74681641 -355.63427734 456.00439453 C-354.25593903 454.56623914 -352.87953777 453.12622397 -351.50537109 451.68408203 C-350.89491943 451.04970215 -350.28446777 450.41532227 -349.65551758 449.76171875 C-348.11161414 448.17785078 -348.11161414 448.17785078 -347.19677734 446.12939453 C-346.53677734 446.12939453 -345.87677734 446.12939453 -345.19677734 446.12939453 C-344.93251953 445.53642578 -344.66826172 444.94345703 -344.39599609 444.33251953 C-343.15307309 442.04910399 -341.89276088 440.6551273 -340.00927734 438.87939453 C-337.56079479 436.50115533 -335.23606681 434.09139994 -333.00927734 431.50439453 C-329.85595304 427.84795556 -326.60404982 424.29455252 -323.32177734 420.75439453 C-318.99912802 416.09013157 -314.71860977 411.39245169 -310.47412109 406.65673828 C-307.43016346 403.27862406 -304.35301401 399.93133449 -301.27587891 396.58349609 C-298.45701265 393.51354085 -295.66182121 390.42423953 -292.88427734 387.31689453 C-289.00509562 382.99038375 -285.04508157 378.74414692 -281.07177734 374.50439453 C-276.97779162 370.13500207 -272.93185062 365.74589379 -269.02490234 361.20751953 C-265.99450453 357.76270834 -262.85983719 354.41411152 -259.74145508 351.04907227 C-255.94498414 346.94921548 -252.19649135 342.80925573 -248.46630859 338.64892578 C-245.93322835 335.83681432 -243.38061535 333.04303872 -240.82177734 330.25439453 C-240.36311279 329.75447998 -239.90444824 329.25456543 -239.43188477 328.73950195 C-237.05607496 326.15144042 -234.67787323 323.56559498 -232.29833984 320.98095703 C-226.46465829 314.64410946 -226.46465829 314.64410946 -220.75927734 308.19189453 C-214.63436212 301.13365889 -208.19316898 294.34731531 -201.82568359 287.50830078 C-201.28065186 286.92137451 -200.73562012 286.33444824 -200.17407227 285.72973633 C-199.1278808 284.60320348 -198.07994188 283.47829024 -197.0300293 282.35522461 C-194.86695555 280.02431665 -192.96568842 277.78276115 -191.19677734 275.12939453 C-190.53677734 275.12939453 -189.87677734 275.12939453 -189.19677734 275.12939453 C-188.95314453 274.55705078 -188.70951172 273.98470703 -188.45849609 273.39501953 C-186.97160436 270.72505915 -185.21593826 268.99110446 -183.00927734 266.87939453 C-179.56248584 263.50919839 -176.33219083 260.0647257 -173.19287109 256.41064453 C-170.66216181 253.51840535 -168.05828285 250.69861465 -165.44677734 247.87939453 C-164.93083008 247.32227783 -164.41488281 246.76516113 -163.88330078 246.19116211 C-162.83373172 245.05803797 -161.78408969 243.92498142 -160.734375 242.79199219 C-158.3596966 240.22426277 -155.9962959 237.64626634 -153.63427734 235.06689453 C-153.1847168 234.57608398 -152.73515625 234.08527344 -152.27197266 233.57958984 C-151.36646941 232.59088171 -150.46103301 231.60211236 -149.55566406 230.61328125 C-147.72851722 228.61806054 -145.90036951 226.62375865 -144.07202148 224.62963867 C-143.16078612 223.63557843 -142.24981272 222.64127798 -141.33911133 221.64672852 C-138.95348419 219.0420088 -136.56306936 216.44190482 -134.16552734 213.84814453 C-133.66859375 213.30931641 -133.17166016 212.77048828 -132.65966797 212.21533203 C-131.27741692 210.71681687 -129.89340139 209.21992984 -128.50927734 207.72314453 C-126.60711758 205.58964101 -124.86054308 203.4499099 -123.19677734 201.12939453 C-123.60927734 201.54713135 -124.02177734 201.96486816 -124.44677734 202.39526367 C-127.74560877 205.73045219 -131.05237531 209.05764336 -134.37255859 212.37158203 C-135.00331299 213.00177246 -135.63406738 213.63196289 -136.28393555 214.28125 C-138.82607543 216.73740813 -141.47537908 219.05056854 -144.17724609 221.32861328 C-147.52015974 224.30943183 -150.62043663 227.53344454 -153.7668457 230.71899414 C-157.16314011 234.14114456 -160.66483727 237.36253645 -164.33740234 240.48876953 C-167.08760507 242.915419 -169.62065912 245.54425684 -172.19287109 248.15673828 C-174.77923886 250.70277282 -177.51213014 253.0496101 -180.26318359 255.41455078 C-182.15172332 257.08943752 -183.92833382 258.8288704 -185.69677734 260.62939453 C-188.08730901 263.06329185 -190.54723997 265.34295012 -193.13427734 267.56689453 C-195.94254082 269.98557232 -198.59648327 272.48839136 -201.19677734 275.12939453 C-203.75667869 277.72921636 -206.36457274 280.19207851 -209.13427734 282.56689453 C-212.1247945 285.13604724 -214.92794419 287.82256709 -217.69677734 290.62939453 C-220.32385227 293.29209081 -222.96406746 295.84204203 -225.82177734 298.25439453 C-230.0006003 301.82905032 -233.83016703 305.72496896 -237.69677734 309.62939453 C-242.12724492 314.10319186 -246.56206546 318.46372865 -251.37646484 322.52783203 C-254.39371454 325.18249378 -257.16074096 328.08602774 -259.98193359 330.94580078 C-261.97337195 332.90914124 -264.00980312 334.75019122 -266.13427734 336.56689453 C-269.30713655 339.28558701 -272.26016116 342.15691128 -275.19677734 345.12939453 C-278.71784057 348.69339755 -282.32863742 352.03243621 -286.13427734 355.28564453 C-288.58602423 357.47735766 -290.88563307 359.79006557 -293.19677734 362.12939453 C-296.09269692 365.06057645 -298.99920306 367.89342627 -302.13427734 370.56689453 C-305.48602899 373.43111866 -308.60233134 376.49274674 -311.69677734 379.62939453 C-314.7090884 382.68256433 -317.73226636 385.67011865 -321.00927734 388.44189453 C-325.61804588 392.36647475 -329.80005357 396.70747193 -334.05444336 401.0065918 C-337.67083685 404.64634512 -341.35662527 408.11080432 -345.27490234 411.42626953 C-348.59177381 414.36561092 -351.64570493 417.57160172 -354.75927734 420.72314453 C-357.4496164 423.37899206 -360.26251259 425.83074885 -363.13427734 428.28564453 C-366.48713583 431.28289682 -369.59571491 434.52099088 -372.75537109 437.71923828 C-375.46880461 440.39793985 -378.30454757 442.87547571 -381.20068359 445.35205078 C-384.26344461 448.07916676 -387.09901228 451.0234409 -389.97802734 453.94189453 C-392.60448857 456.53136334 -395.36654193 458.91776417 -398.16552734 461.31689453 C-401.23652051 464.05716536 -404.08464611 467.00886355 -406.97412109 469.93798828 C-409.62120438 472.54785423 -412.4026547 474.95788984 -415.22412109 477.37548828 C-417.34314793 479.25953392 -419.3321284 481.23454219 -421.32177734 483.25439453 C-427.89973841 489.85810105 -427.89973841 489.85810105 -431.19677734 492.12939453 C-433.87255859 491.75048828 -433.87255859 491.75048828 -436.19677734 491.12939453 C-466.58946028 408.77502787 -469.67334786 310.409581 -433.22558594 208.34619141 C-429.86768043 201.11083734 -426.02988929 194.12047692 -422.19677734 187.12939453 C-421.53133692 185.89115404 -420.86596657 184.65287588 -420.20068359 183.41455078 C-412.63495738 169.68299364 -403.35697668 157.0484183 -393.19677734 145.12939453 C-392.28589098 144.03364689 -391.37577655 142.93725723 -390.46630859 141.84033203 C-361.17636455 106.78264282 -323.14935513 80.79355761 -282.19677734 61.12939453 C-281.2713916 60.68192871 -280.34600586 60.23446289 -279.39257812 59.7734375 C-255.06387401 48.06889286 -230.01270319 38.96480577 -204.19677734 31.12939453 C-203.25882324 30.84 -202.32086914 30.55060547 -201.35449219 30.25244141 C-141.7232971 12.00668804 -78.31988764 4.25043156 -16.20141602 1.6730957 C-15.45591995 1.6413475 -14.71042389 1.6095993 -13.94233704 1.57688904 C-11.95820023 1.49474121 -9.97373485 1.42063897 -7.98925781 1.34716797 C-4.84282461 1.10179129 -3.3288334 0.00336027 0 0 Z`;

function leafSVG(color) {
  return `<svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg" width="16" height="16" style="color:${color};flex-shrink:0;"><path d="${LEAF_SVG_PATH}" fill="currentColor" transform="translate(489.19677734375,31.87060546875)"/></svg>`;
}
function petalRow(count, color) {
  const wrap = document.createElement('div'); wrap.className = 'petal-row';
  for (let i = 0; i < Math.min(count, 5); i++) wrap.insertAdjacentHTML('beforeend', leafSVG(color));
  return wrap;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// ── AF rendering constants ──────────────────────────────────────────────────
const AF_LEVEL_LABEL = ['', 'Fresh', 'Clustered', 'Full Cluster', 'Aged 24h+', 'INSIDER'];
const AF_LEVEL_COLOR = ['', '#39FF14', '#7FFF00', '#FFD700', '#FF8C00', '#FF4500'];
const AF_SCAM_COLOR  = '#ef4444';
const AF_BUY_COLOR   = '#39FF14';

// ── AF state (Fresh Feed) ────────────────────────────────────────────────────
let _afReg    = {};
let _afMeta   = {};
let _afScores = {};          // { [ca]: { level, cardType } } — из background, без пересчёта
let _afCards  = new Map();
// AF_FEED_STALE_MS убран (решение диалога) — возрастной TTL на живые af-сигналы
// больше не применяется, capping только по количеству.


// ── Icon / link helpers ───────────────────────────────────────────────────────



// ── Token / Signal card ───────────────────────────────────────────────────────
// Wrapper: сохраняем старую сигнатуру — call sites меняются в Шаге 4
function buildFreshTokenCard(token, swaps, score) {
  return buildTokenCard(token, swaps, { meta: _afMeta[token] || {}, score });
}






// Signals tab — по времени последнего события






setInterval(() => { patchFreshFeed(); }, 60_000);


// ── Глобальный трекер курсора (для всех feed-менеджеров) ─────────────────────
// Используем -9999 как "off-screen" до первого mousemove
let _docCursorX      = -9999;
let _docCursorY      = -9999;
let _docCursorTime   = 0;
let _cursorInWindow  = false; // false если курсор вне окна (другой монитор, Alt+Tab)
document.addEventListener('mousemove', (e) => {
  _docCursorX     = e.clientX;
  _docCursorY     = e.clientY;
  _docCursorTime  = Date.now();
  _cursorInWindow = true;
}, { passive: true, capture: true });
document.addEventListener('mouseleave', () => {
  _cursorInWindow = false; // курсор покинул окно браузера/панель
}, { passive: true, capture: true });

// ══════════════════════════════════════════════════════════════════════════════
// ██  ЕДИНЫЙ FEED MANAGER                                                    ██
// ══════════════════════════════════════════════════════════════════════════════

// createFeedManager — универсальный менеджер ленты сигналов
// opts: listId, emptyId, getRegistry, getMeta, cardMap,
//       staleMs, maxCards, scoreSwaps, buildCard, normalizeSignal,
//       hideListWhenEmpty, onAfterPatch
function createFeedManager({
  listId,
  emptyId           = null,
  getRegistry,
  getMeta,
  cardMap,
  staleMs           = 0,
  maxCards          = 0,
  scoreSwaps        = null,
  buildCard,
  normalizeSignal   = null,
  hideListWhenEmpty = false,
  onAfterPatch      = null,
  getCrossRegistry  = null,  // fn() → реестр другого фида (для бейджа пересечения)
  crossLabel        = '',    // текст бейджа, напр. '⚡ Fresh'
}) {
  // Scroll-состояние фида
  let _hoverSetup     = false;
  let _scrollingTop   = false;
  let _lastUserScroll = 0;
  let _scrollRafId    = null;
  let _cursorInFeed   = false; // курсор физически над scrollEl (mouseenter/mouseleave)

  // Находим карточку из cardMap под точкой (x,y) — нужно для hover при скролле колесом
  function findCardAtPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el) {
      if (el.dataset?.token && cardMap.has(el.dataset.token)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Принудительно обновляем hover на основе реальной позиции курсора.
  // Браузер НЕ диспатчит mouseenter/leave когда список скроллится под неподвижным курсором.
  function updateHoverFromCursor() {
    // Курсор вне окна (другой монитор, Alt+Tab) — сбрасываем все hovers
    if (!_cursorInWindow) {
      for (const [, card] of cardMap) {
        if (card._hovering) {
          clearTimeout(card._leaveTimer);
          clearTimeout(card._collapseTimer);
          card._hovering = false;
          card.classList.remove('is-hovered');
          slog(`STALE-CLEAR [${listId}] card=${card.dataset.token?.slice(0,8)}`);
        }
      }
      return;
    }
    const targetCard = findCardAtPoint(_docCursorX, _docCursorY);
    for (const [, card] of cardMap) {
      if (card === targetCard) {
        if (!card._hovering) {
          clearTimeout(card._leaveTimer);
          clearTimeout(card._collapseTimer);
          card._hovering = true;
          card.classList.add('is-hovered');
          slog(`SCROLL-ENTER [${listId}] card=${card.dataset.token?.slice(0,8)}`);
        }
      } else if (card._hovering) {
        clearTimeout(card._leaveTimer);
        clearTimeout(card._collapseTimer);
        card._hovering = false;
        card.classList.remove('is-hovered');
        slog(`SCROLL-LEAVE [${listId}] card=${card.dataset.token?.slice(0,8)}`);
      }
    }
  }

  // Очищает застрявший hover — только убирает, никогда не добавляет.
  // Вызывается из guard каждую секунду.
  function clearStuckHovers() {
    const inFeed = _cursorInWindow && _cursorInFeed;
    for (const [, card] of cardMap) {
      if (!card._hovering) continue;
      if (!inFeed) {
        // Курсор вне фида (Axiom, другой монитор) — сбрасываем
        clearTimeout(card._leaveTimer);
        clearTimeout(card._collapseTimer);
        card._hovering = false;
        card.classList.remove('is-hovered');
        slog(`GUARD-CLEAR [${listId}] card=${card.dataset.token?.slice(0,8)} (cursor not in feed)`);
        continue;
      }
      // Курсор в фиде — проверяем что он реально над карточкой
      const r = card.getBoundingClientRect();
      const overCard = _docCursorX >= r.left && _docCursorX <= r.right &&
                       _docCursorY >= r.top  && _docCursorY <= r.bottom;
      if (!overCard) {
        clearTimeout(card._leaveTimer);
        clearTimeout(card._collapseTimer);
        card._hovering = false;
        card.classList.remove('is-hovered');
        slog(`GUARD-CLEAR [${listId}] card=${card.dataset.token?.slice(0,8)} cursor=(${_docCursorX},${_docCursorY}) not over rect=(${r.top.toFixed(0)},${r.bottom.toFixed(0)})`);
      }
    }
  }


  function updateCrossIndicator(token, card) {
    if (!getCrossRegistry || !crossLabel) return;
    const isCross = (getCrossRegistry()[token]?.length ?? 0) > 0;
    let badge = card.querySelector('.tc-cross-badge');
    if (isCross && !badge) {
      badge = document.createElement('span');
      badge.className = 'tc-cross-badge';
      badge.textContent = crossLabel;
      badge.title = 'Нажми — вставить CA в фильтр (покажет обе карточки)';
      // Клик: вставляем CA в поле фильтра → оба фида сами фильтруются
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const inp = document.getElementById('filter-input');
        if (!inp) return;
        inp.value = token;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.focus();
      });
      card.querySelector('.tc-title-line')?.appendChild(badge);
    } else if (!isCross && badge) {
      badge.remove();
    }
  }

  function ensureHoverSetup(scrollEl) {
    if (_hoverSetup || !scrollEl) return;
    _hoverSetup = true;
    scrollEl.style.overflowAnchor = 'none';
    // _cursorInFeed: надёжно через mouseenter/leave на контейнере
    scrollEl.addEventListener('mouseenter', () => { _cursorInFeed = true; });
    scrollEl.addEventListener('mouseleave', () => { _cursorInFeed = false; });
    scrollEl.addEventListener('wheel',       () => { _lastUserScroll = Date.now(); }, { passive: true });
    scrollEl.addEventListener('pointerdown', () => { _lastUserScroll = Date.now(); });
    // Обновляем hover при скролле ТОЛЬКО если курсор реально в фиде
    scrollEl.addEventListener('scroll', () => {
      if (_scrollRafId) return;
      _scrollRafId = requestAnimationFrame(() => {
        _scrollRafId = null;
        if (_cursorInFeed && _cursorInWindow) updateHoverFromCursor();
      });
    }, { passive: true });
  }

  // Физическая проверка: курсор над scrollEl?
  function isCursorOverFeed(scrollEl) {
    if (!scrollEl || !_cursorInWindow) return false;
    const r = scrollEl.getBoundingClientRect();
    return _docCursorX >= r.left && _docCursorX <= r.right &&
           _docCursorY >= r.top  && _docCursorY <= r.bottom;
  }

  // Раз в секунду: если курсор вне фида и список прокручен — крутим наверх
  function startScrollGuard() {
    setInterval(() => {
      // Убираем застрявший hover — только чистим, не добавляем
      clearStuckHovers();

      const hovCnt = [...cardMap.values()].filter(c => c._hovering).length;
      const list    = document.getElementById(listId);
      const scrollEl = list?.parentElement;
      const st = scrollEl?.scrollTop ?? -1;
      const age = Date.now() - _lastUserScroll;

      if (hovCnt > 0) {
        slog(`GUARD [${listId}] skip: hoveredCards=${hovCnt}`);
        return;
      }
      if (_scrollingTop) {
        slog(`GUARD [${listId}] skip: already scrolling`);
        return;
      }
      if (age < 4000) {
        slog(`GUARD [${listId}] skip: userScroll ${age}ms ago`);
        return;
      }
      if (!scrollEl || st <= 50) {
        slog(`GUARD [${listId}] skip: scrollTop=${st}`);
        return;
      }
      const over = isCursorOverFeed(scrollEl);
      if (over) {
        const r = scrollEl.getBoundingClientRect();
        slog(`GUARD [${listId}] skip: cursor over feed cursor=(${_docCursorX},${_docCursorY}) rect=(${r.left.toFixed(0)},${r.top.toFixed(0)},${r.right.toFixed(0)},${r.bottom.toFixed(0)})`);
        return;
      }
      slog(`GUARD [${listId}] → SCROLL UP scrollTop=${st}`);
      _scrollingTop = true;
      scrollEl.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => { _scrollingTop = false; }, 700);
    }, 1000);
  }

  // sorted: токены по убыванию latestTs, с учётом поиска и TTL
  function sorted() {
    const q        = _filterQuery.length >= 2 ? _filterQuery.toLowerCase() : '';
    const registry = getRegistry();
    const metaMap  = getMeta();
    const staleTs  = staleMs ? Date.now() - staleMs : 0;

    if (q) console.log(`[SEARCH][${listId}] sorted(): q=`, q, 'registryKeys=', Object.keys(registry).length,
      'staleMs=', staleMs, 'staleTs=', staleTs, 'now=', Date.now());

    let items = Object.keys(registry)
      .filter(t => {
        if (!registry[t]?.length) {
          if (q && t.toLowerCase().includes(q)) console.log(`[SEARCH][${listId}] STAGE1 DROP ${t}: empty/missing swaps array`, registry[t]);
          return false;
        }
        const maxTs = Math.max(...registry[t].map(x => x.ts));
        const pass  = !staleTs || maxTs > staleTs;
        if (q && t.toLowerCase().includes(q)) {
          console.log(`[SEARCH][${listId}] STAGE1 ${t}: maxTs=${maxTs} (${new Date(maxTs).toISOString()}) staleTs=${staleTs} pass=${pass}`);
        }
        return pass;
      })
      .map(t => {
        const swaps    = registry[t];
        const latestTs = Math.max(...swaps.map(x => x.ts));
        const score    = scoreSwaps ? scoreSwaps(t, swaps) : null;
        return { token: t, swaps, latestTs, score };
      })
      .filter(({ token }) => {
        if (!q) return true;
        const m = metaMap[token] || {};
        const match = (m.symbol || '').toLowerCase().includes(q) ||
               (m.name   || '').toLowerCase().includes(q) ||
               token.toLowerCase().includes(q);   // запасной match по CA
        if (token.toLowerCase().includes(q) && !match) console.log(`[SEARCH][${listId}] STAGE2 DROP ${token}: query filter (bug?)`, m);
        return match;
      })
      .sort((a, b) => b.latestTs - a.latestTs);

    if (q) console.log(`[SEARCH][${listId}] sorted(): after STAGE1+2, ${items.length} items:`, items.map(i => i.token));

    if (maxCards) {
      const before = items.length;
      items = items.slice(0, maxCards);
      if (q && before > items.length) {
        const dropped = before - items.length;
        console.log(`[SEARCH][${listId}] STAGE3 maxCards=${maxCards} slice dropped ${dropped} items (was ${before})`);
      }
    }
    if (q) console.log(`[SEARCH][${listId}] sorted(): FINAL ${items.length} items:`, items.map(i => i.token));
    return items;
  }

  // patch: GC + рендер/патч карточек в DOM
  function patch() {
    const list = document.getElementById(listId);
    const empty = emptyId ? document.getElementById(emptyId) : null;
    if (!list) { console.log(`[SEARCH][${listId}] patch(): ABORT — #${listId} not found in DOM`); return; }

    const qActive = _filterQuery.length >= 2 ? _filterQuery.toLowerCase() : '';
    if (qActive) console.log(`[SEARCH][${listId}] patch() START, filter=`, qActive,
      'registryKeys(before GC)=', Object.keys(getRegistry()).length);

    const scrollEl = list.parentElement;
    ensureHoverSetup(scrollEl);

    // ── Сохраняем якорную карточку и её позицию ──────────────────────────────
    let anchorCard = null;
    let anchorTop = 0;
    for (const [, card] of cardMap) {
      if (card._hovering) {
        anchorCard = card;
        break;
      }
    }
    if (!anchorCard && scrollEl) {
      const firstVisible = list.querySelector('.token-card');
      if (firstVisible) {
        const rect = firstVisible.getBoundingClientRect();
        const containerRect = scrollEl.getBoundingClientRect();
        if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
          anchorCard = firstVisible;
        }
      }
    }
    if (anchorCard && scrollEl) {
      const rect = anchorCard.getBoundingClientRect();
      const containerRect = scrollEl.getBoundingClientRect();
      anchorTop = rect.top - containerRect.top + scrollEl.scrollTop;
      slog(`ANCHOR [${listId}] card=${anchorCard.dataset.token?.slice(0,8)} top=${anchorTop}`);
    }

    const registry = getRegistry();
    const metaMap = getMeta();

    // GC — только по количеству (решение диалога: наплевать на давность, top-N по recency).
    // ИСКЛЮЧЕНИЕ: токен, совпадающий с активным фильтром (юзер целенаправленно ищет/
    // только что нашёл через API) — не выкидываем, даже если он вне top-N. Иначе сам
    // смысл поиска ломается: нашли карточку старше топ-100 — тут же снова потеряли её
    // на следующем patch().
    if (maxCards) {
      const retainSet = new Set(
          Object.keys(registry)
              .filter(t => registry[t]?.length)
              .map(t => ({ t, ts: Math.max(...registry[t].map(x => x.ts)) }))
              .sort((a, b) => b.ts - a.ts)
              .slice(0, maxCards)
              .map(({ t }) => t)
      );
      if (qActive) {
        for (const t of Object.keys(registry)) {
          if (registry[t]?.length && t.toLowerCase().includes(qActive) && !retainSet.has(t)) {
            console.log(`[SEARCH][${listId}] GC: pinning ${t} — matches active filter, вне top-${maxCards}, но не выкидываем`);
            retainSet.add(t);
          }
        }
      }
      if (qActive) console.log(`[SEARCH][${listId}] GC: maxCards=${maxCards} retainSet.size=${retainSet.size}`);
      for (const token of Object.keys(registry)) {
        if (!retainSet.has(token)) {
          if (qActive && token.toLowerCase().includes(qActive)) {
            console.log(`[SEARCH][${listId}] GC REMOVED token matching filter (вне top-${maxCards} по recency): token=${token}`);
          }
          delete registry[token];
          delete metaMap[token];
          const card = cardMap.get(token);
          if (card) { card.remove(); cardMap.delete(token); }
        }
      }
    } else {
      const inReg = new Set(Object.keys(registry).filter(t => registry[t]?.length));
      for (const [token, card] of cardMap) {
        if (!inReg.has(token)) { card.remove(); cardMap.delete(token); }
      }
    }

    const items = sorted();
    if (qActive) console.log(`[SEARCH][${listId}] patch(): sorted() returned ${items.length} items`);

    if (!items.length) {
      if (qActive) console.log(`[SEARCH][${listId}] patch(): EMPTY BRANCH — showing "${emptyId}" placeholder, list hidden=${hideListWhenEmpty}`);
      if (hideListWhenEmpty) list.style.display = 'none';
      if (empty) empty.style.display = '';
      if (!Object.keys(registry).some(t => registry[t]?.length)) {
        cardMap.clear();
      } else {
        for (const [, card] of cardMap) card.style.display = 'none';
      }
      if (onAfterPatch) onAfterPatch();
      return;
    }
    if (hideListWhenEmpty) list.style.display = '';
    if (empty) empty.style.display = 'none';

    const visible = new Set(items.map(x => x.token));
    let newCardAdded = false;
    const newItems = [];

    for (const { token, swaps, score, latestTs } of items) {
      const meta = metaMap[token] || {};
      if (!cardMap.has(token)) {
        if (qActive && token.toLowerCase().includes(qActive)) console.log(`[SEARCH][${listId}] patch(): token ${token} is NEW — will buildCard()`);
        newItems.push({ token, swaps, score });
        continue;
      } else {
        if (qActive && token.toLowerCase().includes(qActive)) console.log(`[SEARCH][${listId}] patch(): token ${token} already has a card — patching in place`);
        const card = cardMap.get(token);
        if (score) {
          const isScam = score.cardType === 'fresh_scam';
          card.className = `token-card ${isScam ? 'tc-scam' : 'tc-buy tc-l' + score.level}`;
        }
        const countEl = card.querySelector('[data-role="count"]');
        if (countEl) {
          if (score) {
            const isScam = score.cardType === 'fresh_scam';
            const petColor = isScam ? AF_SCAM_COLOR : (AF_LEVEL_COLOR[score.level] || AF_BUY_COLOR);
            countEl.textContent = `Fresh (${swaps.length}):`;
            countEl.style.color = petColor;
          } else {
            countEl.textContent = swaps.length + ' buy' + (swaps.length > 1 ? 's' : '');
          }
        }
        const timeEl = card.querySelector('.token-time');
        if (timeEl) { timeEl.dataset.ts = latestTs; timeEl.textContent = formatShort(latestTs); }
        const tickerEl = card.querySelector('.token-ticker');
        if (tickerEl && meta.symbol) tickerEl.textContent = meta.symbol;

        if (!card._hovering) {
          const swapList = card.querySelector('[data-role="swaps"]');
          if (swapList) {
            const existingCount = swapList.querySelectorAll('.token-swap-row').length;
            const newCount = swaps.length - existingCount;
            if (newCount > 0) {
              const collapseBtn = swapList.querySelector('.swap-collapse-btn');
              const onDel = score ? null : makeTrackerDeleteHandler(token);
              for (let i = newCount - 1; i >= 0; i--) {
                const firstRow = swapList.querySelector('.token-swap-row');
                swapList.insertBefore(
                    buildSwapRow(swaps[i], score ? makeFreshSwapOpts(swaps[i]) : makeTrackerSwapOpts(swaps[i], onDel)),
                    firstRow || collapseBtn || null
                );
              }
              refreshCollapseUI(card);
            }
          }
        }
        updateCrossIndicator(token, card);
      }
    }

    for (const [token, card] of cardMap) {
      card.style.display = visible.has(token) ? '' : 'none';
    }

    for (const { token, swaps, score } of [...newItems].reverse()) {
      if (qActive && token.toLowerCase().includes(qActive)) console.log(`[SEARCH][${listId}] BUILDING card for ${token}, swaps=`, swaps.length);
      let newCard;
      try {
        newCard = buildCard(token, swaps, score);
      } catch (e) {
        console.error(`[SEARCH][${listId}] buildCard() THREW for token=${token}:`, e, 'swaps=', swaps);
        continue; // не роняем весь patch() из-за одной кривой карточки
      }
      list.prepend(newCard);
      cardMap.set(token, newCard);
      refreshCollapseUI(newCard);
      updateCrossIndicator(token, newCard);
      newCardAdded = true;
      if (qActive && token.toLowerCase().includes(qActive)) console.log(`[SEARCH][${listId}] card for ${token} INSERTED into DOM. list.children=`, list.children.length, 'display=', getComputedStyle(list).display);
    }

    // ── Компенсация скролла через якорную карточку ──────────────────────────
    if (anchorCard && anchorCard.isConnected && scrollEl) {
      const rect = anchorCard.getBoundingClientRect();
      const containerRect = scrollEl.getBoundingClientRect();
      const newTop = rect.top - containerRect.top + scrollEl.scrollTop;
      const delta = newTop - anchorTop;
      if (Math.abs(delta) > 0.5) {
        scrollEl.scrollTop += delta;
        slog(`ANCHOR-COMP [${listId}] delta=${delta.toFixed(1)} scrollTop→${scrollEl.scrollTop}`);
      }
    }

    // ── Автоскролл вверх (только если курсор НЕ над лентой) ────────────────
    if (newCardAdded && !_cursorInFeed && scrollEl && scrollEl.scrollTop > 50 && !_scrollingTop) {
      _scrollingTop = true;
      scrollEl.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => { _scrollingTop = false; }, 700);
    }

    // ── Обновление hover после изменений ──────────────────────────────────────
    if (_cursorInFeed && _cursorInWindow) {
      updateHoverFromCursor();
    }

    if (onAfterPatch) onAfterPatch();
  }

  // render: сброс DOM + patch
  function render() {
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = '';
    cardMap.clear();
    patch();
  }

  // updateFromSignal: нормализует сигнал → обновляет реестр → patch
  function updateFromSignal(sig) {
    if (!normalizeSignal) return;
    const registry = getRegistry();
    const metaMap  = getMeta();
    if (!registry[sig.token]) registry[sig.token] = [];
    const swaps = registry[sig.token];
    const norm  = normalizeSignal(sig);
    if (swaps.some(norm.isDuplicate)) return;
    swaps.unshift(norm.swap);
    if (!metaMap[sig.token] || !metaMap[sig.token].symbol) metaMap[sig.token] = norm.meta;
    patch();
  }

  startScrollGuard();
  return { patch, render, updateFromSignal };
}

// ── Инстансы менеджеров ───────────────────────────────────────────────────────

const atManager = createFeedManager({
  listId:   'sig-list',
  emptyId:  'at-signal-empty',
  getRegistry: () => _tokenRegistry,
  getMeta:     () => _tokenMeta,
  cardMap:     _sigCards,
  staleMs:     STALE_MS,
  maxCards:    SIGNAL_MAX,
  scoreSwaps:  null,
  buildCard:   (token, swaps) => buildTokenCard(token, swaps, { meta: _tokenMeta[token] || {}, score: null }),
  normalizeSignal: (sig) => ({
    isDuplicate: (s) => s.wallet === sig.wallet && s.ts === sig.ts,
    swap: {
      wallet:      sig.wallet,
      wallet_name: sig.wallet_name || '',
      group_id:    sig.group_id    || 0,
      group_name:  sig.group_name  || '',
      group_color: sig.group_color || '#EF911A',
      is_bad:      !!sig.is_bad,
      marker:      sig.marker      || '',
      sol:         sig.sol,
      ts:          sig.ts,
      signature:   sig.signature   || '',
    },
    meta: {
      name:               sig.name               || '',
      symbol:             sig.symbol             || '',
      image:              sig.image              || null,
      da:                 sig.da                 || null,
      pa:                 sig.pa                 || null,
      dev_buy_sol:        sig.dev_buy_sol        ?? null,
      dev_balance_before: sig.dev_balance_before ?? null,
    },
  }),
  getCrossRegistry:  () => _afReg,          // бейдж если токен есть и во Fresh
  crossLabel:        '⚡ Fresh',
});

const afManager = createFeedManager({
  listId:   'sig-list-fresh',
  emptyId:  'af-sig-empty',
  getRegistry:      () => _afReg,
  getMeta:          () => _afMeta,
  cardMap:          _afCards,
  staleMs:          0,
  maxCards:         SIGNAL_MAX, // 100, симметрично Tracker (решение диалога — раньше 0 = без капа на этом уровне)
  scoreSwaps:       (token) => _afScores[token] || null,
  buildCard:        (token, swaps, score) => buildTokenCard(token, swaps, { meta: _afMeta[token] || {}, score }),
  normalizeSignal:  (sig) => ({
    isDuplicate: (s) => s.wallet === sig.wallet,
    swap: {
      wallet:       sig.wallet,
      created_at:   Number(sig.created_at)   || 0,
      received_sol: Number(sig.received_sol) || 0,
      cluster_id:   sig.cluster_id,
      cex_name:     sig.cex_name,
      sol:          sig.sol,
      ts:           sig.ts,
      state:        sig.source || 'cex',
    },
    meta: {
      name:                   sig.name     || '',
      symbol:                 sig.symbol   || '',
      image:                  sig.image    || null,
      da:                     sig.da       || null,
      pa:                     sig.pa       || null,
      creator_balance_before: sig.creator_balance_before ?? null,
      dev_buy_sol:            sig.dev_buy_sol            ?? null,
      website:                sig.website  || null,
      twitter:                sig.twitter  || null,
      telegram:               sig.telegram || null,
    },
  }),
  hideListWhenEmpty: true,
  onAfterPatch:      () => updateFooter(),
  getCrossRegistry:  () => _tokenRegistry,  // бейдж если токен есть и в Tracker
  crossLabel:        '⚡ Tracker',
});

// ── Враперы (обратная совместимость с setInterval / message handlers) ─────────
function patchSignalFeed()             { atManager.patch(); }
function renderSignalFeed()            { atManager.render(); }
function updateRegistryFromSignal(sig) { atManager.updateFromSignal(sig); }
function patchFreshFeed()              { afManager.patch(); }
function renderFreshFeed()             { afManager.render(); }
function updateFreshRegistry(sig)      { afManager.updateFromSignal(sig); }
function renderAllSignals()            { atManager.render(); }

// ── AF messages ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.type) return;
  if (msg.type === 'af-signal') {
    const item = msg.data;
    // Возрастной дроп убран (решение диалога) — что пришло в событии, то и рисуем,
    // capping только по количеству (AF_MAX_TOKENS/SIGNAL_SHOW в background.js).
    if (item.token && item.level != null) {
      _afScores[item.token] = { level: item.level, cardType: item.card_type };
    }
    updateFreshRegistry(item);
  }
  if (msg.type === 'af-state') {
    if (msg.registry  && typeof msg.registry  === 'object') _afReg    = msg.registry;
    if (msg.tokenMeta && typeof msg.tokenMeta === 'object') _afMeta   = msg.tokenMeta;
    if (msg.scores    && typeof msg.scores    === 'object') _afScores = msg.scores;
    renderFreshFeed();
  }
  if (msg.type === 'af-token-meta-update') {
    if (!msg.ca || !msg.meta) return;
    const prev   = _afMeta[msg.ca] || {};
    const merged = Object.assign({}, prev);
    for (const k of ['name','symbol','image','da','pa','website','twitter','telegram','dev_buy_sol','creator_balance_before']) {
      if ((merged[k] == null || merged[k] === '') && msg.meta[k] != null) merged[k] = msg.meta[k];
    }
    _afMeta[msg.ca] = merged;
    const card = _afCards.get(msg.ca);
    if (card) { card.remove(); _afCards.delete(msg.ca); }
    patchFreshFeed();
  }
});


// ── Incoming signal from background ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'at-signal') {
    const item = msg.data;
    // Возрастной дроп убран (решение диалога) — что пришло, то и рисуем,
    // capping только по количеству (SIGNAL_MAX).
    _signals.push({ id: Date.now() + Math.random(), ...item });
    if (_signals.length > SIGNAL_MAX) _signals = _signals.slice(-SIGNAL_MAX);
    updateRegistryFromSignal(item);
    playSignalSound();
  }

  if (msg?.type === 'at-state') {
    if (Array.isArray(msg.signals)) _signals = msg.signals;
    // Возрастной фильтр убран (решение диалога) — берём реестр как есть,
    // background уже прислал top-N по recency (SIGNAL_SHOW), наплевать на давность.
    if (msg.registry && typeof msg.registry === 'object') {
      const fresh = {};
      for (const [ca, swaps] of Object.entries(msg.registry)) {
        if (!Array.isArray(swaps) || !swaps.length) continue;
        fresh[ca] = swaps;
      }
      _tokenRegistry = fresh;
    }
    if (msg.tokenMeta && typeof msg.tokenMeta === 'object') _tokenMeta = msg.tokenMeta;
    renderAllSignals();
  }

  // ── Blacklist sync от background.js (после успешного API-вызова) ─────────────
  // API-вызов теперь делает ТОЛЬКО background.js. Здесь лишь обновляем UI и кеш.
  // Это гарантирует отсутствие гонки двух addwallets с разными group_id.
  if (msg?.type === 'at-bl-done') {
    wgRefreshBlacklistStates().catch(() => {});
  }
});

async function loadSignals() {
  chrome.runtime.sendMessage({ type: 'at-get-state' }).catch(() => {});
  // Запрашиваем состояние Fresh Feed
  chrome.runtime.sendMessage({ type: 'af-get-state' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  LOCK CACHE                                                             ██
// ══════════════════════════════════════════════════════════════════════════════
// Храним только список неприкосаемых кошельков (group_id=212, ui_section=98).
// background.js читает at_wallet_locked_cache перед любым blacklist-действием.
// at_wallet_bad_cache background.js обновляет сам инкрементально — нам не нужно.

const LOCK_GROUP_ID          = 212; // group_id группы «Неприкосаемый», создан вручную
const WALLET_LOCKED_LIST_KEY = 'at_wallet_locked_cache';

let _lockSet        = new Set(); // in-memory, синхронизирован со storage
let _walletNameCache = {}; // address → name (для экспорта, заполняется из слотов)

// При старте: если кэш пуст (переустановка) — грузим с сервера один раз.
// Если кэш есть — доверяем ему, мы единственная точка правды.
async function initLockCache() {
  if (!ctxOk()) return;
  try {
    const r = await chrome.storage.local.get(WALLET_LOCKED_LIST_KEY);
    const cached = r[WALLET_LOCKED_LIST_KEY];
    if (Array.isArray(cached) && cached.length > 0) {
      _lockSet = new Set(cached);
      return;
    }
    // Кэш пуст — переустановка расширения, грузим с сервера
    const result = await apiRecent('tracker', { limit: 1000, group_id: LOCK_GROUP_ID });
    const addrs  = (result?.wallets || []).map(w => w.address);
    _lockSet = new Set(addrs);
    await chrome.storage.local.set({ [WALLET_LOCKED_LIST_KEY]: addrs });
  } catch (_) {}
}

// Инкрементальное обновление кэша при SSE-событиях
async function updateLockCache(address, isLocked) {
  if (!ctxOk()) return;
  if (isLocked) _lockSet.add(address);
  else          _lockSet.delete(address);
  await chrome.storage.local.set({ [WALLET_LOCKED_LIST_KEY]: [..._lockSet] }).catch(() => {});
}




// ── Groups API helpers ────────────────────────────────────────────────────────

async function apiGroupCreate(fields) {
  return apiFetch('/groups/create', BOT_BASE_URL + '/groups/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}

async function apiGroupUpdate(group_id, fields) {
  return apiFetch('/groups/update', BOT_BASE_URL + '/groups/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id, ...fields }),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  GLOBAL FOOTER                                                           ██
// ══════════════════════════════════════════════════════════════════════════════

// Контекстные тексты по вкладке/подвкладке
function _gfGetContext() {
  const activeTab = document.querySelector('.tab-btn.active')?.id?.replace('btn-tab-', '') || 'tracker';
  if (activeTab === 'groups') {
    const total = _groups.length;
    return total ? total + ' group' + (total !== 1 ? 's' : '') : '';
  }
  // tracker
  const subTab = document.querySelector('[data-tracker-tab].active')?.dataset?.trackerTab || 'signal';
  if (subTab === 'signal') {
    return '';  // только лампочки API/SSE — счётчик токенов убран
  }
  if (subTab === 'list') {
    const el = document.getElementById('wg-list-count');
    return el?.textContent || '';
  }
  if (subTab === 'blacklist') {
    const el = document.getElementById('wg-bl-count');
    return el?.textContent || '';
  }
  return '';
}

function updateFooter() {
  if (window.AngryFooter) AngryFooter.setContext(_gfGetContext());
}

// Совместимость: botapi.js / loadGroups вызывают flashApiLed() — делегируем общему футеру
function flashApiLed() {
  if (window.AngryFooter) AngryFooter.flashAPI();
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  INIT                                                                    ██
// ══════════════════════════════════════════════════════════════════════════════

let _keepalivePort = null;
function startKeepalive() {
  try {
    _keepalivePort = chrome.runtime.connect({ name: 'at-keepalive' });
    _keepalivePort.onDisconnect.addListener(() => {
      _keepalivePort = null;
      setTimeout(startKeepalive, 1000);
    });
  } catch (_) {}
}
startKeepalive();

(async () => {

  // Загружаем группы с сервера
  await loadGroups();

  // Восстанавливаем сохранённые фильтры

  // Инициализируем группо-зависимые элементы

  // Восстанавливаем вкладки
  const r1 = await storageGet(TAB_STORAGE_KEY);
  switchTab(['tracker', 'groups'].includes(r1[TAB_STORAGE_KEY]) ? r1[TAB_STORAGE_KEY] : 'tracker', false);

  loadSignals();
  updateFooter();

  // ── Звук: инициализируем из storage и вешаем тогл в футер ────────────────
  (async () => {
    const r = await storageGet(AT_SOUND_KEY);
    const s = Object.assign({ swap: true }, r[AT_SOUND_KEY] || {});
    _soundSwap = !!s.swap;
    const cb = document.getElementById('cb-sound-swap');
    if (cb) {
      cb.checked = _soundSwap;
      cb.addEventListener('change', () => {
        _soundSwap = cb.checked;
        storageSet({ [AT_SOUND_KEY]: { swap: _soundSwap } });
      });
    }
    // Рисуем иконку колокольчика
    const bellEl = document.getElementById('gf-bell-icon');
    if (bellEl) bellEl.innerHTML = AT_SVG_BELL;
  })();

  // Поллим SSE статус у background каждые 2с — это также будит SW
  const _ssePollTimer = setInterval(() => {
    if (!ctxOk()) { clearInterval(_ssePollTimer); return; }
    chrome.runtime?.sendMessage({ type: 'at-get-sse-status' })?.catch(() => {});
  }, 2000);
  if (ctxOk()) chrome.runtime?.sendMessage({ type: 'at-get-sse-status' })?.catch(() => {});

  // Чистим старый кэш несовместимого формата
  if (ctxOk()) {
    chrome.storage.local.remove(['at_signals', SLOT_WALLETS_KEY]).catch(() => {});
    _slotWalletsCache = {}; _slotCacheLoaded = false;
  }

  // ── Signal filter ────────────────────────────────────────────────────────────
  const filterInput = document.getElementById('filter-input');
  const filterClear = document.getElementById('filter-clear');
  filterInput?.addEventListener('input', () => {
    _filterQuery = filterInput.value.trim();
    filterClear?.classList.toggle('visible', _filterQuery.length > 0);
    atManager.patch(); afManager.patch();
    scheduleApiTokenSearch(_filterQuery);
  });
  filterInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(_apiSearchTimer);
    if (_filterQuery.length >= API_SEARCH_MIN_LEN) runApiTokenSearch(_filterQuery, /* immediate */ true);
  });
  filterClear?.addEventListener('click', () => {
    clearTimeout(_apiSearchTimer);
    filterInput.value = ''; _filterQuery = '';
    filterClear.classList.remove('visible');
    filterInput.focus(); atManager.patch(); afManager.patch();
  });

  // New Slot button
  document.getElementById('at-btn-new-slot')?.addEventListener('click', async () => {
    try {
      const group = await apiGroupCreate({
        name: 'New Slot', overlay_color: '#EF911A', text_bg_color: '#421f67',
        track_swaps: 1, track_transfers: 0, min_buy_amount: 0.1, sort_order: 0, ui_section: 1,
      });
      _groups.push(group);
      const empty = document.getElementById('at-slots-empty');
      if (empty) empty.style.display = 'none';
      const card = await buildSlotCard(group);
      document.getElementById('at-slots-list').appendChild(card);
    } catch (e) { showToast(e.message, true); }
  });

  // New Group (List, ui_section=0)
  document.getElementById('at-btn-new-group-list')?.addEventListener('click', async () => {
    try {
      const group = await apiGroupCreate({
        name: 'New Group', overlay_color: '#EF911A', text_bg_color: '#EF911A',
        track_swaps: 1, track_transfers: 1, min_buy_amount: 0.1, sort_order: 0, ui_section: 0,
      });
      _groups.push(group);
      const container = document.getElementById('at-groups-list-container');
      const empty     = document.getElementById('at-groups-list-empty');
      if (empty) empty.style.display = 'none';
      container.appendChild(buildGroupCard(group));
    } catch (e) { showToast(e.message, true); }
  });

  // New Group (Blacklist, ui_section=99)
  document.getElementById('at-btn-new-group-bl')?.addEventListener('click', async () => {
    try {
      const group = await apiGroupCreate({
        name: 'New Blacklist', overlay_color: '#BE3030', text_bg_color: '#BE3030',
        track_swaps: 1, track_transfers: 0, min_buy_amount: 0.1, sort_order: 0, ui_section: 99,
      });
      _groups.push(group);
      const container = document.getElementById('at-groups-bl-container');
      const empty     = document.getElementById('at-groups-bl-empty');
      if (empty) empty.style.display = 'none';
      container.appendChild(buildGroupCard(group));
    } catch (e) { showToast(e.message, true); }
  });

  // Инициализируем кэш неприкосаемых (грузим с сервера только при пустом кэше)
  initLockCache().catch(() => {});

  // Инкрементальные обновления кэша неприкосаемых от SSE-событий
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'at-wallet-event') return;
    const { event: evt, data } = msg;

    if (evt === 'wallet_move') {
      updateLockCache(data.address, data.group_id === LOCK_GROUP_ID).catch(() => {});
    }
    if (evt === 'wallet_delete') {
      updateLockCache(data.address, false).catch(() => {});
    }
  });
})();
