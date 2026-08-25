// Изолированный мир, домен gmgn.ai -> запросы same-origin, куки уходят сами.
(function () {
  const BASE = 'https://gmgn.ai';

  function buildQuery(params) {
    const usp = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null) usp.set(k, v);
    });
    return usp.toString();
  }

  async function request(path, { method = 'GET', query = {}, body } = {}) {
    const state = await window.__GMGN_STORAGE__.getState();
    const baseQuery = (state && state.queryParams) || {};
    const qs = buildQuery(Object.assign({}, baseQuery, query));
    const url = `${BASE}${path}${qs ? '?' + qs : ''}`;

    // authHeaders захватываются background.js (chrome.webRequest) из
    // реальных запросов страницы — GMGN требует не только куки, но и
    // кастомный токен в заголовке (см. P_GMGN_WEB_UNAUTHORIZED).
    const headers = Object.assign({}, (state && state.authHeaders) || {});
    if (body) headers['Content-Type'] = 'application/json';

    const resp = await fetch(url, {
      method,
      credentials: 'include',
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    const data = await resp.json().catch(() => null);
    return { status: resp.status, data };
  }

  window.__GMGN_API__ = { request };
})();
