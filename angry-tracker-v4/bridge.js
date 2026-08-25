// Angry Tracker — Bridge (ISOLATED world)
// Инжект sidebar iframe + toggle по клику на иконку
'use strict';

// ── Context guard ─────────────────────────────────────────────────────────────
function ctxAlive() {
  try { return !!chrome?.runtime?.id; } catch (_) { return false; }
}

function safeStorageSet(obj) {
  if (!ctxAlive()) return;
  try { chrome.storage.local.set(obj).catch(() => {}); } catch (_) {}
}

function safeStorageGet(key) {
  if (!ctxAlive()) return Promise.resolve({});
  try { return chrome.storage.local.get(key).catch(() => ({})); } catch (_) { return Promise.resolve({}); }
}

// ── Storage relay: MAIN world читает storage через bridge ─────────────────────
document.addEventListener('__at_storage_get__', async (e) => {
  const { reqId, key } = e.detail || {};
  if (!reqId) return;
  try {
    const result = await safeStorageGet(key);
    document.dispatchEvent(new CustomEvent('__at_storage_result__', {
      detail: { reqId, result },
    }));
  } catch (_) {
    document.dispatchEvent(new CustomEvent('__at_storage_result__', {
      detail: { reqId, result: {} },
    }));
  }
});

// ── New signal relay: sidebar → MAIN overlay ──────────────────────────────────
// Toggle-листенер регистрируем БЕЗУСЛОВНО (как в AW). При переинжекте content-script
// после reload расширения chrome.runtime.id может быть ещё не готов в момент раннего
// ctxAlive() — тогда листенер не регистрировался и сайдбар не открывался до F5.
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'at-signal-relay') {
      document.dispatchEvent(new CustomEvent('__at_new_signal__', {
        detail: msg.data,
      }));
    }
    // Fresh relay → af_channel.js → Angry Paint
    if (msg?.type === 'af-signal-relay') {
      document.dispatchEvent(new CustomEvent('__af_new_signal__', {
        detail: msg.data,
      }));
    }
    if (msg?.type === 'at-toggle-panel') {
      if (!document.getElementById(AT_PANEL_ID)) initPanel();
      togglePanel();
    }
    // Toast-фидбек от background (успех блеклиста или блокировка неприкосаемого)
    if (msg?.type === 'at-bl-toast') {
      document.dispatchEvent(new CustomEvent('__at_bl_toast__', {
        detail: { text: msg.text },
      }));
    }
  });
  console.log('[AT][bridge] toggle listener attached (ctx ' + (ctxAlive() ? 'alive' : 'dead') + ')');
} catch (e) { console.warn('[AT][bridge] toggle listener FAILED:', e?.message); }

// ── Init: восстанавливаем claims из storage при загрузке (нужен живой контекст) ──
if (ctxAlive()) {
  try {
    (async () => {
      const r = await safeStorageGet(['at_registry', 'at_groups_cache', 'at_slots_order']);

      // Кэш групп для ui_section
      const groupsCache = r['at_groups_cache'] || [];
      const slotsOrder  = r['at_slots_order']  || [];
      const groupsById  = {};
      groupsCache.forEach(g => { groupsById[g.group_id] = g; });
      if (!groupsById[0]) groupsById[0] = { group_id: 0, name: 'Main', text_bg_color: '#EF911A', ui_section: 0 };

      // Читаем новый формат реестра
      const stored  = r['at_registry'] || {};
      const registry = stored.registry ? stored.registry : {};

      for (const [ca, swaps] of Object.entries(registry)) {
        if (!Array.isArray(swaps) || !swaps.length) continue;
        const s       = swaps[0]; // самый свежий свап
        const groupId = s.group_id || 0;
        const group   = groupsById[groupId];
        const uiSec   = s.group_ui_section ?? group?.ui_section ?? (s.is_bad ? 99 : 0);
        const slotIdx = uiSec === 1 ? slotsOrder.indexOf(groupId) : -1;

        document.dispatchEvent(new CustomEvent('__at_new_signal__', {
          detail: {
            token:            ca,
            group_id:         groupId,
            group_name:       s.group_name  || group?.name          || 'Main',
            group_color:      s.group_color || group?.text_bg_color || '#EF911A',
            group_ui_section: uiSec,
            group_slot_idx:   slotIdx,
            marker:           s.marker || null,
          },
        }));
      }
    })();
  } catch (_) {}
}

// ── /wallets/lookup relay: MAIN world → background → MAIN world ───────────────
document.addEventListener('__at_lookup_req__', (e) => {
  const { addresses } = e.detail || {};
  if (!addresses?.length || !ctxAlive()) return;
  try {
    chrome.runtime.sendMessage({ type: 'at-lookup', addresses }, (response) => {
      if (chrome.runtime.lastError) {
        document.dispatchEvent(new CustomEvent('__at_lookup_res__', {
          detail: { ok: false, error: chrome.runtime.lastError.message },
        }));
        return;
      }
      document.dispatchEvent(new CustomEvent('__at_lookup_res__', { detail: response }));
    });
  } catch (_) {}
});

