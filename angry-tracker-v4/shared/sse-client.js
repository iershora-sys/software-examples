// Angry Ecosystem — общий SSE-клиент.
// Классический скрипт-синглтон. Работает и в service worker (importScripts),
// и в content-script (через content_scripts). НЕ использует window/DOM.
// Копия идентична во всех трёх расширениях.
(function () {
  'use strict';
  if (self.AngrySSE) return;

  // create({ url, events, onStatus, onParseError, reconnectMs, openPollMs })
  //   url          — string | () => string | Promise<string>  (полный URL, с ?since=)
  //   events       — { eventName: (data, ev) => void }  (data — уже распарсенный JSON)
  //   onStatus     — (connected:boolean) => void
  //   onParseError — (err, ev) => void                  (необязательно)
  // → { start, stop, reconnect, isOpen, isActive }
  function create(opts) {
    const o            = opts || {};
    const url          = o.url;
    const events       = o.events || {};
    const onStatus     = o.onStatus || null;
    const onParseError = o.onParseError || null;
    const reconnectMs  = o.reconnectMs || 2000;
    const openPollMs   = o.openPollMs  || 200;

    let es             = null;
    let reconnectTimer = null;
    let openTimer      = null;
    let active         = false;

    function clearTimers() {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (openTimer)      { clearInterval(openTimer);     openTimer = null; }
    }

    function close() {
      clearTimers();
      if (es) { try { es.close(); } catch (_) {} es = null; }
    }

    function scheduleReconnect() {
      if (!active) return;
      reconnectTimer = setTimeout(connect, reconnectMs);
    }

    async function connect() {
      close();
      if (!active) return;

      let resolved;
      try { resolved = (typeof url === 'function') ? await url() : url; }
      catch (_) { scheduleReconnect(); return; }
      if (!active) return; // могли остановить, пока ждали url()

      let e;
      try { e = new EventSource(resolved); }
      catch (_) { scheduleReconnect(); return; }
      es = e;

      // 'open' ненадёжен в service worker → поллим readyState
      openTimer = setInterval(() => {
        if (es !== e) { clearInterval(openTimer); openTimer = null; return; }
        if (e.readyState === 1) {        // OPEN
          clearInterval(openTimer); openTimer = null;
          if (onStatus) onStatus(true);
        } else if (e.readyState === 2) { // CLOSED
          clearInterval(openTimer); openTimer = null;
        }
      }, openPollMs);

      for (const name in events) {
        const handler = events[name];
        e.addEventListener(name, (ev) => {
          let data = null;
          if (ev && ev.data != null && ev.data !== '') {
            try { data = JSON.parse(ev.data); }
            catch (err) { if (onParseError) onParseError(err, ev); return; }
          }
          handler(data, ev);
        });
      }

      e.onerror = () => {
        if (onStatus) onStatus(false);
        close();
        scheduleReconnect();
      };
    }

    return {
      start()     { active = true; connect(); },
      stop()      { active = false; close(); if (onStatus) onStatus(false); },
      reconnect() { if (active) connect(); },
      isOpen()    { return !!es && es.readyState === 1; },
      isActive()  { return active; },
    };
  }

  self.AngrySSE = { create };
})();
