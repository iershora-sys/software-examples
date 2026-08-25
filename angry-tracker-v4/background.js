// Angry Tracker — Service Worker v3 (SSE)
'use strict';

importScripts('shared/sse-client.js');

// ── Constants ──────────────────────────────────────────────────────────────────
const AT_SETTINGS_KEY = 'at_settings';
const AT_LOG_KEY      = 'at_console_log_enabled';
const AT_REGISTRY_KEY = 'at_registry';
const AT_EVENTS_KEY   = 'at_last_event_id';

const FRESH_API_BASE  = 'https://trader.bot.nu/solana';
const MAX_SIGNALS     = 100;   // лента SSE-сигналов в памяти
const MAX_TOKENS      = 2000;  // storage + registry: 12ч рабочего дня трейдера
const SIGNAL_SHOW     = 100;   // сколько токенов рендерим в сайдбаре (не тормозит)
const SSE_RECONNECT_MS = 2_000;
const STALE_MS        = 12 * 60 * 60 * 1000; // БОЛЬШЕ НЕ ИСПОЛЬЗУЕТСЯ для фильтрации
                                              // (решение диалога — убрали возрастную
                                              // отсечку везде, capping только по
                                              // MAX_TOKENS/SIGNAL_SHOW). Оставлена как
                                              // константа только для debug-логов ниже.
const SSE_STALE_MS    = 5  * 60 * 1000;       // БОЛЬШЕ НЕ ИСПОЛЬЗУЕТСЯ (было: skip
                                              // старых SSE-событий в processEvent) —
                                              // убрано тем же решением, не вызывается нигде.

const SETTINGS_DEFAULTS = { api_base: FRESH_API_BASE };

// ── State ──────────────────────────────────────────────────────────────────────
let _tokenRegistry = new Map(); // ca → swaps[]
let _tokenMeta     = new Map(); // ca → {name, symbol, image, da, pa, ...}
let _signals       = [];
let _lastEventId   = 0;
let _logEnabled    = false;
let _groupMap      = new Map(); // group_id → {ui_section, name, color}

const log = (...a) => { if (_logEnabled) console.log('[AT][bg]', ...a); };

// ── Keepalive ──────────────────────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'at-keepalive') return;
  port.onDisconnect.addListener(() => {});
});

// ── Action click ───────────────────────────────────────────────────────────────
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id || !tab.url?.includes('axiom.trade')) return;
  chrome.tabs.sendMessage(tab.id, { type: 'at-toggle-panel' }).catch(() => {});
});

// ── Dedup ──────────────────────────────────────────────────────────────────────
const DEDUP_MAX   = 10_000;
const _dedupSet   = new Set();
const _dedupQueue = [];

function dedupSeen(key) {
  if (_dedupSet.has(key)) return true;
  _dedupSet.add(key);
  _dedupQueue.push(key);
  if (_dedupQueue.length > DEDUP_MAX) _dedupSet.delete(_dedupQueue.shift());
  return false;
}

// ── Timestamp normalization ─────────────────────────────────────────────────────
// Сервер отдаёт created_at то в секундах, то в мс — единая точка нормализации
// для обоих потоков (AT + AF), используется и в live-обработке, и в snapshot-ingest.
function normalizeTs(raw, fallbackMs) {
  const n = Number(raw);
  if (!n) return fallbackMs;
  return n > 1e12 ? n : n * 1000; // > 1e12 уже мс, иначе секунды → мс
}

// ── API base ───────────────────────────────────────────────────────────────────
async function getApiBase() {
  const r = await chrome.storage.local.get(AT_SETTINGS_KEY);
  const s = Object.assign({}, SETTINGS_DEFAULTS, r[AT_SETTINGS_KEY] || {});
  return (s.api_base || FRESH_API_BASE).replace(/\/$/, '');
}

// ── Groups cache ───────────────────────────────────────────────────────────────
async function loadGroups() {
  try {
    const base = await getApiBase();
    const res  = await fetch(`${base}/groups`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return;
    const data = await res.json();
    const groups = data.result || [];
    _groupMap.clear();
    for (const g of groups) {
      _groupMap.set(g.group_id, {
        ui_section:     g.ui_section ?? 0,
        name:           g.name        || 'Main',
        color:          g.text_bg_color || '#EF911A',
        min_buy_amount: g.min_buy_amount ?? 0.1,
      });
    }
    if (!_groupMap.has(0)) _groupMap.set(0, { ui_section: 0, name: 'Main', color: '#EF911A', min_buy_amount: 0.1 });
    log(`groups loaded: ${_groupMap.size}`);
    await chrome.storage.local.set({ at_groups_cache: groups });
  } catch (e) {
    log('loadGroups error:', e.message);
  }
}

function getUiSection(group_id, is_bad) {
  // Safety-net: плохой кошелёк ВСЕГДА blacklist-сигнал, даже если group_id некорректный
  if (is_bad) return 99;
  if (_groupMap.has(group_id)) return _groupMap.get(group_id).ui_section;
  return 0;
}

// ── Registry persistence ───────────────────────────────────────────────────────
let _registrySaveTimer = null;

function scheduleRegistrySave() {
  clearTimeout(_registrySaveTimer);
  _registrySaveTimer = setTimeout(saveRegistry, 2000);
}

async function saveRegistry() {
  try {
    // Сохраняем максимум MAX_TOKENS самых свежих (решение диалога: без возрастной
    // отсечки по STALE_MS — что нашли/накопили, то и храним, capping только по количеству).
    const fresh = [..._tokenRegistry.entries()]
      .map(([ca, swaps]) => ({
        ca, swaps,
        ts: Array.isArray(swaps) ? Math.max(...swaps.map(s => s.ts || 0)) : 0,
      }))
      .filter(({ ts }) => ts)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_TOKENS);

    const registry  = Object.fromEntries(fresh.map(x => [x.ca, x.swaps]));
    const tokenMeta = {};
    for (const { ca } of fresh) {
      if (_tokenMeta.has(ca)) tokenMeta[ca] = _tokenMeta.get(ca);
    }
    await chrome.storage.local.set({
      [AT_REGISTRY_KEY]: { registry, tokenMeta },
      [AT_EVENTS_KEY]:   _lastEventId,
    });
  } catch (e) {
    console.error('[AT][bg] saveRegistry error:', e?.message);
  }
}

