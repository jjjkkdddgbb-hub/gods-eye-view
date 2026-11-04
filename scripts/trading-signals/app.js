const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'gev-trading-signals-journal-v1';
let candles = [];
let latestAnalysis = null;
let notificationsEnabled = false;
let resizeObserver;

function demoCandles(count = 100) {
  // Deterministic, explicitly synthetic data. Never presented as a live quote.
  let close = 1.084;
  return Array.from({ length: count }, (_, i) => {
    const drift = i < 38 ? 0.000035 : i < 68 ? -0.000018 : 0.00004;
    const wave = Math.sin(i * 0.47) * 0.00011 + Math.sin(i * 0.13) * 0.00007;
    const open = close;
    close = Math.max(0.7, open + drift + wave);
    const spread = 0.00008 + (i % 7) * 0.000012;
    return { time: new Date(Date.UTC(2025, 0, 1, 0, i * 15)).toISOString(), open, high: Math.max(open, close) + spread, low: Math.min(open, close) - spread, close, volume: 100 + (i % 13) * 17 };
  });
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 16) throw new Error('يلزم وجود عنوان و15 شمعة على الأقل.');
  const delimiter = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const header = lines[0].split(delimiter).map((v) => v.trim().toLowerCase().replace(/^"|"$/g, ''));
  const aliases = { timestamp: ['timestamp', 'time', 'date', 'datetime'], open: ['open', 'o'], high: ['high', 'h'], low: ['low', 'l'], close: ['close', 'c'], volume: ['volume', 'vol', 'v'] };
  const columns = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, header.findIndex((name) => names.includes(name))]));
  for (const key of ['open', 'high', 'low', 'close']) if (columns[key] < 0) throw new Error(`عمود ${key} مطلوب. العناوين المقبولة: time, open, high, low, close, volume.`);
  const rows = lines.slice(1).map((line) => line.split(delimiter).map((v) => v.trim().replace(/^"|"$/g, ''))).map((row, i) => {
    const num = (key) => Number(row[columns[key]]?.replace(',', '.'));
    const candle = { time: columns.timestamp >= 0 ? row[columns.timestamp] : String(i + 1), open: num('open'), high: num('high'), low: num('low'), close: num('close'), volume: columns.volume >= 0 ? num('volume') : 0 };
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.low > candle.high) return null;
    return candle;
  }).filter(Boolean);
  if (rows.length < 15) throw new Error('لم أجد 15 شمعة صحيحة على الأقل. تحقق من ترتيب الأعمدة وقيم OHLC.');
  return rows;
}

function ema(values, period) {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < values.length; i++) result += alpha * (values[i] - result);
  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const delta = values[i] - values[i - 1]; gains += Math.max(delta, 0); losses += Math.max(-delta, 0); }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function averageRange(data, period = 14) {
  const ranges = data.slice(-period).map((candle) => candle.high - candle.low);
  return ranges.reduce((sum, value) => sum + value, 0) / Math.max(1, ranges.length);
}

