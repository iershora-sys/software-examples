// Angry Tracker — AP Channel v1.2.0 (MAIN world)
// Транслирует ВСЕ сигналы в BroadcastChannel 'angry_paint'.
// AT не принимает решений о приоритетах — это задача Angry Paint.
// AT шлёт только категорию: slot | whitelist | blacklist.
'use strict';

var _atPaintChannel = new BroadcastChannel('angry_paint');

// Маппинг ui_section → overlayType
function _atOverlayType(uiSection) {
  if (uiSection === 1)  return 'slot';
  if (uiSection === 99) return 'blacklist';
  return 'whitelist';
}

// Отправка claim — все сигналы без фильтрации
function _atSendClaim(ca, detail) {
  if (!ca) return;

  var uiSection   = detail.group_ui_section || 0;
  var overlayType = _atOverlayType(uiSection);

  _atPaintChannel.postMessage({
    type:        'ap-claim',
    ca:          ca,
    source:      'at',
    overlayType: overlayType,
    label:       detail.group_name  || 'Main',
    labelColor:  detail.group_color || '#EF911A',
    actions:     [],
    meta:        { group_id: detail.group_id || 0 },
    marker:      detail.marker || null,
  });
}

// Real-time сигнал от bridge
document.addEventListener('__at_new_signal__', function (e) {
  var detail = e.detail;
  if (!detail || !detail.token) return;
  _atSendClaim(detail.token, detail);
});

// Инициализация из storage при загрузке страницы
document.addEventListener('__at_signals_init__', function (e) {
  var signals = e.detail;
  if (!Array.isArray(signals)) return;
  for (var i = 0; i < signals.length; i++) {
    var s = signals[i];
    if (!s.token) continue;
    _atSendClaim(s.token, s);
  }
});

// ── AF Signal → Angry Paint ───────────────────────────────────────────────────
document.addEventListener('__af_new_signal__', function (e) {
  var d = e.detail;
  if (!d || !d.token) return;

  var isScam      = d.card_type === 'fresh_scam';
  var isDev       = d.source === 'dev';
  var overlayType = isDev ? 'dev' : (isScam ? 'scam' : 'whitelist');
  var labelColor  = isDev ? '#3b82f6' : (isScam ? '#ef4444' : (d.level_color || '#39FF14'));

  var parts  = [];
  var prefix = d.cex_name ? d.cex_name + (isDev ? ' Dev' : ' Fresh') : 'Fresh';
  parts.push(prefix + (d.count > 1 ? ' x' + d.count : ''));
  if (isScam) {
    parts.push('⚡ Scam');
  } else {
    if (d.all_same_cluster) parts.push('Full Cluster');
    else if (d.cluster_id)  parts.push('Clustered');
    if (d.has_aged)         parts.push('Aged 24h+');
  }

  _atPaintChannel.postMessage({
    type:        'ap-claim',
    ca:          d.token,
    source:      'af',
    overlayType: overlayType,
    label:       parts.join(' · '),
    labelColor:  labelColor,
    actions:     [],
    meta: {
      cluster_id:       d.cluster_id || 0,
      count:            d.count || 1,
      level:            d.level || 1,
      all_same_cluster: !!d.all_same_cluster,
      has_aged:         !!d.has_aged,
      card_type:        d.card_type || 'fresh_buy',
    },
    marker: null,
  });
});