async function loadRegistry() {
  try {
    const r    = await chrome.storage.local.get([AT_REGISTRY_KEY, AT_EVENTS_KEY]);
    const data = r[AT_REGISTRY_KEY] || {};
    if (data.registry) {
      _tokenRegistry = new Map(Object.entries(data.registry));
      _tokenMeta     = new Map(Object.entries(data.tokenMeta || {}));

      // ── Чистим битый кеш: без ts вообще, ИЛИ без wallet у отдельных свапов ────
      // (решение диалога) — возрастную отсечку убрали (что нашли, то и показываем,
      // capping только по количеству), но свап без wallet — не свап, это "скелет"
      // из прошлых багов сессии (напр. _afMeta-баг, недособранный ingest и т.п.),
      // такие записи только ломают рендер (см. buildSwapRow) и не несут пользы.
      let flushed = 0, swapsFixed = 0;
      for (const [ca, swaps] of _tokenRegistry) {
        if (!Array.isArray(swaps)) { _tokenRegistry.delete(ca); _tokenMeta.delete(ca); flushed++; continue; }
        const validSwaps = swaps.filter(s => s && s.wallet);
        if (validSwaps.length !== swaps.length) {
          swapsFixed += swaps.length - validSwaps.length;
          if (validSwaps.length) _tokenRegistry.set(ca, validSwaps);
        }
        const latestTs = validSwaps.length ? Math.max(...validSwaps.map(s => s.ts || 0)) : 0;
        if (!latestTs) {
          _tokenRegistry.delete(ca);
          _tokenMeta.delete(ca);
          flushed++;
        }
      }
      if (flushed || swapsFixed) log(`registry: flushed ${flushed} broken tokens, dropped ${swapsFixed} walletless swaps, ${_tokenRegistry.size} remain`);

      // Обрезаем до MAX_TOKENS самых свежих
      if (_tokenRegistry.size > MAX_TOKENS) {
        const sorted = [..._tokenRegistry.entries()]
          .map(([ca, swaps]) => ({ ca, swaps, ts: Math.max(...swaps.map(s => s.ts || 0)) }))
          .sort((a, b) => b.ts - a.ts);
        _tokenRegistry = new Map(sorted.slice(0, MAX_TOKENS).map(x => [x.ca, x.swaps]));
        _tokenMeta     = new Map([..._tokenMeta.entries()].filter(([ca]) => _tokenRegistry.has(ca)));
        log(`registry: trimmed to ${MAX_TOKENS}`);
      }

      // Если реестр полностью устарел — сбрасываем курсор
      _lastEventId = _tokenRegistry.size === 0 ? 0 : (r[AT_EVENTS_KEY] || 0);
    } else {
      _tokenRegistry = new Map();
      _tokenMeta     = new Map();
      _lastEventId   = 0;
      log('registry: old format detected, dropped');
    }
    log(`registry loaded: ${_tokenRegistry.size} tokens, lastEventId=${_lastEventId}`);
  } catch (_) {}
}

// ── Тихая загрузка исторических событий в реестр (старт / переподключение) ────
// Формат идентичен SSE payload (enriched): event.payload.token.CA + event.payload.swaps[].
// Raw-формат (/tracker/events/latest) больше НЕ используется — там нет token metadata.
function ingestEvent(event) {
  const tokenData = event.payload?.token;
  const rawSwaps  = event.payload?.swaps;
  const ca        = tokenData?.CA;

  if (!ca || !rawSwaps?.length) return;

  _tokenMeta.set(ca, {
    name:               tokenData.name   || '',
    symbol:             tokenData.symbol || '',
    image:              tokenData.image  || null,
    da:                 tokenData.DA     || null,
    pa:                 tokenData.PA     || null,
    dev_buy_sol:        tokenData.dev_buy_sol        ?? null,
    dev_balance_before: tokenData.dev_balance_before ?? null,
  });

  // created_at приходит то в секундах, то в мс — нормализуем (см. normalizeTs),
  // тот же баг что убивал live-ленту после timestamp-фикса в processEvent.
  const nowMs = normalizeTs(event.created_at, Date.now());
  const newSwaps = rawSwaps.map(s => ({
    wallet:           s.user,
    wallet_name:      s.wallet_name || '',
    group_id:         s.group_id    || 0,
    group_name:       s.group_name  || '',
    group_color:      s.group_color || '#EF911A',
    group_ui_section: getUiSection(s.group_id || 0, !!s.is_bad),
    is_bad:           !!s.is_bad,
    marker:           s.marker      || '',
    sol:              Number(s.sol_amount),
    ts:               normalizeTs(s.created_at, nowMs),
    signature:        s.signature   || '',
  }));

  if (_tokenRegistry.has(ca)) {
    const existing = _tokenRegistry.get(ca);
    const seen = new Set(existing.map(s => s.signature || `${s.wallet}_${s.ts}`));
    const toAdd = newSwaps.filter(s => !seen.has(s.signature || `${s.wallet}_${s.ts}`));
    if (toAdd.length) {
      _tokenRegistry.set(ca, [...existing, ...toAdd].sort((a, b) => a.ts - b.ts));
    }
  } else {
    if (_tokenRegistry.size >= MAX_TOKENS) {
      let oldestCa = null, oldestTs = Infinity;
      for (const [c, swaps] of _tokenRegistry) {
        const t = Array.isArray(swaps) ? Math.max(...swaps.map(s => s.ts || 0)) : 0;
        if (t < oldestTs) { oldestTs = t; oldestCa = c; }
      }
      if (oldestCa) { _tokenRegistry.delete(oldestCa); _tokenMeta.delete(oldestCa); }
    }
    _tokenRegistry.set(ca, newSwaps);
  }
}


function processEvent(event) {
  // created_at от сервера может быть в секундах или мс — нормализуем в мс (важно
  // для самого ts свапа ниже, см. normalizeTs). Skip по возрасту события (был по
  // SSE_STALE_MS = 5 мин) УБРАН (решение диалога) — что пришло в событии, то и
  // рисуем, наплевать на давность; capping только по количеству (MAX_TOKENS/
  // SIGNAL_SHOW).
  const createdAtMs = normalizeTs(event.created_at, 0);

  const { token: tokenData, swaps: rawSwaps } = event.payload || {};
  if (!tokenData || !rawSwaps?.length) return;

  const ca = tokenData.CA;
  if (!ca) return;

  const meta = {
    name:               tokenData.name   || '',
    symbol:             tokenData.symbol || '',
    image:              tokenData.image  || null,
    da:                 tokenData.DA     || null,
    pa:                 tokenData.PA     || null,
    dev_buy_sol:        tokenData.dev_buy_sol        ?? null,
    dev_balance_before: tokenData.dev_balance_before ?? null,
  };
  _tokenMeta.set(ca, meta);

  const now = createdAtMs || Date.now();

  const registrySwaps = rawSwaps.map(s => ({
    wallet:           s.user,
    wallet_name:      s.wallet_name || '',
    group_id:         s.group_id    || 0,
    group_name:       s.group_name  || '',
    group_color:      s.group_color || '#EF911A',
    group_ui_section: getUiSection(s.group_id || 0, !!s.is_bad),
    is_bad:           !!s.is_bad,
    marker:           s.marker      || '',
    sol:              Number(s.sol_amount),
    ts:               normalizeTs(s.created_at, now),
    signature:        s.signature   || '',
  }));

  if (_tokenRegistry.size >= MAX_TOKENS && !_tokenRegistry.has(ca)) {
    // Вытесняем самый старый токен по ts (не первый вставленный)
    let oldestCa = null, oldestTs = Infinity;
    for (const [c, swaps] of _tokenRegistry) {
      const t = Array.isArray(swaps) ? Math.max(...swaps.map(s => s.ts || 0)) : 0;
      if (t < oldestTs) { oldestTs = t; oldestCa = c; }
    }
    if (oldestCa) { _tokenRegistry.delete(oldestCa); _tokenMeta.delete(oldestCa); }
  }
  _tokenRegistry.set(ca, registrySwaps);

  const trigRaw   = rawSwaps.find(s => Number(s.swap_id) === event.swap_id) || rawSwaps[rawSwaps.length - 1];
  const trigEntry = registrySwaps.find(s => s.wallet === trigRaw.user) || registrySwaps[registrySwaps.length - 1];

  const signal = {
    wallet:             trigRaw.user,
    wallet_name:        trigEntry.wallet_name,
    token:              ca,
    sol:                trigEntry.sol,
    ts:                 now,
    signature:          trigRaw.signature || '',
    is_bad:             trigEntry.is_bad,
    marker:             trigEntry.marker,
    group_id:           trigEntry.group_id,
    group_name:         trigEntry.group_name,
    group_color:        trigEntry.group_color,
    group_ui_section:   trigEntry.group_ui_section,
    count:              registrySwaps.length,
    name:               meta.name,
    symbol:             meta.symbol,
    image:              meta.image,
    da:                 meta.da,
    pa:                 meta.pa,
    dev_buy_sol:        meta.dev_buy_sol,
    dev_balance_before: meta.dev_balance_before,
  };

  log(`[${signal.is_bad ? 'BAD' : 'OK'}] ${signal.wallet_name || signal.wallet.slice(0,8)} → ${ca.slice(0,8)} ${signal.sol.toFixed(3)} SOL | ${signal.group_name} [sec:${trigEntry.group_ui_section}]`);

  _signals.unshift(signal);
  if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;

  chrome.runtime.sendMessage({ type: 'at-signal', data: signal }).catch(() => {});

  chrome.tabs.query({ url: ['https://axiom.trade/*', 'http://axiom.trade/*'] }, (tabs) => {
    for (const tab of tabs || []) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'at-signal-relay', data: {
        token:            ca,
        group_id:         trigEntry.group_id,
        group_name:       trigEntry.group_name,
        group_color:      trigEntry.group_color,
        group_ui_section: trigEntry.group_ui_section,
        count:            registrySwaps.length,
        sol:              trigEntry.sol,
        is_bad:           trigEntry.is_bad,
        wallet_name:      trigEntry.wallet_name,
        marker:           trigEntry.marker,
        source:           trigEntry.is_bad ? 'bad' : 'good',
      }}).catch(() => {});
    }
  });
}