function findStructure(data) {
  const last = data.at(-1);
  const closeValues = data.map((candle) => candle.close);
  const fast = ema(closeValues, 12), slow = ema(closeValues, 26);
  const momentum = fast === null || slow === null ? 0 : fast - slow;
  const rsiValue = rsi(closeValues);
  const atr = averageRange(data);
  const lookback = Math.min(20, data.length - 6);
  const prior = data.slice(-(lookback + 1), -1);
  const resistance = Math.max(...prior.map((c) => c.high));
  const support = Math.min(...prior.map((c) => c.low));
  const tolerance = Math.max(atr * 0.3, Math.abs(last.close) * 0.00005);
  const bullishRetest = last.low <= resistance + tolerance && last.close >= resistance && data.at(-2).close > resistance;
  const bearishRetest = last.high >= support - tolerance && last.close <= support && data.at(-2).close < support;
  const direction = bullishRetest ? 'up' : bearishRetest ? 'down' : null;
  let orderBlock = null;
  if (direction) {
    const breakIndex = data.length - 2;
    for (let i = breakIndex - 1; i >= Math.max(0, breakIndex - 8); i--) {
      const c = data[i];
      if ((direction === 'up' && c.close < c.open) || (direction === 'down' && c.close > c.open)) {
        orderBlock = { low: Math.min(c.open, c.close), high: Math.max(c.open, c.close) };
        break;
      }
    }
  }
  const nearOrderBlock = !!orderBlock && last.low <= orderBlock.high + atr * 0.5 && last.high >= orderBlock.low - atr * 0.5;
  const rsiAligned = rsiValue !== null && (direction === 'up' ? rsiValue >= 50 && rsiValue < 75 : direction === 'down' ? rsiValue <= 50 && rsiValue > 25 : false);
  const momentumAligned = direction === 'up' ? momentum > 0 : direction === 'down' ? momentum < 0 : false;
  const score = direction ? 1 + Number(nearOrderBlock) + Number(rsiAligned) + Number(momentumAligned) : 0;
  const signal = direction && nearOrderBlock && score >= 3 ? direction : null;
  return { last, rsiValue, momentum, resistance, support, direction, nearOrderBlock, orderBlock, rsiAligned, momentumAligned, score, signal, atr };
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 5 : 3 }).format(value);
}
function showToast(message) {
  const toast = $('toast'); toast.textContent = message; toast.classList.add('visible');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function render() {
  const symbol = $('symbolInput').value.trim() || 'غير محدد';
  const timeframe = $('timeframe').value;
  $('chartTitle').innerHTML = `${escapeHtml(symbol)} <span>· ${escapeHtml(timeframe)}</span>`;
  $('candleCount').textContent = `${candles.length} شمعة`;
  $('emptyChart').hidden = candles.length > 0;
  if (!candles.length) return;
  const result = findStructure(candles);
  latestAnalysis = { ...result, symbol, timeframe };
  $('lastPrice').textContent = formatPrice(result.last.close);
  const change = ((result.last.close - candles[0].open) / candles[0].open) * 100;
  $('priceChange').textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}% من أول شمعة في الملف`;
  $('priceChange').className = change >= 0 ? 'positive' : 'negative';
  $('rsiValue').textContent = result.rsiValue === null ? '—' : result.rsiValue.toFixed(1);
  $('rsiState').textContent = result.rsiValue === null ? 'بيانات غير كافية' : result.rsiValue >= 70 ? 'تشبع شرائي محتمل' : result.rsiValue <= 30 ? 'تشبع بيعي محتمل' : 'ضمن النطاق الوسطي';
  $('momentumValue').textContent = `${result.momentum >= 0 ? '+' : ''}${result.momentum.toPrecision(4)}`;
  $('momentumState').textContent = result.momentum > 0 ? 'ميل إيجابي · EMA 12 أعلى من 26' : result.momentum < 0 ? 'ميل سلبي · EMA 12 أدنى من 26' : 'زخم محايد';
  $('scoreValue').textContent = `${result.score}/4`;
  $('bosState').textContent = result.direction ? (result.direction === 'up' ? 'صاعد · إعادة اختبار' : 'هابط · إعادة اختبار') : 'لا يوجد تأكيد حديث';
  $('obState').textContent = result.orderBlock ? (result.nearOrderBlock ? 'قريب من المنطقة' : 'المنطقة بعيدة') : 'لم تُحدد منطقة';
  $('confirmState').textContent = `${result.rsiAligned ? 'RSI ✓' : 'RSI —'} · ${result.momentumAligned ? 'الزخم ✓' : 'الزخم —'}`;
  const card = $('signalCard');
  card.className = `signal-card ${result.signal === 'up' ? 'bullish' : result.signal === 'down' ? 'bearish' : 'neutral'}`;
  $('signalIcon').textContent = result.signal === 'up' ? '↗' : result.signal === 'down' ? '↘' : '…';
  $('signalTitle').textContent = result.signal === 'up' ? 'إشارة صعود محتملة' : result.signal === 'down' ? 'إشارة هبوط محتملة' : 'لا توجد إشارة مكتملة';
  $('signalDescription').textContent = result.signal ? `توافق الشروط الفنية ${result.score}/4 عند آخر شمعة. راجع الرسم والبيانات بنفسك.` : 'ننتظر توافق إعادة الاختبار مع منطقة الطلب/العرض والمؤشرات.';
  $('saveSignal').disabled = false;
  drawChart();
}

function escapeHtml(text) { return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }

function drawChart() {
  const canvas = $('chart');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !candles.length) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr); canvas.height = Math.floor(rect.height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height, pad = { top: 18, right: 68, bottom: 24, left: 8 };
  const shown = candles.slice(-70), values = shown.flatMap((c) => [c.high, c.low]);
  const max = Math.max(...values), min = Math.min(...values), range = max - min || 1;
  const y = (price) => pad.top + (max - price) / range * (h - pad.top - pad.bottom);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'left';
  for (let i = 0; i < 5; i++) {
    const gy = pad.top + i * (h - pad.top - pad.bottom) / 4;
    const value = max - i * range / 4;
    ctx.strokeStyle = '#202a38'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
    ctx.fillStyle = '#8793a5'; ctx.fillText(formatPrice(value), w - pad.right + 8, gy + 4);
  }
  const step = (w - pad.right - pad.left) / shown.length, bodyWidth = Math.max(3, step * 0.58);
  shown.forEach((candle, i) => {
    const x = pad.left + step * i + step / 2, up = candle.close >= candle.open;
    ctx.strokeStyle = up ? '#36d6a0' : '#ff647c'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y(candle.high)); ctx.lineTo(x, y(candle.low)); ctx.stroke();
    const top = y(Math.max(candle.open, candle.close)), bottom = y(Math.min(candle.open, candle.close));
    ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, Math.max(1.5, bottom - top));
  });
  if (latestAnalysis?.orderBlock) {
    const ob = latestAnalysis.orderBlock;
    ctx.fillStyle = latestAnalysis.direction === 'up' ? 'rgba(54,214,160,.10)' : 'rgba(255,100,124,.10)';
    ctx.fillRect(0, y(ob.high), w - pad.right, Math.max(2, y(ob.low) - y(ob.high)));
    ctx.setLineDash([4, 4]); ctx.strokeStyle = latestAnalysis.direction === 'up' ? '#36d6a0' : '#ff647c';
    ctx.beginPath(); ctx.moveTo(0, y(ob.high)); ctx.lineTo(w - pad.right, y(ob.high)); ctx.moveTo(0, y(ob.low)); ctx.lineTo(w - pad.right, y(ob.low)); ctx.stroke(); ctx.setLineDash([]);
  }
}

function readJournal() { try { const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(data) ? data : []; } catch { return []; } }
function renderJournal() {
  const journal = readJournal(); const body = $('journalBody');
  if (!journal.length) { body.innerHTML = '<tr><td colspan="6" class="empty-row">لا توجد نتائج محفوظة.</td></tr>'; return; }
  body.innerHTML = journal.slice(0, 12).map((item) => `<tr><td>${escapeHtml(item.time)}</td><td>${escapeHtml(item.symbol)}</td><td>${escapeHtml(item.timeframe)}</td><td><span class="table-signal ${item.direction === 'up' ? 'up' : item.direction === 'down' ? 'down' : ''}">${item.label}</span></td><td>${escapeHtml(item.price)}</td><td>${item.score}/4</td></tr>`).join('');
}

$('analyzeButton').addEventListener('click', () => { if (!candles.length) return showToast('حمّل ملف CSV أولاً أو اختر البيانات التجريبية.'); render(); showToast('تم تحديث التحليل المحلي.'); });
$('demoButton').addEventListener('click', () => { candles = demoCandles(); $('dataState').textContent = 'بيانات صناعية توضيحية · ليست أسعاراً حقيقية'; $('csvInput').value = ''; render(); showToast('تم تحميل بيانات صناعية للتجربة فقط.'); });
$('csvInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  try { candles = parseCsv(await file.text()); $('dataState').textContent = `ملف محلي: ${file.name}`; render(); showToast(`تم تحميل ${candles.length} شمعة من جهازك.`); }
  catch (error) { event.target.value = ''; showToast(error.message || 'تعذر قراءة الملف.'); }
});
$('symbolInput').addEventListener('input', () => { if (candles.length) render(); });
$('timeframe').addEventListener('change', () => { if (candles.length) render(); });
$('saveSignal').addEventListener('click', () => {
  if (!latestAnalysis) return;
  const result = latestAnalysis; const direction = result.signal;
  const item = { time: new Date().toLocaleString('ar', { dateStyle: 'short', timeStyle: 'short' }), symbol: result.symbol, timeframe: result.timeframe, direction: direction || 'none', label: direction === 'up' ? 'صعود محتمل' : direction === 'down' ? 'هبوط محتمل' : 'انتظار', price: formatPrice(result.last.close), score: result.score };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([item, ...readJournal()].slice(0, 50))); renderJournal(); showToast('حُفظت النتيجة محلياً في هذا المتصفح.'); }
  catch { showToast('تعذر الحفظ المحلي؛ قد تكون مساحة المتصفح ممتلئة.'); }
});
$('clearJournal').addEventListener('click', () => { localStorage.removeItem(STORAGE_KEY); renderJournal(); showToast('تم مسح السجل المحلي.'); });
$('alertsButton').addEventListener('click', async () => {
  if (!('Notification' in window)) return showToast('التنبيهات غير مدعومة في هذا المتصفح.');
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission === 'granted') { notificationsEnabled = !notificationsEnabled; $('alertsButton').textContent = notificationsEnabled ? 'إيقاف التنبيهات' : 'تفعيل التنبيهات'; showToast(notificationsEnabled ? 'ستظهر تنبيهات عند التحليل اليدوي فقط.' : 'تم إيقاف التنبيهات.'); }
  else showToast('لم يتم منح إذن التنبيهات.');
});
const originalRender = render;
// Notifications happen only after a user-triggered analysis, never in the background.
$('analyzeButton').addEventListener('click', () => {
  if (!notificationsEnabled || !latestAnalysis?.signal || Notification.permission !== 'granted') return;
  new Notification('عين السوق · إشارة تعليمية', { body: `${latestAnalysis.symbol}: ${latestAnalysis.signal === 'up' ? 'صعود محتمل' : 'هبوط محتمل'} · توافق ${latestAnalysis.score}/4` });
});
if ('ResizeObserver' in window) { resizeObserver = new ResizeObserver(drawChart); resizeObserver.observe($('chart').parentElement); } else window.addEventListener('resize', drawChart);
renderJournal();
candles = demoCandles(); render();
