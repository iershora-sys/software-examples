// ══════════════════════════════════════════════════════════════════════════════
// Экспорт выбранных кошельков в трекинг-бота (v1.19.0).
//
// Зачем отдельно от "Добавить в вачлист": GMGN и трекинг-бот — разные
// потребители одного и того же набора адресов. В GMGN уходит follow+remark
// по API, боту нужен файл. Раньше второй сценарий делался руками.
//
// Осознанно НЕ дублируем поля, которые уже есть выше: префикс, "Нумеровать"
// и группа читаются из тех же prefixInput/numberingInput/groupInput. Две
// пары полей с одинаковым смыслом — гарантированный источник расхождений
// ("в GMGN уехало одно имя, в бота другое").
//
// Отдельный файл, а не хвост sidebar.js: подключается ПОСЛЕ него обычным
// <script>, поэтому видит его верхнеуровневые const/let (классические
// скрипты делят один глобальный лексический скоуп) — _currentTokenAddr,
// _numberingEnabled, prefixInput и прочее переобъявлять не нужно.
// ══════════════════════════════════════════════════════════════════════════════

const GW_EXPORT_EMOJI = [
  '👶', '👻', '🐍', '🥷', '🦈', '🐺', '🦊', '🐯',
  '🦁', '🐳', '🤵', '🦅', '💎', '🚀', '👑', '🔥',
];

// "Авто" — эмодзи по позиции в списке: чем выше кошелёк, тем крупнее зверь.
// Порядок списка = порядок отметки чекбоксов на странице токена, то есть
// обычно сверху вниз по таблице холдеров, где выше = крупнее позиция.
const GW_EXPORT_EMOJI_AUTO = ['🐳', '🦈', '🐺', '🦊', '👻'];

const exportSectionEl = document.getElementById('exportSection');
const exportDetailsEl = document.getElementById('exportDetails');
const exportCountEl = document.getElementById('exportCount');
const emojiGridEl = document.getElementById('emojiGrid');
const previewEl = document.getElementById('exportPreview');
const exportResultEl = document.getElementById('exportResult');
const soundInput = document.getElementById('soundInput');
const filenameInput = document.getElementById('filenameInput');
const alertToastInput = document.getElementById('alertToast');
const alertBubbleInput = document.getElementById('alertBubble');
const alertFeedInput = document.getElementById('alertFeed');
const copyExportBtn = document.getElementById('copyExportBtn');
const downloadExportBtn = document.getElementById('downloadExportBtn');
const applyToGmgnInput = document.getElementById('applyToGmgn');

let _exportFormat = 'json';     // json | csv | addr
let _exportNameMode = 'prefix'; // prefix | rank | addr
let _exportEmoji = 'auto';      // 'auto' | конкретный символ
let _filenameTouched = false;   // юзер сам правил имя файла — не перезатираем автоподстановкой

function gwShortAddr(addr) {
  return addr.length > 12 ? addr.slice(0, 6) + '...' + addr.slice(-4) : addr;
}

// Активная кнопка сегментированного переключателя. Сравниваем по data-val,
// а не запоминаем узел — так же работает и после любого ре-рендера.
function gwSyncSeg(containerId, value) {
  document.querySelectorAll('#' + containerId + ' .gw-seg-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.val === value);
  });
}

function gwSyncEmoji() {
  emojiGridEl.querySelectorAll('.gw-emoji-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.val === _exportEmoji);
  });
}

function gwBuildEmojiGrid() {
  emojiGridEl.innerHTML = '';
  const mk = (val, label, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gw-emoji-btn';
    b.dataset.val = val;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => {
      _exportEmoji = val;
      gwSyncEmoji();
      saveExportPrefs();
      renderExport();
    });
    emojiGridEl.appendChild(b);
  };
  mk('auto', 'Авто', 'По позиции в списке: 🐳 🦈 🐺 🦊, дальше 👻');
  for (const e of GW_EXPORT_EMOJI) mk(e, e, 'Всем кошелькам ' + e);
  gwSyncEmoji();
}

// Список для экспорта — те же записи текущего токена, что и в таблице выше.
// Здесь, в отличие от добавления в GMGN, НЕ отсеиваем followed/botAddress:
// в трекинг-бота уходит весь отобранный набор, а "GMGN считает адрес ботом"
// про пригодность для бота ничего не говорит.
async function gwExportList() {
  const all = (await chrome.storage.local.get('gw_selected')).gw_selected || [];
  return _currentTokenAddr ? all.filter((x) => x.tokenAddr === _currentTokenAddr) : [];
}

