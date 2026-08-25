// Докинг-панель GMGN Watchlist. Архитектура и docking-паттерн взяты 1:1 из
// соседнего расширения экосистемы (GMGN Pons Sniper): iframe с sidebar.html,
// сдвиг #__next > div[data-rk] через inline margin-right, координация
// видимости панелей МЕЖДУ расширениями через общий BroadcastChannel
// '__gmgn_panel__' (см. их content.js — тот же канал, свой source-id).
'use strict';

const GW_EXT_ID      = 'gmgn-watchlist'; // свой ID в канале __gmgn_panel__
const GW_PANEL_ID     = 'gw-panel';
const GW_STORAGE_KEY  = 'gw_panel_open';
const GW_SIDEBAR_W    = 560; // как у Pons Sniper (PS_SIDEBAR_W) — единый размер в экосистеме

let _gwPanelOpen = false;

// ── Межрасширенческий канал закрытия панелей (общий с Pons Sniper и т.п.) ──
let _gwPanelChannel = null;
try {
  _gwPanelChannel = new BroadcastChannel('__gmgn_panel__');
  _gwPanelChannel.onmessage = (ev) => {
    const msg = ev?.data;
    if (msg && msg.source !== GW_EXT_ID && msg.type === 'open' && _gwPanelOpen) {
      gwClosePanel({ dueToOther: true });
    }
  };
} catch (e) {
  // BroadcastChannel недоступен — межрасширенческая синхронизация панелей
  // просто не работает, без неё расширение всё равно полностью
  // функционально (единственный эффект — свои панели не закрываются
  // автоматически при открытии чужой).
}

