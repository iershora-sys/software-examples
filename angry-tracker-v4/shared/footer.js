// Angry Ecosystem — общий футер (LED SSE/API + контекст).
// Классический скрипт-синглтон. Грузится в sidebar.html перед sidebar.js.
// Копия идентична во всех трёх расширениях.
(function () {
  'use strict';
  if (self.AngryFooter) return;

  function byId(id) { return document.getElementById(id); }

  // SSE-лампа: зелёная = подключено, красная = отключено.
  function setSSE(connected) {
    const led = byId('led-sse');
    if (!led) return;
    led.classList.remove('gf-led-dim', 'gf-led-green', 'gf-led-red');
    led.classList.add(connected ? 'gf-led-green' : 'gf-led-red');
  }

  // API-лампа: вспышка зелёным на 300мс при каждом запросе.
  let _apiTimer = null;
  function flashAPI() {
    const led = byId('led-api');
    if (!led) return;
    led.classList.remove('gf-led-dim', 'gf-led-pulse');
    led.classList.add('gf-led-green');
    clearTimeout(_apiTimer);
    _apiTimer = setTimeout(() => {
      led.classList.remove('gf-led-green');
      void led.offsetWidth; // reflow для рестарта анимации
      led.classList.add('gf-led-dim');
    }, 300);
  }

  // Контекст футера (произвольный текст; вычисляет каждое расширение само).
  function setContext(text) {
    const ctx = byId('gf-context');
    if (ctx) ctx.textContent = text;
  }

  // Статус SSE приходит из двух транспортов:
  //  • chrome.runtime сообщение  — AF/AT (SSE живёт в service worker): 'af-sse-status' / 'at-sse-status'
  //  • window postMessage        — AW   (SSE живёт в content-script):  'aw-sse-status'
  // Нормализуем по суффиксу '-sse-status'.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && typeof msg.type === 'string' && msg.type.endsWith('-sse-status')) setSSE(!!msg.connected);
    });
  } catch (_) {}
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && typeof d.type === 'string' && d.type.endsWith('-sse-status')) setSSE(!!d.connected);
  });

  self.AngryFooter = { setSSE, flashAPI, setContext };
})();