function gwExportNameAs(item, i, mode) {
  const ticker = item.tokenTicker || tokenTickerEl.textContent.trim() || 'TOKEN';
  if (mode === 'rank') return '#' + (i + 1) + ' - ' + ticker;
  if (mode === 'addr') return gwShortAddr(item.addr);
  const prefix = prefixInput.value.trim() || (_numberingEnabled ? 'WALLET_' : 'WALLET');
  return _numberingEnabled ? prefix + (i + 1) : prefix;
}

function gwExportEmojiFor(i) {
  if (_exportEmoji !== 'auto') return _exportEmoji;
  return GW_EXPORT_EMOJI_AUTO[Math.min(i, GW_EXPORT_EMOJI_AUTO.length - 1)];
}

// Ключи и их порядок — 1-в-1 как в JSON, который ест трекинг-бот.
function gwBuildRows(list) {
  const group = groupInput.value.trim() || 'Main';
  const sound = soundInput.value.trim() || 'default';
  return list.map((item, i) => ({
    trackedWalletAddress: item.addr,
    name: gwExportNameAs(item, i, _exportNameMode),
    emoji: gwExportEmojiFor(i),
    alertsOnToast: alertToastInput.checked,
    alertsOnBubble: alertBubbleInput.checked,
    alertsOnFeed: alertFeedInput.checked,
    groups: [group],
    sound: sound,
  }));
}

// Экранирование по RFC 4180 — имена вполне могут содержать запятую
// ("#1 - CHAIN, alt") и тогда без кавычек колонки разъедутся.
function gwCsvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const GW_CSV_COLS = [
  'trackedWalletAddress', 'name', 'emoji',
  'alertsOnToast', 'alertsOnBubble', 'alertsOnFeed', 'groups', 'sound',
];

function gwSerialize(list) {
  if (_exportFormat === 'addr') return list.map((x) => x.addr).join('\n');
  const rows = gwBuildRows(list);
  if (_exportFormat === 'csv') {
    const body = rows.map((r) => GW_CSV_COLS
      .map((c) => gwCsvCell(c === 'groups' ? r.groups.join('|') : r[c]))
      .join(','));
    return [GW_CSV_COLS.join(',')].concat(body).join('\n');
  }
  return JSON.stringify(rows, null, 2);
}

function gwExportExt() {
  if (_exportFormat === 'json') return 'json';
  if (_exportFormat === 'csv') return 'csv';
  return 'txt';
}

async function renderExport() {
  if (!exportSectionEl || exportSectionEl.style.display === 'none') return;
  const list = await gwExportList();

  exportCountEl.textContent = list.length;

  // Живые примеры под кнопками выбора имени — на реальном первом кошельке
  // списка, чтобы формат было видно ещё до раскрытия предпросмотра.
  const sample = list[0];
  document.getElementById('egPrefix').textContent = sample ? gwExportNameAs(sample, 0, 'prefix') : 'WALLET_1';
  document.getElementById('egRank').textContent = sample ? gwExportNameAs(sample, 0, 'rank') : '#1 - TICKER';
  document.getElementById('egAddr').textContent = sample ? gwShortAddr(sample.addr) : '0xc399...ec81';

  if (!_filenameTouched && !filenameInput.value) {
    const ticker = (sample && sample.tokenTicker) || tokenTickerEl.textContent.trim();
    filenameInput.value = ticker ? ticker.toLowerCase() + ' wallets' : 'wallets';
  }

  previewEl.textContent = list.length ? gwSerialize(list) : '—';
  copyExportBtn.disabled = !list.length;
  downloadExportBtn.disabled = !list.length;
}

async function saveExportPrefs() {
  await chrome.storage.local.set({
    gw_export: {
      format: _exportFormat,
      nameMode: _exportNameMode,
      emoji: _exportEmoji,
      toast: alertToastInput.checked,
      bubble: alertBubbleInput.checked,
      feed: alertFeedInput.checked,
      sound: soundInput.value,
      applyToGmgn: applyToGmgnInput.checked,
    }
  });
}