// ── Wallets/Groups SSE ─────────────────────────────────────────────────────────
const relayWalletEvent = (eventName, data) => {
  chrome.runtime.sendMessage({ type: 'at-wallet-event', event: eventName, data }).catch(() => {});
};

const _walletsSse = AngrySSE.create({
  url: async () => `${await getApiBase()}/sse/wallets`,
  events: {
    // Group events: обновляем _groupMap и at_groups_cache
    group_create: () => loadGroups().catch(() => {}),
    group_update: () => loadGroups().catch(() => {}),
    group_delete: () => loadGroups().catch(() => {}),
    // Wallet events: relay в sidebar (если открыт)
    wallet_add:    (d) => relayWalletEvent('wallet_add',    d),
    wallet_delete: (d) => relayWalletEvent('wallet_delete', d),
    wallet_move:   (d) => relayWalletEvent('wallet_move',   d),
    wallet_mark:   (d) => relayWalletEvent('wallet_mark',   d),
    wakeup:        (d) => relayWalletEvent('wakeup',        d),
  },
  reconnectMs: 5000,
});

// ── SSE (tracker events) ────────────────────────────────────────────────────────
function onSseUpdate(data) {
  const events = data?.events || [];
  if (!events.length) return;

  _lastEventId = data.last_event_id || _lastEventId;

  for (const event of events) {
    if (dedupSeen(`ev:${event.event_id}`)) continue;
    processEvent(event);
  }
  scheduleRegistrySave();
}

const _sse = AngrySSE.create({
  url:          async () => `${await getApiBase()}/sse/tracker?since=${_lastEventId}`,
  events:       { update: onSseUpdate },
  onStatus:     (connected) => { chrome.runtime.sendMessage({ type: 'at-sse-status', connected }).catch(() => {}); },
  onParseError: (err) => log('SSE parse error:', err.message),
  reconnectMs:  SSE_RECONNECT_MS,
});

async function startSSE() {
  try {
    const base = await getApiBase();
    // Без since — сервер сам отдаёт последние ~50, enriched, тот же формат что SSE.
    const res  = await fetch(`${base}/tracker/events`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data   = await res.json(); // { events: [...enriched], last_event_id } — как SSE
      const events = data?.events || [];
      for (const event of events) {
        if (dedupSeen(`ev:${event.event_id}`)) continue;
        ingestEvent(event);
      }
      if (events.length) scheduleRegistrySave();
      _lastEventId = data.last_event_id || _lastEventId;
      log(`snapshot: ${events.length} events, cursor=${_lastEventId}`);
    }
  } catch (e) {
    log('snapshot error:', e.message);
  }

  // SSE открывается ПОСЛЕ snapshot, с курсором из его ответа.
  _sse.start();
}

// ── Broadcast state to sidebar ────────────────────────────────────────────────
function broadcastState() {
  // Top-SIGNAL_SHOW по recency, наплевать на давность (решение диалога) —
  // что нашли в событиях, то и рисуем, capping только по количеству.
  const fresh = [..._tokenRegistry.entries()]
    .map(([ca, swaps]) => ({
      ca, swaps,
      ts: Array.isArray(swaps) ? Math.max(...swaps.map(s => s.ts || 0)) : 0,
    }))
    .filter(({ ts }) => ts)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, SIGNAL_SHOW);

  const registry  = Object.fromEntries(fresh.map(x => [x.ca, x.swaps]));
  const tokenMeta = {};
  for (const { ca } of fresh) {
    if (_tokenMeta.has(ca)) tokenMeta[ca] = _tokenMeta.get(ca);
  }
  chrome.runtime.sendMessage({
    type: 'at-state',
    signals:   _signals.slice(0, SIGNAL_SHOW),
    registry,
    tokenMeta,
  }).catch(() => {});
}

// ── Поиск tracker-карточки: сначала live-реестр, потом API ────────────────────
// См. API-FEED.md §2 + разбор с покраской: _tokenRegistry этого service worker'а —
// источник истины (paint идёт из processEvent(), который пишет прямо сюда). Копия
// в sidebar может отстать (сообщение at-signal/at-state не долетело, пока панель
// была не смонтирована/лагала) — значит ПЕРЕД походом в сеть проверяем реальный
// in-memory реестр здесь, в background, а не полагаемся только на то, что видел
// sidebar. Только если и тут пусто — идём в API: /tokens/search (тикер/имя/mint)
// → /token/{mint}/tracker-event (готовая карточка, ТОТ ЖЕ payload.token+payload.swaps
// шейп что и live/snapshot — скармливаем в тот же ingestEvent()).
// Fresh-эквивалента у сервера нет (см. API-FEED.md §2.2) — только этот, tracker.
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58 без 0OIl — похоже на mint

// Точный CA — case-sensitive быстрый путь (base58 регистрозависим), иначе —
// та же case-insensitive substring-логика, что и локальный фильтр в sidebar.
function findInLiveRegistry(query) {
  const q = query.trim();
  console.log('[SEARCH][AT] findInLiveRegistry: q=', JSON.stringify(q), 'registrySize=', _tokenRegistry.size);
  if (!q) return null;
  if (_tokenRegistry.has(q)) {
    const swaps = _tokenRegistry.get(q) || [];
    console.log('[SEARCH][AT] findInLiveRegistry: EXACT CA match, swaps=', swaps.length,
      'maxTs=', swaps.length ? Math.max(...swaps.map(s => s.ts || 0)) : null, 'now=', Date.now());
    return q;
  }
  const qLower = q.toLowerCase();
  for (const [ca, swaps] of _tokenRegistry) {
    if (!swaps?.length) continue;
    if (ca.toLowerCase() === qLower) { console.log('[SEARCH][AT] findInLiveRegistry: case-insensitive CA match', ca); return ca; }
    const m = _tokenMeta.get(ca) || {};
    if ((m.symbol || '').toLowerCase().includes(qLower) ||
        (m.name   || '').toLowerCase().includes(qLower)) {
      console.log('[SEARCH][AT] findInLiveRegistry: symbol/name match', ca, m.symbol, m.name);
      return ca;
    }
  }
  console.log('[SEARCH][AT] findInLiveRegistry: NOT FOUND in live registry');
  return null;
}

