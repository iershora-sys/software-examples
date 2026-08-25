// Axiom BotAPI v2.0 — ISOLATED world
// Работа с сервером trader.bot.nu/solana: /check, /addwallets, /delwallet, /stats, /funding, /trace
'use strict';

// ── API Logger (ISOLATED world) ──────────────────────────────────────────────
let _apiLogEnabled = false;
chrome.storage.local.get('at_console_log_enabled').then(r => { _apiLogEnabled = !!r.at_console_log_enabled; }).catch(() => {});
chrome.storage.onChanged.addListener((changes) => {
  if ('at_console_log_enabled' in changes) _apiLogEnabled = !!changes.at_console_log_enabled.newValue;
});
let _apiReqId = 0;
const apiLog = (id, dir, ...args) => {
  if (_apiLogEnabled) console.log('[AW][api][' + id + ']', dir, ...args);
};

const BOT_BASE_URL    = 'https://trader.bot.nu/solana';
const BOT_ADD_URL     = BOT_BASE_URL + '/addwallets';
const BOT_DEL_URL     = BOT_BASE_URL + '/delwallet';
const BOT_FUNDING_URL = BOT_BASE_URL + '/funding';
const BOT_TRACE_URL   = BOT_BASE_URL + '/trace';
const BOT_HEADERS     = { 'Content-Type': 'application/json' };

// ── Funding cache (chrome.storage.local) ────────────────────────────────────
const CACHE_PREFIX = 'axl_fa_';
const CACHE_TTL_MS = 96 * 60 * 60 * 1000; // 96h

const fundingInflight = new Map(); // DA → Promise

async function cacheLoad(da) {
  try {
    const key  = CACHE_PREFIX + da;
    const data = await chrome.storage.local.get(key);
    const entry = data[key];
    if (!entry) return null;
    if (Date.now() - entry.savedAt > CACHE_TTL_MS) {
      chrome.storage.local.remove(key);
      return null;
    }
    return { ...entry.result, _fromCache: true, _savedAt: entry.savedAt };
  } catch (_) { return null; }
}

async function cacheSave(da, result) {
  try {
    const savedAt = Date.now();
    await chrome.storage.local.set({
      [CACHE_PREFIX + da]: { result, savedAt },
    });
  } catch (_) {}
}

// ── Общий логируемый fetch ───────────────────────────────────────────────────
async function apiFetch(label, url, options = {}) {
  if (typeof flashApiLed === 'function') flashApiLed();
  const id      = ++_apiReqId;
  const reqBody = options.body || null;
  apiLog(id, '→', label, ...(reqBody ? ['| req:', reqBody] : []));
  const t0  = Date.now();
  const res = await fetch(url, options);
  const raw = await res.text();
  const ms  = Date.now() - t0;
  apiLog(id, '←', label, '| status:', res.status, '| ms:', ms, '| res:', raw);
  let data;
  try { data = JSON.parse(raw); } catch (_) { throw new Error('Invalid JSON: ' + raw.slice(0, 100)); }
  if (!res.ok || data.status !== 'OK') throw new Error(data.error || `HTTP ${res.status}`);
  return data.result;
}

// ── POST /addwallets — батч-добавление кошельков ────────────────────────────
async function apiAddWallets(entries, db) {
  const wallets = entries.map(e => typeof e === 'string' ? { address: e } : e);
  return apiFetch('/addwallets', BOT_ADD_URL, {
    method: 'POST', headers: BOT_HEADERS,
    body: JSON.stringify({ database: db, wallets }),
  });
}

// ── POST /delwallet — удаление кошелька ─────────────────────────────────────
async function apiDelWallet(address, db) {
  return apiFetch('/delwallet', BOT_DEL_URL, {
    method: 'POST', headers: BOT_HEADERS,
    body: JSON.stringify({ database: db, address }),
  });
}

// ── POST /delwallet_lock — перенести в группу "Неприкосаемый" (id=98) ──────────
const BOT_LOCK_URL = BOT_BASE_URL + '/delwallet_lock';
async function apiDelAndLockWallet(address, db) {
  return apiFetch('/delwallet_lock', BOT_LOCK_URL, {
    method: 'POST', headers: BOT_HEADERS,
    body: JSON.stringify({ database: db, address }),
  });
}

// ── POST /addblacklist — добавить адреса в блеклист ──────────────────────────
async function apiAddBlacklist(addresses, purge = false) {
  const entries = addresses.map(a => typeof a === 'string' ? { address: a } : a);
  return apiFetch('/addblacklist', BOT_BASE_URL + '/addblacklist', {
    method: 'POST', headers: BOT_HEADERS,
    body: JSON.stringify({ addresses: entries, purge }),
  });
}

// ── POST /funding — funding lookup (с кэшем) ───────────────────────────────
// /funding не поддерживает database — таблица funding единая
async function apiFunding(da) {
  // 1. Кэш chrome.storage.local
  const cached = await cacheLoad(da);
  if (cached) {
    apiLog('cache', '⚡', '/funding | DA:', da, '| funder:', cached.funder || 'none');
    return cached;
  }

  // 2. Дедупликация in-flight
  if (fundingInflight.has(da)) {
    apiLog('inflight', '⏳', '/funding | DA:', da);
    return fundingInflight.get(da);
  }

  const promise = (async () => {
    try {
      const result = await apiFetch('/funding', BOT_FUNDING_URL, {
        method: 'POST', headers: BOT_HEADERS,
        body: JSON.stringify({ address: da }),
      });
      if (result.funder) cacheSave(da, result);
      return result;
    } finally {
      fundingInflight.delete(da);
    }
  })();

  fundingInflight.set(da, promise);
  return promise;
}

// ── POST /trace — цепочка родителей ─────────────────────────────────────────
async function apiTrace(address, db) {
  return apiFetch('/trace', BOT_TRACE_URL, {
    method: 'POST',
    headers: BOT_HEADERS,
    body: JSON.stringify({ database: db, address }),
  });
}


// ── GET /recent — список кошельков из базы ───────────────────────────────────
async function apiRecent(database, opts = {}) {
  const { since = 0, before = null, limit = 200, group_id, good } = opts;
  let url = `${BOT_BASE_URL}/recent?database=${encodeURIComponent(database)}&limit=${limit}`;
  if (before != null) url += `&before=${before}`;
  else url += `&since=${since}`;
  if (group_id != null) url += `&group_id=${group_id}`;
  if (good != null) url += `&good=${good}`;
  return apiFetch('/recent', url);
}

// ── GET /children — прямые дочерние кошельки ────────────────────────────────
async function apiChildren(parent, database, limit = 200) {
  const url = `${BOT_BASE_URL}/children?database=${encodeURIComponent(database)}&parent=${encodeURIComponent(parent)}&limit=${limit}`;
  return apiFetch('/children', url);
}

// ── POST /delwallet-tree ──────────────────────────────────────────────────────
async function apiDelWalletTree(address, db) {
  return apiFetch('/delwallet-tree', BOT_BASE_URL + '/delwallet-tree', {
    method: 'POST', headers: BOT_HEADERS,
    body: JSON.stringify({ database: db, address }),
  });
}
