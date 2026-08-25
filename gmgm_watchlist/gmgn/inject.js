// Выполняется в MAIN world (в контексте самой страницы gmgn.ai).
// Задача: не делая ни одного лишнего запроса, перехватить ответ,
// который GMGN и так сам получает при открытии /follow?chain=...
(function () {
  // Guard от двойного патчинга (если скрипт вдруг выполнится дважды —
  // например при определённых SPA-переходах или конфликте с другим
  // расширением, патчащим то же самое). Паттерн взят из соседнего
  // инструмента команды (pump-fun-api-collector-v2/interceptor.js).
  if (window.__gwInterceptorActive) return;
  window.__gwInterceptorActive = true;

  const TARGET_PATH = '/api/v1/follow/business_group_multi_chain/list';
  const TARGET_HOST = 'gmgn.ai';
  const KEEP_QUERY_KEYS = [
    'device_id', 'fp_did', 'client_id', 'from_app',
    'app_ver', 'tz_name', 'tz_offset', 'app_lang', 'os'
  ];

  // Проверяем и путь, И хост (не просто includes(path) по сырой строке) —
  // иначе теоретически можно словить чужой URL, где TARGET_PATH случайно
  // оказался частью query-параметра или фрагмента.
  function isTargetUrl(urlStr) {
    try {
      const u = new URL(urlStr, location.href);
      return u.hostname === TARGET_HOST && u.pathname === TARGET_PATH;
    } catch (e) {
      return false;
    }
  }

  function extractQueryParams(urlStr) {
    try {
      const u = new URL(urlStr, location.origin);
      const out = {};
      KEEP_QUERY_KEYS.forEach((k) => {
        const v = u.searchParams.get(k);
        if (v !== null) out[k] = v;
      });
      return out;
    } catch (e) {
      return null;
    }
  }

  function emit(urlStr, payload) {
    window.postMessage({
      source: 'gmgn-watchlist-inject',
      type: 'GROUPS_RESPONSE',
      payload,
      queryParams: extractQueryParams(urlStr)
    }, '*');
  }

  // --- fetch ---
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const urlStr = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    return origFetch.apply(this, args).then((response) => {
      if (isTargetUrl(urlStr)) {
        response.clone().json().then((data) => emit(urlStr, data)).catch(() => {});
      }
      return response;
    });
  };

  // --- XHR (на случай если запрос идет не через fetch) ---
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let reqUrl = '';
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      reqUrl = url;
      return origOpen(method, url, ...rest);
    };
    xhr.addEventListener('load', function () {
      if (reqUrl && isTargetUrl(reqUrl)) {
        try {
          emit(reqUrl, JSON.parse(xhr.responseText));
        } catch (e) {
          /* ignore */
        }
      }
    });
    return xhr;
  }
  window.XMLHttpRequest = PatchedXHR;
})();