async function apiSearchTokensByQuery(q, limit = 5) {
  const base = await getApiBase();
  const res  = await fetch(`${base}/tokens/search?q=${encodeURIComponent(q)}&limit=${limit}`, {
    signal: AbortSignal.timeout(8_000),
  });
  console.log('[SEARCH][AT] /tokens/search status=', res.status);
  if (!res.ok) return [];
  const data = await res.json();
  console.log('[SEARCH][AT] /tokens/search data=', data);
  return Array.isArray(data) ? data : [];
}

async function apiTrackerEventForMint(mint) {
  const base = await getApiBase();
  const res  = await fetch(`${base}/token/${encodeURIComponent(mint)}/tracker-event`, {
    signal: AbortSignal.timeout(8_000),
  });
  console.log('[SEARCH][AT] /token/.../tracker-event status=', res.status, 'mint=', mint);
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const data = await res.json();
  console.log('[SEARCH][AT] /token/.../tracker-event data=', data);
  return data;
}

async function searchTrackerCard(query) {
  const q = (query || '').trim();
  console.log('[SEARCH][AT] === searchTrackerCard START ===', JSON.stringify(q));
  if (!q) return { ok: false, reason: 'empty' };

  // 0. Сначала — свой живой реестр, без сети (см. комментарий выше).
  const liveCa = findInLiveRegistry(q);
  if (liveCa) {
    const swaps = _tokenRegistry.get(liveCa) || [];
    console.log('[SEARCH][AT] FOUND via live registry. ca=', liveCa, 'swaps.length=', swaps.length,
      'sample swap=', JSON.stringify(swaps[0]), 'meta=', JSON.stringify(_tokenMeta.get(liveCa)));
    return {
      ok: true, mint: liveCa,
      swaps,
      meta:  _tokenMeta.get(liveCa)     || {},
      swaps_count: swaps.length,
      symbol: _tokenMeta.get(liveCa)?.symbol || '',
      source: 'registry',
    };
  }

  // 1. Похоже на mint целиком — пробуем напрямую, не тратим /tokens/search.
  const candidates = MINT_RE.test(q) ? [q] : [];
  console.log('[SEARCH][AT] not in live registry. MINT_RE.test=', MINT_RE.test(q), 'candidates=', candidates);

  if (!candidates.length) {
    try {
      const found = await apiSearchTokensByQuery(q, 5);
      for (const t of found) if (t?.mint) candidates.push(t.mint);
    } catch (e) { console.log('[SEARCH][AT] /tokens/search ERROR:', e.message); log('search: /tokens/search error:', e.message); }
  }
  console.log('[SEARCH][AT] final candidates=', candidates);
  if (!candidates.length) { console.log('[SEARCH][AT] === RESULT: not_found ==='); return { ok: false, reason: 'not_found' }; }

  for (const mint of candidates) {
    let card;
    try { card = await apiTrackerEventForMint(mint); }
    catch (e) { console.log('[SEARCH][AT] /token/.../tracker-event ERROR:', e.message); log('search: /token/.../tracker-event error:', e.message); continue; }
    // swaps_count: 0 — токен существует, но tracker-активности по нему нет (не ошибка).
    console.log('[SEARCH][AT] card for', mint, 'swaps_count=', card?.swaps_count);
    if (card && card.swaps_count > 0) {
      console.log('[SEARCH][AT] before ingestEvent, _tokenRegistry.has(mint)=', _tokenRegistry.has(mint));
      ingestEvent(card); // тот же путь что snapshot/live — merge+dedup+нормализация ts
      const swaps = _tokenRegistry.get(mint) || [];
      console.log('[SEARCH][AT] FOUND via API. after ingestEvent, swaps.length=', swaps.length,
        'sample swap=', JSON.stringify(swaps[0]), 'maxTs=', swaps.length ? Math.max(...swaps.map(s=>s.ts||0)) : null,
        'now=', Date.now(), 'STALE_MS=', STALE_MS);
      // Отдаём уже смерженные (а не сырые card.payload) swaps/meta — после merge с
      // существующей записью в _tokenRegistry (dedup) это может отличаться от card.
      return {
        ok: true, mint,
        swaps,
        meta:  _tokenMeta.get(mint)     || {},
        swaps_count: swaps.length,
        symbol: card.payload?.token?.symbol || '',
        source: 'api',
      };
    }
  }
  console.log('[SEARCH][AT] === RESULT: no_tracker_activity ===');
  return { ok: false, reason: 'no_tracker_activity' };
}

// ── Messages ───────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.type) return;

  if (msg.type === 'at-get-sse-status') {
    // AngrySSE переподключается сам через onerror → scheduleReconnect().
    // startSSE() здесь убивал бы текущий EventSource и создавал петлю.
    chrome.runtime.sendMessage({ type: 'at-sse-status', connected: _sse.isOpen() }).catch(() => {});
  }

  if (msg.type === 'at-log-updated') _logEnabled = !!msg.enabled;

  if (msg.type === 'at-get-state') {
    broadcastState();
  }

  if (msg.type === 'at-clear-signals') {
    _signals = [];
    _tokenRegistry.clear();
    _tokenMeta.clear();
    _dedupSet.clear();
    _dedupQueue.length = 0;
    chrome.storage.local.remove([AT_REGISTRY_KEY]).catch(() => {});
    // Сохраняем текущий курсор — SSE переподключается с текущей позиции, не с 0
    chrome.storage.local.set({ [AT_EVENTS_KEY]: _lastEventId }).catch(() => {});
    _sse.reconnect();
  }

  // ── Blacklist cube action (meme_scanner → bridge → сюда) ─────────────────────
  // Единственный обработчик: sidebar.js больше НЕ делает API-вызов,
  // чтобы исключить гонку двух addwallets с разными group_id.
  if (msg.type === 'at-bl-action') {
    const { address, action } = msg;
    if (!address || !action) return;
    (async () => {
      try {
        // Проверяем: кошелёк в группе "Неприкосаемый" (id=98)?  
        // Если да — блокируем и уведомляем meme_scanner через bridge.
        const lockR = await chrome.storage.local.get('at_wallet_locked_cache');
        const lockSet = new Set(Array.isArray(lockR.at_wallet_locked_cache) ? lockR.at_wallet_locked_cache : []);
        if (lockSet.has(address)) {
          chrome.runtime.sendMessage({ type: 'at-bl-toast', text: '⚠️ КОШЕЛЁК НЕПРИКОСАЕМЫЙ' }).catch(() => {});
          log(`[BL] ${address.slice(0, 8)} — locked (ui_section=98), blocked`);
          return;
        }

        // SW мог только что проснуться → _groupMap ещё пустой.
        // Перезагружаем группы, чтобы гарантированно найти blacklist-группу (ui_section=99).
        await loadGroups();

        const base = await getApiBase();
        let resp;
        if (action === 'add') {
          let blGroupId = 0;
          for (const [gid, g] of _groupMap) { if (g.ui_section === 99) { blGroupId = gid; break; } }
          log(`[BL] add ${address.slice(0, 8)} → group ${blGroupId}`);
          resp = await fetch(`${base}/addwallets`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ database: 'tracker', wallets: [{ address, good: false, group_id: blGroupId }] }),
          });
        } else {
          resp = await fetch(`${base}/delwallet`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ database: 'tracker', address }),
          });
        }
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data || data.status !== 'OK') {
          log(`[BL] ${action} ${address.slice(0, 8)} — server rejected`);
          return; // не трогаем кэш → кубик не покраснеет, если сервер не принял
        }
        // Кэш bad-кошельков → storage.onChanged → bridge __at_bl_updated__ → перекраска
        const r   = await chrome.storage.local.get('at_wallet_bad_cache');
        const set = new Set(Array.isArray(r.at_wallet_bad_cache) ? r.at_wallet_bad_cache : []);
        if (action === 'add') set.add(address); else set.delete(address);
        await chrome.storage.local.set({ at_wallet_bad_cache: Array.from(set) });
        log(`[BL] ${action} ${address.slice(0, 8)} → ok`);
        // Toast-фидбек в meme_scanner: успех добавления/удаления
        const toastText = action === 'add' ? '✓ Added to Blacklist' : '✓ Removed from Blacklist';
        chrome.runtime.sendMessage({ type: 'at-bl-toast', text: toastText }).catch(() => {});
        // Уведомляем sidebar (если открыт) → пересинхронизировать UI и кеш кошельков.
        // Это гарантирует, что syncWalletSetToStorage запустится ПОСЛЕ успешного API-вызова.
        chrome.runtime.sendMessage({ type: 'at-bl-done', address, action }).catch(() => {});
      } catch (e) {
        log('[BL] action error: ' + (e && e.message));
      }
    })();
  }
});