async function loadExportPrefs() {
  const { gw_export } = await chrome.storage.local.get('gw_export');
  if (gw_export) {
    _exportFormat = gw_export.format || 'json';
    _exportNameMode = gw_export.nameMode || 'prefix';
    _exportEmoji = gw_export.emoji || 'auto';
    alertToastInput.checked = !!gw_export.toast;
    // Bubble/Feed по умолчанию включены — сравниваем с false, а не с
    // undefined, иначе первый запуск (ключа ещё нет) их бы погасил.
    alertBubbleInput.checked = gw_export.bubble !== false;
    alertFeedInput.checked = gw_export.feed !== false;
    if (gw_export.sound) soundInput.value = gw_export.sound;
    applyToGmgnInput.checked = !!gw_export.applyToGmgn;
  }
  gwSyncSeg('fmtSeg', _exportFormat);
  gwSyncSeg('nameSeg', _exportNameMode);
  gwBuildEmojiGrid();
  renderExport();
}

document.querySelectorAll('#fmtSeg .gw-seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    _exportFormat = b.dataset.val;
    gwSyncSeg('fmtSeg', _exportFormat);
    saveExportPrefs();
    renderExport();
  });
});

document.querySelectorAll('#nameSeg .gw-seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    _exportNameMode = b.dataset.val;
    gwSyncSeg('nameSeg', _exportNameMode);
    saveExportPrefs();
    renderExport();
  });
});

for (const el of [alertToastInput, alertBubbleInput, alertFeedInput]) {
  el.addEventListener('change', () => { saveExportPrefs(); renderExport(); });
}
soundInput.addEventListener('input', () => { saveExportPrefs(); renderExport(); });
filenameInput.addEventListener('input', () => { _filenameTouched = true; });

// Префикс/нумерация/группа живут в секции выше и участвуют в имени —
// предпросмотр обязан реагировать на их правку, иначе показывал бы
// устаревший результат, который разойдётся со скачанным файлом.
prefixInput.addEventListener('input', renderExport);
groupInput.addEventListener('input', renderExport);
numberingInput.addEventListener('change', renderExport);
exportDetailsEl.addEventListener('toggle', renderExport);

copyExportBtn.addEventListener('click', async () => {
  const list = await gwExportList();
  if (!list.length) return;
  const text = gwSerialize(list);
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (e) {
    // navigator.clipboard может быть недоступен (панель — cross-origin
    // iframe; allow="clipboard-write" в panel.js это чинит, но старая
    // вкладка gmgn.ai могла остаться открытой с прежним iframe без него).
    // execCommand устарел, зато работает без Permissions Policy.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e2) { ok = false; }
  }
  exportResultEl.textContent = ok
    ? 'Скопировано: ' + list.length + ' кошельков (' + _exportFormat.toUpperCase() + ').'
    : 'Буфер недоступен — обновите вкладку gmgn.ai или выделите текст в предпросмотре вручную.';
});

downloadExportBtn.addEventListener('click', async () => {
  const list = await gwExportList();
  if (!list.length) return;
  const base = (filenameInput.value.trim() || 'wallets').replace(/[\\/:*?"<>|]/g, '_');
  const blob = new Blob([gwSerialize(list)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = base + '.' + gwExportExt();
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Отзываем не сразу: Chrome дочитывает blob уже после клика, немедленный
  // revokeObjectURL иногда обрывает скачивание пустым файлом.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  exportResultEl.textContent = 'Файл ' + base + '.' + gwExportExt() + ' — ' + list.length + ' кошельков.';
});

// ── мост к добавлению в GMGN ────────────────────────────────────────────────
// Те же эмодзи и тумблеры применяются к самому GMGN (remark_wallet_v2 +
// follow_alert), но ТОЛЬКО по явной галочке. По умолчанию выключено: иначе
// первое же добавление после обновления расширения молча переписало бы
// оповещения кошельков, которых пользователь в панели даже не открывал.
//
// Через window, а не напрямую: sidebar.js грузится РАНЬШЕ этого файла и на
// момент своего исполнения объявленных здесь функций ещё не видит.
window.__gwRenderExport = renderExport;

window.__gwGmgnDecor = function (i) {
  if (!applyToGmgnInput || !applyToGmgnInput.checked) return null;
  return {
    emoji: gwExportEmojiFor(i),
    alerts: {
      toast: alertToastInput.checked,
      feed: alertFeedInput.checked,
      bubble: alertBubbleInput.checked,
      sound: soundInput.value.trim(),
    },
  };
};

applyToGmgnInput.addEventListener('change', saveExportPrefs);

loadExportPrefs();