// Корневой контейнер приложения gmgn.ai — тот же селектор, что у соседних
// расширений экосистемы (RainbowKit wrapper).
function gwFindAppRoot() {
  return document.querySelector('#__next > div[data-rk]')
      || document.querySelector('div[data-rk]')
      || null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Сдвиг контента (margin-right на корне приложения) — история бага.
//
// Попытка 1 (не сработала): применить margin один раз при открытии, если
// не вышло — подождать через MutationObserver первого появления root и
// применить один раз тогда. НЕ ПОМОГЛО: судя по всему React на gmgn.ai
// пересобирает div[data-rk] несколько раз за время жизни страницы
// (хайдрация/ре-рендеры), и наш margin теряется на очередной пересборке
// уже ПОСЛЕ того как мы его применили — одноразовое применение просто не
// переживает следующий ре-рендер обёртки.
//
// Попытка 2 (эта версия), два независимых слоя защиты:
//   1) Авто-восстановление панели из storage при загрузке страницы
//      ОТЛОЖЕНО до window 'load' (не document_start) — меньше шанс попасть
//      в окно нестабильного DOM в принципе. До этого момента панель просто
//      не разворачивается (не visible, не сдвигает контент) — валидное
//      состояние "убрана", а не "открыта но внахлёст".
//   2) ПОСТОЯННЫЙ самовосстанавливающийся MutationObserver — не
//      одноразовый: пока панель считается открытой (_gwPanelOpen), на
//      КАЖДУЮ мутацию DOM проверяет текущий margin-right корня и
//      досдвигает его, если он почему-то не тот (в т.ч. после пересборки
//      обёртки). Дешёвая проверка (querySelector + сравнение строки),
//      держать его живым постоянно не страшно.
// ══════════════════════════════════════════════════════════════════════════════

function gwApplyRootMarginIfNeeded() {
  if (!_gwPanelOpen) return;
  const root = gwFindAppRoot();
  if (!root) return;
  const target = GW_SIDEBAR_W + 'px';
  if (root.style.marginRight === target) return; // уже применено, трогать не надо
  root.style.transition = 'margin-right 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
  root.style.marginRight = target;
}

const _gwMarginObserver = new MutationObserver(() => {
  gwApplyRootMarginIfNeeded();
});
_gwMarginObserver.observe(document.documentElement, { childList: true, subtree: true });

// Панель имеет смысл на двух типах страниц: странице токена (там живёт
// wallet_scanner.js — сканирование Holders/Traders/Activity, инфо о
// токене) и странице /follow (там живёт tracked_wallet_scanner.js —
// список отслеживаемых кошельков, отписка пачкой). На любой другой
// странице gmgn.ai (лента, портфель, адрес кошелька и т.п.) обе секции
// сайдбара бесполезны — панель должна закрываться сама.
const GW_TOKEN_PAGE_RE = /^\/(robinhood|bsc|base|eth|arbitrum)\/token\//;

function gwIsRelevantPage() {
  return GW_TOKEN_PAGE_RE.test(location.pathname)
      || /^\/follow(\/|$)/.test(location.pathname);
}

function gwInitPanel() {
  if (document.getElementById(GW_PANEL_ID)) return;

  const style = document.createElement('style');
  style.textContent = `
    #${GW_PANEL_ID} {
      position: fixed;
      top: 0;
      right: 0;
      width: ${GW_SIDEBAR_W}px;
      height: 100vh;
      z-index: 2147483647;
      border-left: 2px solid #ffffff;
      transform: translateX(100%);
      transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }
    #${GW_PANEL_ID}.open {
      transform: translateX(0);
    }
    #${GW_PANEL_ID} iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #121212;
    }
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement('div');
  panel.id = GW_PANEL_ID;

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('sidebar.html');
  // Панель — cross-origin iframe (chrome-extension:// внутри gmgn.ai).
  // Без явного allow браузер режет в нём navigator.clipboard.writeText
  // (Permissions Policy наследуется от родителя только для same-origin),
  // из-за чего клик 'скопировать адрес' и 'Копировать' в экспорте молча
  // ничего не делали.
  iframe.setAttribute('allow', 'clipboard-write');
  panel.appendChild(iframe);

  document.body.appendChild(panel);

  // Горячая клавиша переключения панели — теперь через chrome.commands
  // (background.js), не хардкод здесь: пользователь может сменить её на
  // chrome://extensions/shortcuts. Escape — стандартный жест закрытия,
  // его оставляем как есть (chrome.commands не подходит для одиночных
  // клавиш без модификатора).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _gwPanelOpen) gwClosePanel();
  });

  // Авто-восстановление ("была открыта в прошлый раз — открыть снова")
  // отложено до полной загрузки страницы (см. блок ниже, gwRestoreOpenState
  // вызывается по window 'load') — здесь только создаём структуру панели,
  // саму её НЕ открываем.
}

function gwRestoreOpenState() {
  chrome.storage.local.get(GW_STORAGE_KEY, (r) => {
    // Не восстанавливаем "была открыта" на не-релевантной странице
    // (например полная перезагрузка произошла уже после ухода со страницы
    // токена/трекинга) — иначе панель откроется там, где ей не место.
    if (r[GW_STORAGE_KEY] && gwIsRelevantPage()) gwOpenPanel();
  });
}

function gwOpenPanel() {
  _gwPanelOpen = true;
  document.getElementById(GW_PANEL_ID)?.classList.add('open');
  gwApplyRootMarginIfNeeded();
  document.documentElement.style.overflowX = 'hidden';

  chrome.storage.local.set({ [GW_STORAGE_KEY]: true });

  // Сигнал остальным расширениям экосистемы — закрыть свои панели.
  try { _gwPanelChannel?.postMessage({ source: GW_EXT_ID, type: 'open' }); } catch (_) {}
}

// dueToOther=true — закрылись потому что открылась ЧУЖАЯ панель. Margin/
// overflow не трогаем — их уже корректно выставило то расширение, которое
// только что открылось.
function gwClosePanel(opts) {
  _gwPanelOpen = false;
  document.getElementById(GW_PANEL_ID)?.classList.remove('open');

  if (!opts?.dueToOther) {
    const root = gwFindAppRoot();
    if (root) root.style.marginRight = '';
    document.documentElement.style.overflowX = '';
  }

  chrome.storage.local.set({ [GW_STORAGE_KEY]: false });
}

function gwTogglePanel() {
  if (_gwPanelOpen) gwClosePanel();
  else gwOpenPanel();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'gw-toggle-panel') {
    if (!document.getElementById(GW_PANEL_ID)) gwInitPanel();
    gwTogglePanel();
  }
});

function gwInitAndRestore() {
  gwInitPanel();
  if (document.readyState === 'complete') {
    gwRestoreOpenState();
  } else {
    window.addEventListener('load', gwRestoreOpenState, { once: true });
  }
}

if (document.body) {
  gwInitAndRestore();
} else {
  document.addEventListener('DOMContentLoaded', gwInitAndRestore);
}

// gmgn.ai — SPA: уход со страницы токена (клик по другому разделу в шапке,
// переход по ссылке внутри приложения) не перезагружает страницу, обычный
// 'popstate'/навигационные события тут не срабатывают надёжно — следим за
// location.href поллингом, тот же паттерн, что в wallet_scanner.js.
// Через gwClosePanel() (не какой-то отдельный "закрыть по-тихому") — она
// уже сама пишет gw_panel_open:false, поэтому при возврате на токен-
// страницу панель НЕ восстановится автоматически, только по иконке/шорткату.
let _gwLastUrl = location.href;
setInterval(() => {
  const url = location.href;
  if (url === _gwLastUrl) return;
  _gwLastUrl = url;
  if (_gwPanelOpen && !gwIsRelevantPage()) {
    gwClosePanel();
  }
}, 500);