// ── Blacklist action relay: MAIN world → runtime ──────────────────────────────
document.addEventListener('__at_bl_action__', (e) => {
  const { address, action } = e.detail || {};
  if (!address || !action) return;
  if (!ctxAlive()) return;
  try {
    chrome.runtime.sendMessage({ type: 'at-bl-action', address, action }).catch(() => {});
  } catch (_) {}
});

// ── Резолв CA по PA (bonding curve/pool из URL) — MAIN world → background ─────
document.addEventListener('__at_resolve_ca_by_pa__', (e) => {
  const { pool } = e.detail || {};
  if (!pool || !ctxAlive()) return;
  try {
    chrome.runtime.sendMessage({ type: 'at-resolve-ca-by-pa', pool }, (response) => {
      if (chrome.runtime.lastError) {
        document.dispatchEvent(new CustomEvent('__at_resolve_ca_by_pa_res__', {
          detail: { ok: false, pool },
        }));
        return;
      }
      document.dispatchEvent(new CustomEvent('__at_resolve_ca_by_pa_res__', {
        detail: { ...response, pool },
      }));
    });
  } catch (_) {}
});

// ── Top Traders/Holders scan → мгновенная дозапись трекнутого кошелька ────────
// (решение диалога) — meme_scanner нашёл в Top Traders/Holders текущего токена
// кошелёк, который лукап пометил как tracker — пишем сразу в background, не
// дожидаясь SSE/API.
document.addEventListener('__at_tt_wallet_found__', (e) => {
  const detail = e.detail || {};
  console.log('[TT-SCAN][bridge] relay __at_tt_wallet_found__ →', detail);
  if (!detail.ca || !detail.wallet || !ctxAlive()) {
    console.log('[TT-SCAN][bridge] abort: missing ca/wallet or dead ctx');
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: 'at-tt-wallet-found', ...detail }).catch(() => {});
  } catch (_) {}
});

// ── Relay storage changes → MAIN world (blacklist updates) ────────────────────
if (ctxAlive()) {
  try {
    chrome.storage.onChanged.addListener((changes) => {
      if ('at_wallet_bad_cache' in changes) {
        const list = changes['at_wallet_bad_cache'].newValue || [];
        document.dispatchEvent(new CustomEvent('__at_bl_updated__', {
          detail: { list },
        }));
      }
    });
  } catch (_) {}
}

const AT_PANEL_ID    = 'at-panel';
const AT_STORAGE_KEY = 'at_panel_open';
const AT_SIDEBAR_W   = 815;

let _panelOpen = false;

// ── Общий канал синхронизации с AW ───────────────────────────────────────────
const _panelChannel = new BroadcastChannel('aw_panel_control');

_panelChannel.addEventListener('message', (e) => {
  if (e.data?.type === 'close' && e.data?.sender !== 'at') {
    closePanel();
  }
});

function initPanel() {
  if (document.getElementById(AT_PANEL_ID)) return;
  if (!ctxAlive()) return;

  const style = document.createElement('style');
  style.textContent = `
    html {
      transition: margin-right 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
    }
    html.at-sidebar-open {
      margin-right: ${AT_SIDEBAR_W}px !important;
      overflow-x: hidden !important;
    }
    #${AT_PANEL_ID} {
      position: fixed;
      top: 0;
      right: 0;
      width: ${AT_SIDEBAR_W}px;
      height: 100vh;
      z-index: 2147483647;
      border-left: 1px solid rgba(239,145,26,0.45);
      box-shadow: -2px 0 18px rgba(239,145,26,0.20), -6px 0 40px rgba(239,145,26,0.10);
      transform: translateX(100%);
      transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }
    #${AT_PANEL_ID}.open {
      transform: translateX(0);
    }
    #${AT_PANEL_ID} iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #10151f;
    }
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement('div');
  panel.id = AT_PANEL_ID;

  let iframeSrc;
  try { iframeSrc = chrome.runtime.getURL('sidebar.html'); } catch (_) { return; }

  const iframe = document.createElement('iframe');
  iframe.src = iframeSrc;
  panel.appendChild(iframe);

  document.body.appendChild(panel);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _panelOpen) closePanel();
  });

  safeStorageGet(AT_STORAGE_KEY).then(r => {
    if (r[AT_STORAGE_KEY]) openPanel();
  });
}

function openPanel() {
  _panelChannel.postMessage({ type: 'close', sender: 'at' });
  _panelOpen = true;
  document.getElementById(AT_PANEL_ID)?.classList.add('open');
  document.documentElement.classList.add('at-sidebar-open');
  safeStorageSet({ [AT_STORAGE_KEY]: true });
}

function closePanel() {
  _panelOpen = false;
  document.getElementById(AT_PANEL_ID)?.classList.remove('open');
  document.documentElement.classList.remove('at-sidebar-open');
  safeStorageSet({ [AT_STORAGE_KEY]: false });
}

function togglePanel() {
  if (_panelOpen) closePanel();
  else openPanel();
}

if (document.body) {
  initPanel();
} else {
  document.addEventListener('DOMContentLoaded', () => initPanel());
}