// ── Top Traders/Holders scan (meme_scanner) → мгновенная дозапись в реестр ────
// (решение диалога) — не ждём SSE/API: если юзер УЖЕ видит трекнутый кошелёк в
// Top Traders/Holders ЭТОГО токена (лукап это подтвердил), значит активность по
// этому токену у кошелька точно есть — пишем сразу, без раунд-трипа.
// ЧЕСТНАЯ ОГОВОРКА: Top Traders не даёт точную сумму/время конкретного свапа по
// ЭТОМУ токену (там баланс/агрегаты, не сумма сделки) — пишем МИНИМАЛЬНУЮ запись
// (sol:0, ts:сейчас, from_tt_scan:true) только чтобы карточка не была пустым
// скелетом и сразу показывала кошелёк+группу; sidebar рендерит from_tt_scan
// заметно иначе (не выдумывает несуществующую сумму в SOL, см. buildSwapRow).
function mergeTtWallet(ca, wallet, group_id, group_name, group_color, is_bad) {
  console.log('[TT-SCAN][bg] mergeTtWallet called:', { ca, wallet, group_id, group_name, is_bad });
  if (!ca || !wallet) { console.log('[TT-SCAN][bg] abort: missing ca or wallet'); return; }
  const existing = _tokenRegistry.get(ca) || [];
  if (existing.some(s => s.wallet === wallet)) {
    console.log('[TT-SCAN][bg] wallet already in registry for this ca — skip (no dup)');
    return;
  }
  const swap = {
    wallet,
    wallet_name:      '',
    group_id:         group_id || 0,
    group_name:       group_name || '',
    group_color:      group_color || '#EF911A',
    group_ui_section: getUiSection(group_id || 0, !!is_bad),
    is_bad:           !!is_bad,
    marker:           '',
    sol:              0,
    ts:               Date.now(),
    signature:        '',
    from_tt_scan:     true,
  };
  _tokenRegistry.set(ca, [...existing, swap].sort((a, b) => a.ts - b.ts));
  console.log(`[TT-SCAN][bg] merged tracked wallet ${wallet.slice(0, 8)} → ${ca.slice(0, 8)} (group=${group_name || 'Main'}), registry now has ${_tokenRegistry.get(ca).length} swaps`);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'at-tt-wallet-found') return;
  console.log('[TT-SCAN][bg] listener: received at-tt-wallet-found', msg);
  mergeTtWallet(msg.ca, msg.wallet, msg.group_id, msg.group_name, msg.group_color, msg.is_bad);
  scheduleRegistrySave();
  broadcastState();
});

// ── Резолв CA по PA (bonding curve / pool address) из своего же реестра ───────
// (решение диалога) — URL страницы токена (/meme/{addr}) — это PA (bonding_curve
// до миграции, pool_address после), НЕ CA. PA у нас и так лежит в meta.pa для
// каждого токена, который хоть раз встречался через SSE (см. ingestEvent/
// processEvent/processAfEvent — везде pa: tokenData.PA/t.bonding_curve). Значит для
// уже виденных токенов CA резолвится точным совпадением по своим же данным — без
// DOM-скрейпинга и без гадания на форматах внешних API.
function findCaByPa(pa) {
  if (!pa) return null;
  for (const [ca, meta] of _tokenMeta) {
    if (meta?.pa === pa) return ca;
  }
  for (const [ca, meta] of _afTokenMeta) {
    if (meta?.pa === pa) return ca;
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'at-resolve-ca-by-pa') return false;
  const ca = findCaByPa(msg.pool);
  console.log('[TT-SCAN][bg] resolve-ca-by-pa: pool=', msg.pool, '→ ca=', ca);
  sendResponse({ ok: !!ca, ca });
  return false;
});

