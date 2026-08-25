// Если группы ещё не перехвачены (пусто/не загружено) — открываем
// /follow?chain=robinhood в новой вкладке, чтобы GMGN сам вызвал
// business_group_multi_chain/list и наш inject.js его перехватил, без
// участия пользователя. Открываем именно активной вкладкой (не в фоне) —
// если пользователь не залогинен, ему нужно это увидеть и залогиниться,
// иначе бутстрап всё равно ничего не поймает.
const GW_BOOTSTRAP_COOLDOWN_MS = 5 * 60 * 1000; // не долбим вкладками чаще раза в 5 минут (только в фоновом режиме, не force)

// force=true — вызвано явно из follow.js, когда refreshGroups() в текущей
// вкладке вернул пусто (например протухли authHeaders). В этом режиме
// игнорируем и "уже loaded" (кэш мог быть стухшим), и кулдаун — юзер прямо
// сейчас ждёт результата.
async function gwEnsureGroupsBootstrap({ force = false } = {}) {
  try {
    const res = await chrome.storage.local.get(['gmgn', 'gw_bootstrap_last_at']);
    const state = res.gmgn;

    if (!force) {
      if (state && state.loaded && Array.isArray(state.groups) && state.groups.length) {
        return; // группы уже есть — ничего делать не надо
      }
      const lastAt = res.gw_bootstrap_last_at || 0;
      if (Date.now() - lastAt < GW_BOOTSTRAP_COOLDOWN_MS) return; // недавно уже пытались
    }

    // Не плодим вторую вкладку, если /follow уже где-то открыт — просто
    // фокусируем её (в force-режиме это особенно полезно: юзер увидит,
    // что расширение ждёт логина/перехвата).
    const existing = await chrome.tabs.query({ url: 'https://gmgn.ai/follow*' });
    if (existing.length) {
      if (force) await chrome.tabs.update(existing[0].id, { active: true }).catch(() => {});
      return;
    }

    await chrome.storage.local.set({ gw_bootstrap_last_at: Date.now() });
    await chrome.tabs.create({ url: 'https://gmgn.ai/follow?chain=robinhood', active: true });
  } catch (e) {
    // Не удалось открыть/проверить вкладку — просто ничего не делаем,
    // при следующем триггере (клик follow, старт браузера) попробуем снова.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  gwEnsureGroupsBootstrap();
});

// При каждом старте браузера — тоже проверяем: вдруг storage очистили или
// это первый раз, когда пользователь вообще открывает браузер с этим
// расширением.
chrome.runtime.onStartup.addListener(() => {
  gwEnsureGroupsBootstrap();
});

// content script (follow.js) шлёт это, когда его собственный refreshGroups()
// вернул пусто — chrome.tabs недоступен из content script, поэтому просим
// фон открыть вкладку.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'gw-bootstrap-now') {
    gwEnsureGroupsBootstrap({ force: true }).then(() => sendResponse({ ok: true }));
    return true; // асинхронный ответ
  }
});

// Клик по иконке расширения переключает докинг-сайдбар на активной вкладке
// (нет default_popup в manifest — иначе onClicked не сработает).
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'gw-toggle-panel' }).catch(() => {});
});

// Горячая клавиша — через нативный chrome.commands (manifest.json,
// "commands"."toggle-panel"), а не свой keydown-хендлер в content script.
// Так пользователь может сменить комбинацию сам на chrome://extensions/
// shortcuts — с готовой проверкой конфликтов с другими расширениями/
// браузером, без необходимости городить свой UI записи комбинации клавиш.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-panel' || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'gw-toggle-panel' }).catch(() => {});
});

// GMGN добавляет к своим запросам не только куки, но и кастомный
// заголовок с токеном (см. ошибки "empty token" / "invalid number of
// segments" при попытке дернуть API напрямую без него). chrome.storage/
// scripting доступны только фоновому воркеру и попапу/сайдбару, а вот
// заголовки реальных запросов страницы видны только через webRequest —
// тоже фон. Здесь мы их читаем (не блокируем, не модифицируем) и
// складываем в chrome.storage.local, чтобы api.js мог их переиспользовать.
//
// ВАЖНО: область захвата намеренно сужена до /api/v1/follow/* — ровно тех
// эндпоинтов, которые мы сами реплеим (business_group_multi_chain/list,
// follow_wallet). У GMGN несколько подсистем на одном домене (api, tapi,
// wallet-api, td, pf, mrtapi...), и судя по всему у них разные токены/
// заголовки — при захвате "всех заголовков со всех запросов к gmgn.ai"
// значение из одной подсистемы перетирало правильное значение из другой
// (тот самый баг с "invalid number of segments" — на сервер прилетал не
// тот токен). Плюс заголовки коммитятся в storage ТОЛЬКО когда сам
// запрос, с которого они сняты, завершился статусом 200 — не доверяем
// заголовкам неуспешного запроса.

const KEY = 'gmgn';

// Стандартные браузерные заголовки, которые не несут auth-информации
// и которые нет смысла тащить в наши собственные запросы.
const SKIP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'content-type',
  'accept', 'accept-encoding', 'accept-language', 'user-agent',
  'origin', 'referer', 'cookie', 'cache-control', 'pragma', 'dnt',
  'upgrade-insecure-requests', 'sec-fetch-dest', 'sec-fetch-mode',
  'sec-fetch-site', 'sec-fetch-user', 'sec-ch-ua', 'sec-ch-ua-mobile',
  'sec-ch-ua-platform', 'if-none-match', 'if-modified-since'
]);

const AUTH_HEADERS_URL_FILTER = { urls: ['https://gmgn.ai/api/v1/follow/*'] };

// requestId -> захваченные заголовки, ждут подтверждения (onCompleted)
const _gwPendingHeaders = new Map();

// Полная замена (не merge!) — чтобы старое/битое значение не пережило
// новый успешный набор заголовков.
async function setAuthHeaders(captured) {
  if (!Object.keys(captured).length) return;
  const res = await chrome.storage.local.get(KEY);
  const current = res[KEY] || {};
  await chrome.storage.local.set({
    [KEY]: Object.assign({}, current, { authHeaders: captured, updated: Date.now() })
  });
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details.requestHeaders) return;
    const captured = {};
    for (const h of details.requestHeaders) {
      const name = (h.name || '').toLowerCase();
      if (SKIP_HEADERS.has(name)) continue;
      if (h.value === undefined || h.value === '') continue;
      captured[h.name] = h.value;
    }
    _gwPendingHeaders.set(details.requestId, captured);
  },
  AUTH_HEADERS_URL_FILTER,
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onCompleted.addListener((details) => {
  const captured = _gwPendingHeaders.get(details.requestId);
  _gwPendingHeaders.delete(details.requestId);
  if (!captured || details.statusCode !== 200) return; // не коммитим заголовки неуспешного запроса
  setAuthHeaders(captured);
}, AUTH_HEADERS_URL_FILTER);

chrome.webRequest.onErrorOccurred.addListener((details) => {
  _gwPendingHeaders.delete(details.requestId);
}, AUTH_HEADERS_URL_FILTER);
