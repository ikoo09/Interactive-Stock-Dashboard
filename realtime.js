/*
 * CryptoScan Pro - Safe realtime market layer
 * Only updates the existing state/DOM/chart live-price hooks.
 */
(() => {
  'use strict';

  const STREAM_BASE = 'wss://stream.binance.com:9443/stream?streams=';
  const FLASH_COOLDOWN_MS = 5000;
  const FLASH_DURATION_MS = 700;
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let lastMessageAt = 0;
  let lastDashboardRefresh = 0;
  let layoutStyleInjected = false;

  function getCoins() {
    try { return (typeof cryptoDatabase !== 'undefined' && cryptoDatabase && typeof cryptoDatabase === 'object') ? cryptoDatabase : null; }
    catch (_) { return null; }
  }
  function getCurrentCoin() { try { return typeof currentCoin !== 'undefined' ? currentCoin : ''; } catch (_) { return ''; } }
  function setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
  function formatLivePrice(price) {
    if (!Number.isFinite(price)) return '--';
    if (price < 1) return price.toFixed(5);
    if (price < 1000) return price.toFixed(2);
    return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  function setStatus(text) { const el = document.getElementById('status-text'); if (el) el.textContent = text; }
  function normalizeKey(symbol) { return String(symbol || '').toUpperCase().replace(/USDT$/, ''); }

  function injectTickerLayoutFix() {
    if (layoutStyleInjected || document.getElementById('cryptoscan-ticker-fix')) return;
    const style = document.createElement('style');
    style.id = 'cryptoscan-ticker-fix';
    style.textContent = `
      @media (min-width: 1024px) {
        header > div:first-child {
          flex-wrap: nowrap !important;
          align-items: center !important;
          min-width: 0 !important;
        }
        header > div:first-child > div:first-child,
        header > div:first-child > div:last-child {
          flex-shrink: 0 !important;
        }
        header > div:first-child > div:nth-child(2) {
          flex: 1 1 0% !important;
          min-width: 0 !important;
          max-width: none !important;
          overflow: hidden !important;
        }
        header > div:first-child > div:nth-child(2) > div {
          flex-wrap: nowrap !important;
          min-width: 0 !important;
          width: 100% !important;
          overflow-x: auto !important;
          overflow-y: hidden !important;
          white-space: nowrap !important;
          scrollbar-width: none !important;
        }
        header > div:first-child > div:nth-child(2) > div::-webkit-scrollbar {
          display: none !important;
        }
        header > div:first-child > div:nth-child(2) > div > div {
          flex: 0 0 auto !important;
          white-space: nowrap !important;
        }
      }

      .ticker-price-up,
      .ticker-price-down {
        transition: color 180ms ease, text-shadow 180ms ease;
      }
      .ticker-price-up { color: #0ECB81 !important; }
      .ticker-price-down { color: #F6465D !important; }
      .ticker-price-neutral { color: #D1D5DB !important; }

      @keyframes cryptoscan-ticker-flash-up {
        0% { color: #0ECB81; text-shadow: 0 0 0 rgba(14,203,129,0); }
        25% { color: #FFFFFF; text-shadow: 0 0 10px rgba(14,203,129,.95); }
        100% { color: #0ECB81; text-shadow: 0 0 0 rgba(14,203,129,0); }
      }
      @keyframes cryptoscan-ticker-flash-down {
        0% { color: #F6465D; text-shadow: 0 0 0 rgba(246,70,93,0); }
        25% { color: #FFFFFF; text-shadow: 0 0 10px rgba(246,70,93,.95); }
        100% { color: #F6465D; text-shadow: 0 0 0 rgba(246,70,93,0); }
      }
      .ticker-flash-up { animation: cryptoscan-ticker-flash-up ${FLASH_DURATION_MS}ms ease-out; }
      .ticker-flash-down { animation: cryptoscan-ticker-flash-down ${FLASH_DURATION_MS}ms ease-out; }
      @media (prefers-reduced-motion: reduce) {
        .ticker-flash-up, .ticker-flash-down { animation: none !important; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    layoutStyleInjected = true;
  }

  function refreshAnalysis(key, forceDashboard = false) {
    if (typeof calculateTechnicalIndicatorsWeekly === 'function') {
      try { calculateTechnicalIndicatorsWeekly(key); } catch (_) {}
    }
    const now = Date.now();
    if (getCurrentCoin() === key && typeof updateDashboard === 'function' && (forceDashboard || now - lastDashboardRefresh > 1200)) {
      lastDashboardRefresh = now;
      try { updateDashboard(); } catch (_) {}
    }
  }

  function applyTickerVisual(ticker, direction, shouldFlash) {
    if (!ticker) return;
    ticker.classList.remove('ticker-price-neutral', 'ticker-price-up', 'ticker-price-down', 'ticker-flash-up', 'ticker-flash-down');
    if (direction === 'up') ticker.classList.add('ticker-price-up');
    else if (direction === 'down') ticker.classList.add('ticker-price-down');
    else ticker.classList.add('ticker-price-neutral');

    if (!shouldFlash || direction === 'neutral') return;
    void ticker.offsetWidth;
    ticker.classList.add(direction === 'up' ? 'ticker-flash-up' : 'ticker-flash-down');
    window.setTimeout(() => {
      ticker.classList.remove('ticker-flash-up', 'ticker-flash-down');
    }, FLASH_DURATION_MS + 40);
  }

  function updateTicker(symbol, price, changePct) {
    const key = normalizeKey(symbol);
    const coins = getCoins();
    if (!coins || !coins[key] || !Number.isFinite(price)) return;
    const coin = coins[key];
    const previousRawPrice = Number(coin._lastRealtimePrice);
    const previousVisualPrice = Number(coin._lastVisualPrice);
    const previousDisplayed = typeof coin._lastDisplayedPrice === 'string' ? coin._lastDisplayedPrice : null;
    const displayPrice = formatLivePrice(price);
    const displayChanged = previousDisplayed !== null && displayPrice !== previousDisplayed;

    coin.price = price;
    if (Number.isFinite(changePct)) coin.change24h = changePct;

    if (Array.isArray(coin.ohlc) && coin.ohlc.length) {
      const i = coin.ohlc.length - 1;
      const candle = coin.ohlc[i];
      candle.c = price;
      candle.h = Math.max(candle.h, price);
      candle.l = Math.min(candle.l, price);
      if (Array.isArray(coin.prices) && coin.prices.length) coin.prices[coin.prices.length - 1] = price;
    }

    setText(`ticker-${key}`, displayPrice);
    const ticker = document.getElementById(`ticker-${key}`);
    const currentLiveDirection = Number.isFinite(previousRawPrice)
      ? (price > previousRawPrice ? 'up' : price < previousRawPrice ? 'down' : null)
      : null;
    const currentDirection = currentLiveDirection || coin._lastVisualDirection || 'neutral';

    if (ticker) {
      if (displayChanged && Number.isFinite(previousVisualPrice) && price !== previousVisualPrice) {
        const visualDirection = price > previousVisualPrice ? 'up' : 'down';
        const now = Date.now();
        const cooldownReady = !Number.isFinite(coin._lastFlashAt) || now - coin._lastFlashAt >= FLASH_COOLDOWN_MS;
        applyTickerVisual(ticker, visualDirection, cooldownReady);
        coin._lastVisualDirection = visualDirection;
        coin._lastVisualPrice = price;
        if (cooldownReady) coin._lastFlashAt = now;
      } else {
        applyTickerVisual(ticker, currentDirection, false);
        if (!Number.isFinite(coin._lastVisualPrice)) coin._lastVisualPrice = price;
        if (!coin._lastVisualDirection && currentLiveDirection) coin._lastVisualDirection = currentLiveDirection;
      }
    }

    coin._lastRealtimePrice = price;
    coin._lastDisplayedPrice = displayPrice;

    refreshAnalysis(key, false);

    if (getCurrentCoin() === key) {
      if (typeof updateMainChartLivePrice === 'function') { try { updateMainChartLivePrice(price); } catch (_) {} }
      setText('adv-coin-price', displayPrice);
      setText('adv-coin-change', `${changePct >= 0 ? '▲' : '▼'} ${Math.abs(changePct || 0).toFixed(2)}%`);
    }
    if (typeof updateGridChartLivePrice === 'function') { try { updateGridChartLivePrice(key, price); } catch (_) {} }
  }

  function updateDailyKline(symbol, k) {
    const key = normalizeKey(symbol);
    const coins = getCoins();
    if (!coins || !coins[key] || !k) return;
    const coin = coins[key];
    const candle = { o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), volume: Number(k.v) };
    if (!Number.isFinite(candle.c)) return;
    if (!Array.isArray(coin.ohlc)) coin.ohlc = [];
    if (!Array.isArray(coin.prices)) coin.prices = [];
    if (!Array.isArray(coin.volumes)) coin.volumes = [];
    const lastIndex = coin.ohlc.length - 1;
    if (lastIndex >= 0) {
      coin.ohlc[lastIndex] = { ...coin.ohlc[lastIndex], o: candle.o, h: candle.h, l: candle.l, c: candle.c };
      coin.prices[lastIndex] = candle.c;
      coin.volumes[lastIndex] = candle.volume;
    }
    coin.price = candle.c;
    refreshAnalysis(key, k.x === true);
    if (getCurrentCoin() === key && typeof updateMainChartLivePrice === 'function') { try { updateMainChartLivePrice(candle.c); } catch (_) {} }
    if (typeof updateGridChartLivePrice === 'function') { try { updateGridChartLivePrice(key, candle.c); } catch (_) {} }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempt, 5)));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect() {
    if (stopped) return;
    const coins = getCoins();
    if (!coins) { setTimeout(connect, 1000); return; }
    const symbols = Object.values(coins).map(c => String(c.binanceSymbol || '').toLowerCase()).filter(Boolean);
    if (!symbols.length) return;
    const streams = [];
    symbols.forEach(symbol => { streams.push(`${symbol}@ticker`); streams.push(`${symbol}@kline_1d`); });
    try { if (socket) socket.close(); } catch (_) {}
    setStatus('Live Binance');
    socket = new WebSocket(STREAM_BASE + streams.join('/'));
    socket.addEventListener('open', () => { reconnectAttempt = 0; lastMessageAt = Date.now(); setStatus('Live Binance'); });
    socket.addEventListener('message', event => {
      lastMessageAt = Date.now();
      try {
        const packet = JSON.parse(event.data); const data = packet && packet.data ? packet.data : packet;
        if (!data || !data.e) return;
        if (data.e === '24hrTicker') updateTicker(data.s, Number(data.c), Number(data.P));
        else if (data.e === 'kline' && data.k && data.k.i === '1d') updateDailyKline(data.s, data.k);
      } catch (_) {}
    });
    socket.addEventListener('error', () => { setStatus('Reconnect Binance...'); try { socket.close(); } catch (_) {} });
    socket.addEventListener('close', () => {
      if (stopped) return;
      reconnectAttempt += 1; setStatus('Reconnect Binance...'); scheduleReconnect();
    });
  }

  function visibilityRecovery() {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastMessageAt > 15000 || !socket || socket.readyState !== WebSocket.OPEN) {
      reconnectAttempt = 0; connect();
    }
  }

  function boot() {
    injectTickerLayoutFix();
    window.addEventListener('resize', injectTickerLayoutFix, { passive: true });
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      injectTickerLayoutFix();
      if (getCoins()) { clearInterval(timer); connect(); }
      else if (tries >= 30) clearInterval(timer);
    }, 500);
    document.addEventListener('visibilitychange', visibilityRecovery);
    window.addEventListener('online', connect);
  }

  window.addEventListener('beforeunload', () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { if (socket) socket.close(); } catch (_) {}
  });
  boot();
})();