// ── /wallets/lookup — отдельный listener чтобы иметь sendResponse ─────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'at-lookup') return false;
  (async () => {
    try {
      const resp = await fetch(`${FRESH_API_BASE}/wallets/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: msg.addresses }),
      });
      const data = await resp.json();
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // держим канал открытым для async ответа
});

// ── at-search-token — фолбэк-поиск карточки через API (см. searchTrackerCard) ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'at-search-token') return false;
  console.log('[SEARCH][AT] listener: received at-search-token, query=', msg.query);
  (async () => {
    try {
      const result = await searchTrackerCard(msg.query);
      console.log('[SEARCH][AT] listener: searchTrackerCard result=', JSON.stringify({...result, swaps: result.swaps ? `[${result.swaps.length} items]` : undefined}));
      if (result.ok) {
        scheduleRegistrySave();
        broadcastState(); // сразу пушим найденную карточку в открытый sidebar
        console.log('[SEARCH][AT] listener: scheduleRegistrySave()+broadcastState() called');
      }
      sendResponse(result);
      console.log('[SEARCH][AT] listener: sendResponse() called');
    } catch (e) {
      console.log('[SEARCH][AT] listener: EXCEPTION', e);
      sendResponse({ ok: false, reason: 'error', error: e.message });
    }
  })();
  return true; // держим канал открытым для async ответа
});

chrome.storage.onChanged.addListener((changes) => {
  if (AT_LOG_KEY in changes) _logEnabled = !!changes[AT_LOG_KEY].newValue;
});

// ── Init ───────────────────────────────────────────────────────────────────────
(async () => {
  const r = await chrome.storage.local.get(AT_LOG_KEY);
  _logEnabled = !!r[AT_LOG_KEY];
  await loadGroups();
  await loadRegistry();
  await startSSE();
  _walletsSse.start();
  // Если сайдбар уже открыт пока SW инициализировался — он получил пустой registry.
  // Рассылаем состояние проактивно после завершения init.
  broadcastState();
})();

// ══════════════════════════════════════════════════════════════════════════════
// ██  ANGRY FRESH — интегрирован в AT Service Worker                        ██
// ══════════════════════════════════════════════════════════════════════════════

// ── AF Constants ───────────────────────────────────────────────────────────────
const AF_REGISTRY_KEY  = 'af_registry';
const AF_EVENTS_KEY    = 'af_last_event_id';
const AF_MAX_SIGNALS   = 100; // решение диалога, было 50 — симметрично Tracker (MAX_SIGNALS)
const AF_MAX_TOKENS    = 100; // решение диалога, было 50 — симметрично Tracker (MAX_TOKENS)
const AF_BUY_THRESHOLD = 0.5;
const AF_AGE_MS        = 24 * 3600_000;
const AF_SCAM_AGE_MS   = 1  * 3600_000;
const AF_STALE_MS      = 5  * 60_000;

const AF_LEVEL_LABEL = ['', 'Fresh', 'Clustered', 'Full Cluster', 'Aged 24h+', 'INSIDER'];
const AF_LEVEL_COLOR = ['', '#39FF14', '#7FFF00', '#FFD700', '#FF8C00', '#FF4500'];

// ── AF State ───────────────────────────────────────────────────────────────────
// Решение диалога: _freshMap (address → {cex_name, balance, created_at, cluster_id})
// убран — раньше заполнялся отдельным поллингом /fresh/wallets раз в 60с (см.
// git-историю/CLAUDE.md сервера, раздел "Полный снапшот fresh-кошелька прямо в
// свап-событии"). Сервер теперь кладёт те же поля прямо на каждый свап в
// /sse/events (`wallet_created_at`/`cluster_id`/`wallet_received_sol`/
// `wallet_balance_sol`/`cex_address`) — читаются напрямую из `s`/`trigRaw` в
// processAfEvent() ниже, без локального кэша и без поллинга.
let _afSignals     = [];
let _afRegistry    = new Map(); // ca → swaps[]
let _afTokenMeta   = new Map(); // ca → {name, symbol, image, da, pa, ...}
let _afLastEventId = 0;
let _afSseStatus   = false;

// ── AF Scorer ─────────────────────────────────────────────────────────────────
function _afCardType(swaps) {
  if (swaps.some(s => s.state === 'dev')) return 'fresh_buy';
  return swaps.some(s => (s.ts - s.created_at) >= AF_SCAM_AGE_MS) ? 'fresh_buy' : 'fresh_scam';
}

function _afScoreToken(swaps) {
  if (!swaps?.length) return { level: 0, cardType: 'fresh_buy', allSameCluster: false, hasAged: false, clusterId: null };
  const cardType = _afCardType(swaps);
  const count    = swaps.length;
  if (cardType === 'fresh_scam') return { level: Math.min(count, 5), cardType, allSameCluster: false, hasAged: false, clusterId: null };
  const clusterIds     = swaps.map(s => s.cluster_id).filter(c => c > 0);
  const hasClusters    = clusterIds.length > 0;
  const uniqueClusters = new Set(clusterIds);
  const allSameCluster = clusterIds.length === count && uniqueClusters.size === 1;
  const clusterId      = allSameCluster ? clusterIds[0] : (hasClusters ? [...uniqueClusters][0] : null);
  const maxAge         = Math.max(...swaps.map(s => s.ts - s.created_at));
  const hasAged        = maxAge >= AF_AGE_MS;
  let level;
  if      (count < 2)                    level = 1;
  else if (hasAged && allSameCluster)    level = 5;
  else if (hasAged)                      level = 4;
  else if (allSameCluster)               level = 3;
  else if (hasClusters)                  level = 2;
  else                                   level = 1;
  return { level, cardType, allSameCluster, hasAged, clusterId };
}

// ── AF Registry persistence ────────────────────────────────────────────────────
let _afRegistrySaveTimer = null;
function scheduleAfRegistrySave() {
  clearTimeout(_afRegistrySaveTimer);
  _afRegistrySaveTimer = setTimeout(saveAfRegistry, 2000);
}

async function saveAfRegistry() {
  try {
    const fresh = [..._afRegistry.entries()]
      .map(([ca, swaps]) => ({
        ca, swaps,
        ts: Array.isArray(swaps) ? Math.max(...swaps.map(s => s.ts || 0)) : 0,
      }))
      .filter(({ ts }) => ts > 0)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, AF_MAX_TOKENS);
    const registry  = Object.fromEntries(fresh.map(x => [x.ca, x.swaps]));
    const tokenMeta = {};
    for (const { ca } of fresh) { if (_afTokenMeta.has(ca)) tokenMeta[ca] = _afTokenMeta.get(ca); }
    await chrome.storage.local.set({
      [AF_REGISTRY_KEY]: { registry, tokenMeta },
      [AF_EVENTS_KEY]:   _afLastEventId,
    });
  } catch (e) { log('[AF] saveRegistry error:', e?.message); }
}

async function loadAfRegistry() {
  try {
    const r    = await chrome.storage.local.get([AF_REGISTRY_KEY, AF_EVENTS_KEY]);
    const data = r[AF_REGISTRY_KEY] || {};
    if (data.registry) {
      _afRegistry  = new Map(Object.entries(data.registry));
      _afTokenMeta = new Map(Object.entries(data.tokenMeta || {}));
      // Чистим записи с нулевым ts (битые данные)
      for (const [ca, swaps] of _afRegistry) {
        const ts = Array.isArray(swaps) ? Math.max(...swaps.map(s => s.ts || 0)) : 0;
        if (!ts) { _afRegistry.delete(ca); _afTokenMeta.delete(ca); }
      }
    }
    _afLastEventId = r[AF_EVENTS_KEY] || 0;
    log(`[AF] registry loaded: ${_afRegistry.size} tokens, cursor=${_afLastEventId}`);
  } catch (_) {}
}

// ── AF тихая загрузка исторических событий ───────────────────────────────────
// Формат идентичен SSE payload (enriched): event.payload.token.CA + event.payload.swaps[].
// Raw-формат (/events/latest) больше НЕ используется — там нет token metadata.
function ingestAfEvent(event) {
  const tokenData = event.payload?.token;
  const rawSwaps  = event.payload?.swaps;
  const ca        = tokenData?.CA;

  if (!ca || !rawSwaps?.length) return;

  // Было: запись в несуществующую _afMeta (ReferenceError на каждом событии,
  // из-за strict mode всё ingest-снапшот AF падал молча в catch startAfSSE) —
  // используем реальный _afTokenMeta (Map), как в processAfEvent.
  if (!_afTokenMeta.has(ca)) {
    _afTokenMeta.set(ca, {
      name:                   tokenData.name   || '',
      symbol:                 tokenData.symbol || '',
      image:                  tokenData.image  || null,
      da:                     tokenData.DA     || null,
      pa:                     tokenData.PA     || null,
      dev_buy_sol:            tokenData.dev_buy_sol        ?? null,
      creator_balance_before: tokenData.dev_balance_before ?? null,
    });
  }

  // created_at приходит то в секундах, то в мс — та же нормализация что в AT.
  const nowMs = normalizeTs(event.created_at, Date.now());
  const newSwaps = rawSwaps.map(s => ({
    wallet:       s.user,
    created_at:   normalizeTs(s.wallet_created_at, 0),
    received_sol: Number(s.wallet_received_sol) || 0,
    cluster_id:   s.cluster_id || 0,
    cex_name:     s.cex_name   || '',
    sol:          Number(s.sol_amount),
    ts:           normalizeTs(s.created_at, nowMs),
    state:        s.state || 'cex',
  }));

  const existing = _afRegistry.get(ca) || [];
  const seen = new Set(existing.map(s => s.wallet + '_' + s.ts));
  const toAdd = newSwaps.filter(s => !seen.has(s.wallet + '_' + s.ts));
  if (toAdd.length || !existing.length) {
    _afRegistry.set(ca, [...existing, ...toAdd].sort((a, b) => a.ts - b.ts));
  }
}

// ── AF processEvent ────────────────────────────────────────────────────────────
function processAfEvent(event) {
  const { token: tokenData, swaps: rawSwaps } = event.payload || {};
  if (!tokenData || !rawSwaps?.length) return;
  const ca = tokenData.CA;
  if (!ca) return;

  const meta = {
    name:                   tokenData.name   || '',
    symbol:                 tokenData.symbol || '',
    image:                  tokenData.image  || null,
    da:                     tokenData.DA     || null,
    pa:                     tokenData.PA     || null,
    website:                tokenData.website  || null,
    twitter:                tokenData.twitter  || null,
    telegram:               tokenData.telegram || null,
    dev_buy_sol:            tokenData.dev_buy_sol        ?? null,
    creator_balance_before: tokenData.dev_balance_before ?? null,
  };
  _afTokenMeta.set(ca, meta);

  // created_at/wallet_created_at от сервера — та же история, что и в processEvent()
  // (см. комментарий там): раньше считались из СЫРЫХ значений, без normalizeTs.
  // wallet_created_at участвует в (s.ts - s.created_at) в скорере (_afScoreToken) —
  // если один в мс, а другой в секундах, "hasAged"/allSameCluster считались в разы
  // неверно, а сам свап с ts в 1970-м вечно резался фильтрами по STALE_MS ниже.
  const now = normalizeTs(event.created_at, Date.now());
  // Решение диалога: created_at/cluster_id кошелька раньше добирались из
  // _freshMap (отдельный 60с-поллинг /fresh/wallets) — теперь сервер кладёт их
  // прямо на свап (s.wallet_created_at/s.cluster_id), читаем напрямую, без
  // локального кэша и без риска 60с-race (кошелёк fresh уже после поллинга).
  const registrySwaps = rawSwaps.map(s => ({
    wallet:      s.user,
    created_at:  normalizeTs(s.wallet_created_at, 0),
    cluster_id:  s.cluster_id || 0,
    cex_name:    s.cex_name || '',
    sol:         Number(s.sol_amount),
    received_sol: Number(s.wallet_received_sol) || 0,
    ts:          normalizeTs(s.created_at, now),
    state:       s.state || 'cex',
  }));

  if (_afRegistry.size >= AF_MAX_TOKENS && !_afRegistry.has(ca)) {
    let oldestCa = null, oldestTs = Infinity;
    for (const [c, swaps] of _afRegistry) {
      const t = Array.isArray(swaps) ? Math.max(...swaps.map(s => s.ts || 0)) : 0;
      if (t < oldestTs) { oldestTs = t; oldestCa = c; }
    }
    if (oldestCa) { _afRegistry.delete(oldestCa); _afTokenMeta.delete(oldestCa); }
  }
  _afRegistry.set(ca, registrySwaps);

  const score  = _afScoreToken(registrySwaps);
  const isScam = score.cardType === 'fresh_scam';

  const trigRaw   = rawSwaps.find(s => Number(s.swap_id) === event.swap_id) || rawSwaps[rawSwaps.length - 1];
  const trigEntry = registrySwaps.find(s => s.wallet === trigRaw.user) || registrySwaps[registrySwaps.length - 1];
  // fd/_freshMap.delete() убраны вместе с поллингом — раньше это "гасило"
  // cluster_id/created_at для того же кошелька при ПОВТОРНОМ появлении в
  // истории свапов токена на будущих событиях (rawSwaps — полная история по
  // mint, перестраивается каждый раз). Теперь cluster_id/created_at на каждом
  // свапе — зафиксированный факт с сервера (см. wallet_created_at выше), а не
  // мутируемый кэш, гасить нечего — это не регресс, а следствие того, что
  // данные больше не идут через локальный кэш с ручной инвалидацией.

  const signal = {
    wallet:                 trigRaw.user,
    token:                  ca,
    sol:                    trigEntry.sol,
    ts:                     now,
    cex_name:               trigRaw.cex_name || '',
    cex_address:            trigRaw.cex_address || '',
    cluster_id:             trigRaw.cluster_id  || 0,
    created_at:             Number(trigRaw.wallet_created_at)   || 0,
    received_sol:           Number(trigRaw.wallet_received_sol) || 0,
    balance:                trigRaw.wallet_balance_sol || 0,
    count:                  registrySwaps.length,
    level:                  score.level,
    card_type:              score.cardType,
    source:                 trigRaw.state || 'cex',
    name:                   meta.name,
    symbol:                 meta.symbol,
    image:                  meta.image,
    da:                     meta.da,
    pa:                     meta.pa,
    website:                meta.website,
    twitter:                meta.twitter,
    telegram:               meta.telegram,
    dev_buy_sol:            meta.dev_buy_sol,
    creator_balance_before: meta.creator_balance_before,
  };

  _afSignals.unshift(signal);
  if (_afSignals.length > AF_MAX_SIGNALS) _afSignals.length = AF_MAX_SIGNALS;

  chrome.runtime.sendMessage({ type: 'af-signal', data: signal }).catch(() => {});

  // Relay в MAIN world → af_channel.js → Angry Paint
  const relayData = {
    token:            ca,
    cex_name:         trigRaw.cex_name,
    cluster_id:       score.clusterId,
    count:            registrySwaps.length,
    sol:              trigEntry.sol,
    level:            score.level,
    level_label:      AF_LEVEL_LABEL[score.level] || 'Fresh',
    level_color:      isScam ? '#FF4500' : (AF_LEVEL_COLOR[score.level] || '#39FF14'),
    card_type:        score.cardType,
    all_same_cluster: score.allSameCluster,
    has_aged:         score.hasAged,
    source:           trigRaw.state || 'cex',
  };
  chrome.tabs.query({ url: ['https://axiom.trade/*', 'http://axiom.trade/*'] }, (tabs) => {
    for (const tab of tabs || []) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'af-signal-relay', data: relayData }).catch(() => {});
    }
  });
}

// ── AF Feed enrichment ─────────────────────────────────────────────────────────
function onAfFeedTokenUpdate(data) {
  const t = data?.token;
  if (!t || !t.mint) return;
  const ca = t.mint;
  if (!_afTokenMeta.has(ca) && !_afRegistry.has(ca)) return;
  const prev   = _afTokenMeta.get(ca) || {};
  const merged = {
    name:                   prev.name   || t.name   || '',
    symbol:                 prev.symbol || t.symbol || '',
    image:                  prev.image  || t.image  || null,
    da:                     prev.da     || t.creator       || null,
    pa:                     prev.pa     || t.bonding_curve || null,
    website:                prev.website  || t.website  || null,
    twitter:                prev.twitter  || t.twitter  || null,
    telegram:               prev.telegram || t.telegram || null,
    dev_buy_sol:            prev.dev_buy_sol            ?? t.dev_buy_sol        ?? null,
    creator_balance_before: prev.creator_balance_before ?? t.dev_balance_before ?? null,
  };
  _afTokenMeta.set(ca, merged);
  scheduleAfRegistrySave();
  chrome.runtime.sendMessage({ type: 'af-token-meta-update', ca, meta: merged }).catch(() => {});
}

// ── AF SSE ─────────────────────────────────────────────────────────────────────
function onAfSseUpdate(data) {
  const events = data?.events || [];
  if (!events.length) return;
  _afLastEventId = data.last_event_id || _afLastEventId;
  chrome.storage.local.set({ [AF_EVENTS_KEY]: _afLastEventId }).catch(() => {});
  for (const event of events) {
    if (dedupSeen(`af:${event.event_id}`)) continue;
    processAfEvent(event);
  }
  scheduleAfRegistrySave();
}

const _afSse = AngrySSE.create({
  url:          async () => `${await getApiBase()}/sse/events?since=${_afLastEventId}`,
  events:       { update: onAfSseUpdate },
  onStatus:     (connected) => {
    _afSseStatus = connected;
    chrome.runtime.sendMessage({ type: 'af-sse-status', connected }).catch(() => {});
  },
  onParseError: (err) => log('[AF] SSE parse error:', err.message),
  reconnectMs:  SSE_RECONNECT_MS,
});

const _feedSse = AngrySSE.create({
  url:          async () => `${await getApiBase()}/sse/feed`,
  events:       { token_update: onAfFeedTokenUpdate },
  onParseError: (err) => log('[AF] feed SSE parse error:', err.message),
  reconnectMs:  SSE_RECONNECT_MS,
});

async function startAfSSE() {
  try {
    const base = await getApiBase();
    // Без since — сервер сам отдаёт последний час, enriched, тот же формат что SSE.
    const res  = await fetch(`${base}/events`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data   = await res.json(); // { events: [...enriched], last_event_id } — как SSE
      const events = data?.events || [];
      for (const event of events) {
        if (dedupSeen(`af:${event.event_id}`)) continue;
        ingestAfEvent(event);
      }
      if (events.length) scheduleAfRegistrySave();
      _afLastEventId = data.last_event_id || _afLastEventId;
      chrome.storage.local.set({ [AF_EVENTS_KEY]: _afLastEventId }).catch(() => {});
      log(`[AF] snapshot: ${events.length} events, cursor=${_afLastEventId}`);
    }
  } catch (e) { log('[AF] snapshot error:', e.message); }
  // SSE открывается ПОСЛЕ snapshot, с курсором из его ответа.
  _afSse.start();
  _feedSse.start();
}

// ── AF broadcastState ──────────────────────────────────────────────────────────
function broadcastAfState() {
  const fresh = [..._afRegistry.entries()]
    .map(([ca, swaps]) => ({
      ca, swaps,
      ts: Array.isArray(swaps) ? Math.max(...swaps.map(s => s.ts || 0)) : 0,
    }))
    .filter(({ ts }) => ts > 0)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, AF_MAX_SIGNALS);
  const registry  = Object.fromEntries(fresh.map(x => [x.ca, x.swaps]));
  const tokenMeta = {};
  const scores    = {};
  for (const { ca } of fresh) {
    if (_afTokenMeta.has(ca)) tokenMeta[ca] = _afTokenMeta.get(ca);
    scores[ca] = _afScoreToken(_afRegistry.get(ca) || []);
  }
  chrome.runtime.sendMessage({
    type: 'af-state',
    signals:   _afSignals.slice(0, AF_MAX_SIGNALS),
    registry,
    tokenMeta,
    scores,
  }).catch(() => {});
}

// ── AF: поиск карточки — только live-реестр, без внешнего API ─────────────────
// У сервера нет готового fresh-эквивалента /token/{mint}/tracker-event (см.
// API-FEED.md §2.2 и разбор в CLAUDE.md) — точного контракта полей для сырых
// /token/{mint}/swaps нет, гадать не стали. Но проверить СОБСТВЕННЫЙ живой
// _afRegistry (тот самый источник, из которого paint красит af-сигналы) —
// дёшево и не требует контракта, поэтому делаем хотя бы это.
function findInLiveAfRegistry(query) {
  const q = query.trim();
  console.log('[SEARCH][AF] findInLiveAfRegistry: q=', JSON.stringify(q), 'registrySize=', _afRegistry.size);
  if (!q) return null;
  if (_afRegistry.has(q)) {
    const swaps = _afRegistry.get(q) || [];
    console.log('[SEARCH][AF] findInLiveAfRegistry: EXACT CA match, swaps=', swaps.length,
      'maxTs=', swaps.length ? Math.max(...swaps.map(s => s.ts || 0)) : null, 'now=', Date.now());
    return q;
  }
  const qLower = q.toLowerCase();
  for (const [ca, swaps] of _afRegistry) {
    if (!swaps?.length) continue;
    if (ca.toLowerCase() === qLower) { console.log('[SEARCH][AF] case-insensitive CA match', ca); return ca; }
    const m = _afTokenMeta.get(ca) || {};
    if ((m.symbol || '').toLowerCase().includes(qLower) ||
        (m.name   || '').toLowerCase().includes(qLower)) { console.log('[SEARCH][AF] symbol/name match', ca); return ca; }
  }
  console.log('[SEARCH][AF] findInLiveAfRegistry: NOT FOUND');
  return null;
}

function searchFreshCard(query) {
  const q = (query || '').trim();
  console.log('[SEARCH][AF] === searchFreshCard START ===', JSON.stringify(q));
  if (!q) return { ok: false, reason: 'empty' };
  const ca = findInLiveAfRegistry(q);
  if (!ca) { console.log('[SEARCH][AF] === RESULT: not_found ==='); return { ok: false, reason: 'not_found' }; }
  const swaps = _afRegistry.get(ca) || [];
  console.log('[SEARCH][AF] FOUND. ca=', ca, 'swaps.length=', swaps.length, 'sample=', JSON.stringify(swaps[0]));
  return {
    ok: true, mint: ca,
    swaps,
    meta:  _afTokenMeta.get(ca) || {},
    score: _afScoreToken(swaps),
    swaps_count: swaps.length,
    symbol: _afTokenMeta.get(ca)?.symbol || '',
    source: 'registry',
  };
}

// ── Extend existing message handler with AF messages ──────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.type) return;
  if (msg.type === 'af-get-state') {
    broadcastAfState();
  }
  if (msg.type === 'af-get-sse-status') {
    if (_afSse.isActive() && !_afSse.isOpen()) {
      chrome.storage.local.get(AF_EVENTS_KEY).then(r => {
        if (r[AF_EVENTS_KEY]) _afLastEventId = r[AF_EVENTS_KEY];
        _afSse.reconnect();
      }).catch(() => _afSse.reconnect());
    }
    chrome.runtime.sendMessage({ type: 'af-sse-status', connected: _afSse.isOpen() }).catch(() => {});
  }
});

// ── af-search-token — отдельный listener чтобы иметь sendResponse ─────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'af-search-token') return false;
  console.log('[SEARCH][AF] listener: received af-search-token, query=', msg.query);
  try {
    const result = searchFreshCard(msg.query);
    console.log('[SEARCH][AF] listener: result=', JSON.stringify({...result, swaps: result.swaps ? `[${result.swaps.length} items]` : undefined}));
    if (result.ok) {
      broadcastAfState(); // данные уже в _afRegistry — просто пушим sidebar'у
      console.log('[SEARCH][AF] listener: broadcastAfState() called');
    }
    sendResponse(result);
    console.log('[SEARCH][AF] listener: sendResponse() called');
  } catch (e) {
    console.log('[SEARCH][AF] listener: EXCEPTION', e);
    sendResponse({ ok: false, reason: 'error', error: e.message });
  }
  return true;
});


// ── AF Init ────────────────────────────────────────────────────────────────────
(async () => {
  await loadAfRegistry();
  await startAfSSE();
  broadcastAfState();
})();
