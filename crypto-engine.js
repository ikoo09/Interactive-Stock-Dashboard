(() => {
  'use strict';

  const DB = typeof cryptoDatabase !== 'undefined' ? cryptoDatabase : null;
  if (!DB) return;

  const API_BASE = '/api/v3';
  const HISTORY_LIMITS = { '1D': 150, '4H': 120, '1H': 120, '15M': 120 };
  const BINANCE_INTERVALS = { '1D': '1d', '4H': '4h', '1H': '1h', '15M': '15m' };
  const TF_WEIGHTS = { '15M': 0.10, '1H': 0.20, '4H': 0.30, '1D': 0.40 };
  const WS_BASES = ['wss://stream.binance.com:9443/stream', 'wss://data-stream.binance.vision/stream'];

  let ws = null;
  let wsBaseIndex = 0;
  let reconnectTimer = null;
  let healthTimer = null;
  let wsStartedAt = 0;
  let currentSubscribedKlines = [];
  let reconnectAttempt = 0;
  let lastAccuracyRefresh = 0;
  let lastRestHealth = 0;
  let destroyed = false;

  const originalUpdateDashboard = typeof updateDashboard === 'function' ? updateDashboard : null;
  const originalSelectCoin = typeof selectCoin === 'function' ? selectCoin : null;

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

  function ema(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let out = mean(values.slice(0, period));
    for (let i = period; i < values.length; i++) out = values[i] * k + out * (1 - k);
    return out;
  }

  function emaSeries(values, period) {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const out = new Array(values.length).fill(null);
    out[period - 1] = mean(values.slice(0, period));
    for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
    return out;
  }

  function rsi(values, period = 14) {
    if (values.length <= period) return 50;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      gain += Math.max(d, 0); loss += Math.max(-d, 0);
    }
    let avgGain = gain / period, avgLoss = loss / period;
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      avgGain = ((avgGain * (period - 1)) + Math.max(d, 0)) / period;
      avgLoss = ((avgLoss * (period - 1)) + Math.max(-d, 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
  }

  function atr(ohlc, period = 14) {
    if (ohlc.length <= period) return null;
    const tr = [];
    for (let i = 1; i < ohlc.length; i++) {
      const pc = ohlc[i - 1].c;
      tr.push(Math.max(ohlc[i].h - ohlc[i].l, Math.abs(ohlc[i].h - pc), Math.abs(ohlc[i].l - pc)));
    }
    let value = mean(tr.slice(0, period));
    for (let i = period; i < tr.length; i++) value = ((value * (period - 1)) + tr[i]) / period;
    return value;
  }

  function rollingVwap(ohlc, volumes, period = 40) {
    const n = Math.min(period, ohlc.length);
    let pv = 0, vol = 0;
    for (let i = ohlc.length - n; i < ohlc.length; i++) {
      const typical = (ohlc[i].h + ohlc[i].l + ohlc[i].c) / 3;
      const v = Number(volumes[i] || 0);
      pv += typical * v; vol += v;
    }
    return vol > 0 ? pv / vol : ohlc[ohlc.length - 1]?.c || 0;
  }

  function volumeRatio(volumes, period = 20) {
    if (volumes.length < period + 1) return 1;
    const avg = mean(volumes.slice(-period - 1, -1));
    return avg > 0 ? volumes[volumes.length - 1] / avg : 1;
  }

  function macd(values) {
    const fast = emaSeries(values, 12), slow = emaSeries(values, 26);
    const lineSeries = values.map((_, i) => fast[i] !== null && slow[i] !== null ? fast[i] - slow[i] : null).filter(v => v !== null);
    if (!lineSeries.length) return { line: 0, signal: 0, hist: 0 };
    const line = lineSeries[lineSeries.length - 1];
    const signal = ema(lineSeries, 9) ?? 0;
    return { line, signal, hist: line - signal };
  }

  function structure(ohlc, lookback = 40) {
    const s = ohlc.slice(-lookback);
    return { high: Math.max(...s.map(x => x.h)), low: Math.min(...s.map(x => x.l)) };
  }

  function tfMetrics(data) {
    if (!data || data.prices.length < 55) return null;
    const p = data.prices, o = data.ohlc;
    const close = p[p.length - 1];
    const ema12 = ema(p, 12), ema26 = ema(p, 26), ema50 = ema(p, 50);
    const rsiV = rsi(p), atrV = atr(o) || Math.max(close * 0.005, 1e-8);
    const vwap = rollingVwap(o, data.volumes, 40), macdV = macd(p), volR = volumeRatio(data.volumes);
    const trend = clamp(((close - ema50) / atrV) * 0.35 + ((ema12 - ema26) / atrV) * 0.65, -1, 1);
    const momentum = clamp(((rsiV - 50) / 18) * 0.5 + (macdV.hist / atrV) * 0.5, -1, 1);
    const vwapBias = clamp((close - vwap) / atrV, -1, 1);
    const last = o[o.length - 1];
    const candleBias = last.c > last.o ? 0.15 : last.c < last.o ? -0.15 : 0;
    const score = clamp(trend * 0.45 + momentum * 0.30 + vwapBias * 0.15 + (volR >= 1.2 ? candleBias : 0) * 0.10, -1, 1);
    return { close, ema12, ema26, ema50, rsi: rsiV, atr: atrV, atrPct: atrV / close * 100, vwap, macd: macdV, volumeRatio: volR, score };
  }

  function buildTF() { Object.keys(DB).forEach(k => { if (!DB[k].tfData) DB[k].tfData = {}; }); }
  function sync1D(coin, data) { coin.prices = data.prices; coin.ohlc = data.ohlc; coin.volumes = data.volumes; }

  function scoreSnapshot(ohlc, volumes) {
    if (ohlc.length < 60) return 0;
    return tfMetrics({ prices: ohlc.map(x => x.c), ohlc, volumes })?.score ?? 0;
  }

  function backtest30d(coin) {
    const d = coin.tfData?.['1D'];
    if (!d || d.prices.length < 75) return { pct: null, correct: 0, total: 0 };
    let correct = 0, total = 0;
    const start = Math.max(60, d.prices.length - 34);
    for (let i = start; i < d.prices.length - 3; i++) {
      const s = scoreSnapshot(d.ohlc.slice(0, i + 1), d.volumes.slice(0, i + 1));
      if (Math.abs(s) < 0.35) continue;
      const hit = s > 0 ? d.prices[i + 3] > d.prices[i] : d.prices[i + 3] < d.prices[i];
      total++; if (hit) correct++;
    }
    return { pct: total ? correct / total * 100 : null, correct, total };
  }

  function analyzeCoin(key, refreshAccuracy = false) {
    const coin = DB[key];
    if (!coin?.tfData?.['1D']) return;
    const metrics = {};
    for (const tf of Object.keys(TF_WEIGHTS)) metrics[tf] = tfMetrics(coin.tfData[tf]);
    const valid = Object.entries(metrics).filter(([, m]) => m);
    if (!valid.length) return;
    const weighted = valid.reduce((sum, [tf, m]) => sum + m.score * TF_WEIGHTS[tf], 0);
    const bull = valid.filter(([, m]) => m.score > 0.20).length;
    const bear = valid.filter(([, m]) => m.score < -0.20).length;
    const agreement = Math.max(bull, bear) / valid.length;
    const daily = metrics['1D'] || valid[valid.length - 1][1];
    const current = daily.close, swing = structure(coin.tfData['1D'].ohlc, 40), atrV = daily.atr;

    let signal = 'HOLD / WAIT';
    if (weighted >= 0.35 && bull >= 3) signal = 'STRONG BUY';
    else if (weighted >= 0.20 && bull >= 3) signal = 'ACCUMULATE';
    else if (weighted <= -0.35 && bear >= 3) signal = 'STRONG SELL';
    else if (weighted <= -0.20 && bear >= 3) signal = 'REDUCE / SELL';
    if ((signal.includes('BUY') || signal === 'ACCUMULATE') && (daily.rsi > 78 || daily.atrPct > 9)) signal = 'HOLD / WAIT';
    if ((signal.includes('SELL') || signal === 'REDUCE / SELL') && (daily.rsi < 22 || daily.atrPct > 9)) signal = 'HOLD / WAIT';

    let entry = current, stop = current, target = current;
    if (signal.includes('BUY') || signal === 'ACCUMULATE') {
      stop = Math.min(swing.low - atrV * 0.20, current - atrV * 1.25);
      const risk = current - stop;
      target = current + risk * 2;
      if (swing.high > current && swing.high < target) target = swing.high;
      if (risk <= 0 || (target - current) / risk < 1.6) signal = 'HOLD / WAIT';
    } else if (signal.includes('SELL') || signal === 'REDUCE / SELL') {
      stop = Math.max(swing.high + atrV * 0.20, current + atrV * 1.25);
      const risk = stop - current;
      target = current - risk * 2;
      if (swing.low < current && swing.low > target) target = swing.low;
      if (risk <= 0 || (current - target) / risk < 1.6) signal = 'HOLD / WAIT';
    } else {
      stop = Math.min(swing.low, current - atrV);
      target = Math.max(swing.high, current + atrV);
    }

    let confidence = 50 + Math.abs(weighted) * 36 + agreement * 10;
    if (signal === 'HOLD / WAIT') confidence = Math.min(confidence, 59);
    confidence = clamp(confidence, 50, 88);
    const accuracy = refreshAccuracy ? backtest30d(coin) : (coin.analysis?.accuracy || backtest30d(coin));

    coin.rsi = daily.rsi;
    coin.sma20 = ema(coin.tfData['1D'].prices, 20);
    coin.macd = daily.macd.hist > 0 ? 'BULLISH MOMENTUM' : daily.macd.hist < 0 ? 'BEARISH MOMENTUM' : 'NEUTRAL';
    coin.trendStatus = daily.ema12 > daily.ema26 && current > daily.ema50 ? 'UPTREND (1D)' : daily.ema12 < daily.ema26 && current < daily.ema50 ? 'DOWNTREND (1D)' : 'KONSOLIDASI';
    coin.signal = signal;
    coin.confidencePct = confidence;
    coin.confidenceStr = signal.includes('SELL') ? `${(100 - confidence).toFixed(1)}% BEARISH` : signal === 'HOLD / WAIT' ? `${confidence.toFixed(1)}% NETRAL` : `${confidence.toFixed(1)}% BULLISH`;
    coin.confidenceColor = signal.includes('SELL') ? 'text-cryptoRed' : signal === 'HOLD / WAIT' ? 'text-cryptoYellow' : 'text-cryptoGreen';
    coin.res2 = swing.high;
    coin.res1 = signal.includes('SELL') ? entry : target;
    coin.sup1 = entry;
    coin.sup2 = stop;
    coin.analysis = { weightedScore: weighted, timeframeMetrics: metrics, entry, stop, target, rr: Math.abs(target - entry) / Math.max(Math.abs(stop - entry), 1e-12), atr: atrV, atrPct: daily.atrPct, vwap: daily.vwap, swingHigh: swing.high, swingLow: swing.low, agreement, accuracy, updatedAt: Date.now() };
  }

  function analyzeAll(refreshAccuracy = false) { buildTF(); Object.keys(DB).forEach(k => analyzeCoin(k, refreshAccuracy)); }

  async function fetchJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  async function loadHistory(key, tf) {
    const coin = DB[key], interval = BINANCE_INTERVALS[tf];
    if (!coin || !interval) return;
    const rows = await fetchJson(`/klines?symbol=${coin.binanceSymbol}&interval=${interval}&limit=${HISTORY_LIMITS[tf]}`);
    const prices = [], ohlc = [], volumes = [], times = [];
    for (const r of rows) { times.push(+r[0]); ohlc.push({ o:+r[1], h:+r[2], l:+r[3], c:+r[4] }); prices.push(+r[4]); volumes.push(+r[5]); }
    coin.tfData[tf] = { prices, ohlc, volumes, times };
    if (tf === '1D') sync1D(coin, coin.tfData[tf]);
  }

  async function loadInitialData() {
    buildTF();
    const current = typeof currentCoin !== 'undefined' ? currentCoin : Object.keys(DB)[0];
    await Promise.allSettled(Object.keys(DB).map(k => loadHistory(k, '1D')));
    await Promise.allSettled(['15M', '1H', '4H'].map(tf => loadHistory(current, tf)));
    analyzeAll(true);
    if (typeof updateDashboard === 'function') updateDashboard();
    if (typeof updateMultiGrid === 'function') updateMultiGrid();
    refreshMainChart(current);
    setConnectionStatus('online', 'Live Binance WS');
  }

  function labelForTimestamp(ts) { return new Date(ts).toLocaleDateString('id-ID', { day:'2-digit', month:'short' }); }
  function refreshMainChart(key) {
    if (!mainChartInstance || !DB[key]?.tfData?.['1D']) return;
    const d = DB[key].tfData['1D'];
    mainChartInstance.data.labels = d.times.map(labelForTimestamp);
    if (mainChartInstance.data.datasets[0]) mainChartInstance.data.datasets[0].data = d.ohlc.map(x => [x.o, x.c]);
    if (mainChartInstance.data.datasets[1]) mainChartInstance.data.datasets[1].data = emaSeries(d.prices, 20);
    mainChartInstance.currentLivePrice = DB[key].price;
    mainChartInstance.currentLivePriceStr = formatPrice(DB[key].price, key);
    mainChartInstance.update('none');
  }

  function refreshGridChart(key) {
    const boxId = Object.keys(gridRenderedCoins || {}).find(k => gridRenderedCoins[k] === key);
    if (!boxId || !gridChartInstances[boxId] || !DB[key]?.tfData?.['1D']) return;
    const d = DB[key].tfData['1D'], chart = gridChartInstances[boxId];
    chart.data.labels = d.times.map(labelForTimestamp);
    chart.data.datasets[0].data = d.ohlc.map(x => [x.o, x.c]);
    chart.update('none');
  }

  function applyTicker(t) {
    const key = Object.keys(DB).find(k => DB[k].binanceSymbol === t.s);
    if (!key) return;
    const coin = DB[key], old = coin.price;
    coin.price = +t.c; coin.change24h = +t.P; coin.volume24h = +t.v; coin.quoteVolume24h = +t.q;
    if (typeof updateTickerUI === 'function') updateTickerUI(key, coin.price, old);
    if (typeof updateCoinSelectorsUI === 'function') updateCoinSelectorsUI();
    const d = coin.tfData?.['1D'];
    if (d?.ohlc?.length) {
      const i = d.ohlc.length - 1; d.ohlc[i].c = coin.price; d.ohlc[i].h = Math.max(d.ohlc[i].h, coin.price); d.ohlc[i].l = Math.min(d.ohlc[i].l, coin.price); d.prices[i] = coin.price; sync1D(coin, d); analyzeCoin(key, false);
    }
    if (typeof currentCoin !== 'undefined' && key === currentCoin) { if (typeof updateDashboard === 'function') updateDashboard(); if (typeof updateMainChartLivePrice === 'function') updateMainChartLivePrice(coin.price); refreshMainChart(key); }
    refreshGridChart(key);
  }

  function applyKline(payload) {
    const k = payload.k;
    const key = Object.keys(DB).find(x => DB[x].binanceSymbol === k.s);
    if (!key) return;
    const tf = Object.keys(BINANCE_INTERVALS).find(x => BINANCE_INTERVALS[x] === k.i);
    if (!tf) return;
    const coin = DB[key]; if (!coin.tfData) coin.tfData = {};
    if (!coin.tfData[tf]) coin.tfData[tf] = { prices:[], ohlc:[], volumes:[], times:[] };
    const d = coin.tfData[tf], start = +k.t, bar = { o:+k.o, h:+k.h, l:+k.l, c:+k.c }, vol = +k.v;
    if (!d.times.length || d.times[d.times.length - 1] !== start) { d.times.push(start); d.ohlc.push(bar); d.prices.push(bar.c); d.volumes.push(vol); while (d.times.length > HISTORY_LIMITS[tf]) { d.times.shift(); d.ohlc.shift(); d.prices.shift(); d.volumes.shift(); } }
    else { const i = d.times.length - 1; d.ohlc[i] = bar; d.prices[i] = bar.c; d.volumes[i] = vol; }
    if (tf === '1D') { sync1D(coin, d); coin.price = bar.c; analyzeCoin(key, false); if (typeof currentCoin !== 'undefined' && key === currentCoin) refreshMainChart(key); refreshGridChart(key); }
    else { analyzeCoin(key, false); if (typeof currentCoin !== 'undefined' && key === currentCoin && typeof updateDashboard === 'function') updateDashboard(); }
  }

  function subscribeCurrentAnalysis() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const key = typeof currentCoin !== 'undefined' ? currentCoin : 'BTC';
    const s = DB[key].binanceSymbol.toLowerCase();
    const next = [`${s}@kline_15m`, `${s}@kline_1h`, `${s}@kline_4h`];
    const add = next.filter(x => !currentSubscribedKlines.includes(x));
    const remove = currentSubscribedKlines.filter(x => !next.includes(x));
    if (remove.length) ws.send(JSON.stringify({ method:'UNSUBSCRIBE', params:remove, id:Date.now()%1000000 }));
    if (add.length) ws.send(JSON.stringify({ method:'SUBSCRIBE', params:add, id:Date.now()%1000000 }));
    currentSubscribedKlines = next;
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer); wsBaseIndex = (wsBaseIndex + 1) % WS_BASES.length; reconnectAttempt++;
    setConnectionStatus('connecting', 'Reconnect Binance WS...');
    reconnectTimer = setTimeout(connectWS, Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt, 5)));
  }

  function connectWS() {
    if (destroyed || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    const streams = ['!ticker@arr', ...Object.values(DB).map(c => `${c.binanceSymbol.toLowerCase()}@kline_1d`)].join('/');
    const url = `${WS_BASES[wsBaseIndex]}?streams=${encodeURIComponent(streams)}`;
    try { ws = new WebSocket(url); } catch (_) { scheduleReconnect(); return; }
    wsStartedAt = Date.now();
    ws.onopen = () => { reconnectAttempt = 0; setConnectionStatus('online', 'Live Binance WS'); subscribeCurrentAnalysis(); clearInterval(healthTimer); healthTimer = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN && Date.now()-wsStartedAt > 22*60*60*1000) { try { ws.close(); } catch (_) {} } }, 60000); };
    ws.onmessage = e => { try { const msg = JSON.parse(e.data), data = msg.data ?? msg; if (Array.isArray(data)) data.forEach(applyTicker); else if (data.e === 'kline') applyKline(data); } catch (err) { console.warn('Binance WS parse error', err); } };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
    ws.onclose = () => { ws = null; scheduleReconnect(); };
  }

  async function restHealth() {
    if (Date.now() - lastRestHealth < 15000) return;
    lastRestHealth = Date.now();
    try { const k = Object.keys(DB)[0]; applyTicker(await fetchJson(`/ticker/24hr?symbol=${DB[k].binanceSymbol}`)); if (!ws || ws.readyState !== WebSocket.OPEN) setConnectionStatus('online', 'Live Binance REST'); }
    catch (_) { if (!ws || ws.readyState !== WebSocket.OPEN) setConnectionStatus('fallback', 'Menunggu koneksi Binance...'); }
  }

  function dashboardOverride() {
    if (originalUpdateDashboard) originalUpdateDashboard();
    const coin = DB[typeof currentCoin !== 'undefined' ? currentCoin : Object.keys(DB)[0]], a = coin?.analysis;
    if (!coin || !a) return;
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.innerText = text; };
    set('calc-entry', formatPrice(a.entry, coin.symbol)); set('calc-tp', formatPrice(a.target, coin.symbol)); set('calc-sl', formatPrice(a.stop, coin.symbol));
    const risk = Math.abs(a.entry - a.stop), reward = Math.abs(a.target - a.entry), rr = risk > 0 ? reward / risk : 0;
    set('risk-reward-ratio', rr ? `1 : ${rr.toFixed(2)}` : '--'); set('risk-loss-pct', a.entry ? `${(risk/a.entry*100).toFixed(2)}%` : '--'); set('risk-profit-pct', a.entry ? `${(reward/a.entry*100).toFixed(2)}%` : '--');
    set('risk-allocation', `${(risk > 0 ? Math.min(2/(risk/a.entry*100)*100,100) : 100).toFixed(1)}% Modal`);
    const acc = a.accuracy || { pct:null, correct:0, total:0 }; set('ai-accuracy-pct', acc.pct == null ? '--%' : `${acc.pct.toFixed(0)}%`); set('ai-accuracy-fraction', acc.total ? `${acc.correct}/${acc.total} Prediksi Tepat` : 'Data belum cukup'); const bar = document.getElementById('ai-accuracy-bar'); if (bar) bar.style.width = `${clamp(acc.pct ?? 0,0,100)}%`;
    set('trend-desc', `${a.weightedScore > 0 ? 'Bullish' : a.weightedScore < 0 ? 'Bearish' : 'Netral'}. Konfirmasi MTF ${(a.agreement*100).toFixed(0)}%, ATR ${a.atrPct.toFixed(2)}%, VWAP ${formatPrice(a.vwap, coin.symbol)}.`);
    set('adv-rsi-val', `RSI 1D ${coin.rsi.toFixed(1)} • Score ${(a.weightedScore*100).toFixed(0)}`); set('adv-target-break', formatPrice(a.target, coin.symbol));
    if (coin.signal.includes('BUY')) { set('action-step-1', `LONG: entry sekitar ${formatPrice(a.entry,coin.symbol)} setelah konfirmasi momentum.`); set('action-step-2', `SL di ${formatPrice(a.stop,coin.symbol)} berbasis ATR + struktur.`); set('action-step-3', `TP sekitar ${formatPrice(a.target,coin.symbol)} dengan R/R ${rr.toFixed(2)}.`); }
    else if (coin.signal.includes('SELL')) { set('action-step-1', `SHORT: entry sekitar ${formatPrice(a.entry,coin.symbol)} setelah konfirmasi.`); set('action-step-2', `SL di ${formatPrice(a.stop,coin.symbol)}. Hindari entry tanpa breakdown.`); set('action-step-3', `TP sekitar ${formatPrice(a.target,coin.symbol)} dengan R/R ${rr.toFixed(2)}.`); }
    else { set('action-step-1', 'NO TRADE: konfirmasi lintas timeframe belum cukup kuat.'); set('action-step-2', `Tunggu struktur dan momentum lebih jelas di sekitar ${formatPrice(a.entry,coin.symbol)}.`); set('action-step-3', 'Jangan memaksakan posisi saat R/R atau konfirmasi MTF tidak memenuhi filter.'); }
    const s = document.getElementById('adv-skenario-text'); if (s) s.innerText = `Model MTF: ${coin.signal} • confidence ${coin.confidencePct.toFixed(1)}%. Bobot 15M 10%, 1H 20%, 4H 30%, 1D 40%.`;
  }

  globalThis.fetchBinanceData = fetchJson;
  globalThis.fetchHistoricalKlines = async (key, tf) => { await loadHistory(key, tf); analyzeCoin(key,false); if (tf==='1D' && typeof currentCoin!=='undefined' && key===currentCoin) { if (typeof updateMainChart==='function') updateMainChart(key); if (typeof updateDashboard==='function') updateDashboard(); refreshMainChart(key); } return key; };
  globalThis.calculateTechnicalIndicatorsWeekly = key => analyzeCoin(key,false);
  globalThis.updateDashboard = dashboardOverride;
  globalThis.startRestPolling = () => { clearInterval(updateIntervalId); updateIntervalId = setInterval(() => { if (!ws || ws.readyState !== WebSocket.OPEN) restHealth(); }, 5000); };
  globalThis.startFallbackSimulation = () => setConnectionStatus('fallback', 'Live data offline — menunggu Binance');
  globalThis.initRealTimeData = async () => { setConnectionStatus('connecting','Memuat data Binance...'); try { await loadInitialData(); connectWS(); globalThis.startRestPolling(); } catch (e) { console.error('CryptoScan Pro engine init failed',e); setConnectionStatus('fallback','Menunggu koneksi Binance...'); globalThis.startRestPolling(); connectWS(); } };

  if (originalSelectCoin) globalThis.selectCoin = async key => { await originalSelectCoin(key); if (ws && ws.readyState===WebSocket.OPEN) subscribeCurrentAnalysis(); try { await Promise.allSettled(['15M','1H','4H'].map(tf=>loadHistory(key,tf))); analyzeCoin(key,true); dashboardOverride(); } catch (_) {} };

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (!ws || ws.readyState !== WebSocket.OPEN) connectWS(); restHealth(); const key=typeof currentCoin!=='undefined'?currentCoin:Object.keys(DB)[0]; loadHistory(key,'1D').then(()=>{analyzeCoin(key,false);dashboardOverride();refreshMainChart(key);}).catch(()=>{}); } });
  window.addEventListener('beforeunload',()=>{destroyed=true;clearTimeout(reconnectTimer);clearInterval(healthTimer);clearInterval(updateIntervalId);if(ws)try{ws.close();}catch(_) {}});
})();