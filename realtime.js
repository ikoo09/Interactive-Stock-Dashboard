/*
 * CryptoScan Pro - Safe realtime market layer
 * Keeps the existing dashboard/chart untouched.
 * Ticker handling is deliberately minimal: update price, color and a
 * short non-layout-shifting flash only when the displayed number changes.
 */
(() => {
  'use strict';

  const STREAM_BASE = 'wss://stream.binance.com:9443/stream?streams=';
  const FLASH_COOLDOWN_MS = 5000;
  const FLASH_DURATION_MS = 450;

  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let lastMessageAt = 0;
  let lastDashboardRefresh = 0;

  function getCoins() {
    try {
      return (typeof cryptoDatabase !== 'undefined' && cryptoDatabase && typeof cryptoDatabase === 'object') ? cryptoDatabase : null;
    } catch (_) { return null; }
  }

  function getCurrentCoin() {
    try { return typeof currentCoin !== 'undefined' ? currentCoin : ''; } catch (_) { return ''; }
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function formatLivePrice(price) {
    if (!Number.isFinite(price)) return '--';
    if (price < 1) return price.toFixed(5);
    if (price < 1000) return price.toFixed(2);
    return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function setStatus(text) {
    const el = document.getElementById('status-text');
    if (el) el.textContent = text;
  }

  function normalizeKey(symbol) {
    return String(symbol || '').toUpperCase().replace(/USDT$/, '');
  }

  function applyStableTickerLayout() {
    const headerInner = document.querySelector('header > div');
    const tickerBox = document.getElementById('ticker-container-BTC')?.parentElement;
    const brand = headerInner?.children?.[0];
    const status = headerInner?.children?.[2];

    if (!headerInner || !tickerBox) return;

    // Keep the header on one row. The ticker itself becomes the flexible,
    // horizontally scrollable area instead of wrapping downward.
    headerInner.style.flexWrap = 'nowrap';
    headerInner.style.alignItems = 'center';
    headerInner.style.minWidth = '0';

    if (brand) brand.style.flexShrink = '0';
    if (status) status.style.flexShrink = '0';

    tickerBox.style.flex = '1 1 auto';
    tickerBox.style.minWidth = '0';
    tickerBox.style.maxWidth = 'none';
    tickerBox.style.display = 'flex';
    tickerBox.style.flexWrap = 'nowrap';
    tickerBox.style.alignItems = 'center';
    tickerBox.style.overflowX = 'auto';
    tickerBox.style.overflowY = 'hidden';
    tickerBox.style.whiteSpace = 'nowrap';
    tickerBox.style.scrollbarWidth = 'none';

    Array.from(tickerBox.children).forEach(child => {
      child.style.flexShrink = '0';
      child.style.whiteSpace = 'nowrap';
    });

    Object.keys(getCoins() || {}).forEach(key => {
      const price = document.getElementById(`ticker-${key}`);
      if (!price) return;
      price.style.display = 'inline-block';
      price.style.whiteSpace = 'nowrap';
      price.style.minWidth = '0';
      price.style.overflow = 'visible';
      price.style.backgroundColor = 'transparent';
      price.style.border = '0';
      price.style.boxShadow = 'none';
    });
  }

  function clearFlashStyles(ticker, baseColor) {
    if (!ticker) return;
    ticker.style.backgroundColor = 'transparent';
    ticker.style.boxShadow = 'none';
    ticker.style.textShadow = 'none';
    ticker.style.color = baseColor;
  }

  function flashTicker(ticker, direction) {
    if (!ticker || direction === 'neutral') return;

    const up = direction === 'up';
    const baseColor = up ? '#0ECB81' : '#F6465D';
    const glow = up ? 'rgba(14,203,129,.55)' : 'rgba(246,70,93,.55)';

    clearFlashStyles(ticker, baseColor);
    ticker.style.transition = `background-color ${FLASH_DURATION_MS}ms ease, box-shadow ${FLASH_DURATION_MS}ms ease, color ${FLASH_DURATION_MS}ms ease`;
    ticker.style.backgroundColor = up ? 'rgba(14,203,129,.16)' : 'rgba(246,70,93,.16)';
    ticker.style.boxShadow = `0 0 8px ${glow}`;
    ticker.style.borderRadius = '4px';

    window.setTimeout(() => {
      clearFlashStyles(ticker, baseColor);
    }, FLASH_DURATION_MS);
  }

  function refreshAnalysis(key, forceDashboard = false) {
    if (typeof calculateTechnicalIndicatorsWeekly === 'function') {
      try { calculateTechnicalIndicatorsWeekly(key); } catch (_) {}
    }
    const now = Date.now();
    if (
      getCurrentCoin() === key &&
      typeof updateDashboard === 'function' &&
      (forceDashboard || now - lastDashboardRefresh > 1200)
    ) {
      lastDashboardRefresh = now;
      try { updateDashboard(); } catch (_) {}
    }
  }

  function updateTicker(symbol, price, changePct) {
    const key = normalizeKey(symbol);
    const coins = getCoins();
    if (!coins || !coins[key] || !Number.isFinite(price)) return;

    applyStableTickerLayout();

    const coin = coins[key];
    const previousRawPrice = Number(coin._lastRealtimePrice);
    const previousDisplayed = typeof coin._lastDisplayedPrice === 'string' ? coin._lastDisplayedPrice : null;
    const displayPrice = formatLivePrice(price);
    const displayChanged = previousDisplayed !== null && displayPrice !== previousDisplayed;
    const direction = Number.isFinite(previousRawPrice)
      ? (price > previousRawPrice ? 'up' : price < previousRawPrice ? 'down' : 'neutral')
      : 'neutral';

    coin.price = price;
    if (Number.isFinite(changePct)) coin.change24h = changePct;

    if (Array.isArray(coin.ohlc) && coin.ohlc.length) {
      const i = coin.ohlc.length - 1;
      const candle = coin.ohlc[i];
      candle.c = price;
      candle.h = Math.max(candle.h, price);
      candle.l = Math.min(candle.l, price);
      if (Array.isArray(coin.prices) && coin.prices.length) {
        coin.prices[coin.prices.length - 1] = price;
      }
    }

    const ticker = document.getElementById(`ticker-${key}`);
    setText(`ticker-${key}`, displayPrice);

    if (ticker) {
      const baseColor = direction === 'up' ? '#0ECB81' : direction === 'down' ? '#F6465D' : '#D1D5DB';
      ticker.style.color = baseColor;
      ticker.style.backgroundColor = 'transparent';
      ticker.style.boxShadow = 'none';
      ticker.style.textShadow = 'none';

      const now = Date.now();
      const cooldownReady = !Number.isFinite(coin._lastFlashAt) || now - coin._lastFlashAt >= FLASH_COOLDOWN_MS;
      if (displayChanged && direction !== 'neutral' && cooldownReady) {
        flashTicker(ticker, direction);
        coin._lastFlashAt = now;
      }
    }

    coin._lastRealtimePrice = price;
    coin._lastDisplayedPrice = displayPrice;

    refreshAnalysis(key, false);

    if (getCurrentCoin() === key) {
      if (typeof updateMainChartLivePrice === 'function') {
        try { updateMainChartLivePrice(price); } catch (_) {}
      }
      setText('adv-coin-price', displayPrice);
      setText('adv-coin-change', `${changePct >= 0 ? '▲' : '▼'} ${Math.abs(changePct || 0).toFixed(2)}%`);
    }

    if (typeof updateGridChartLivePrice === 'function') {
      try { updateGridChartLivePrice(key, price); } catch (_) {}
    }
  }

  function updateDailyKline(symbol, k) {
    const key = normalizeKey(symbol);
    const coins = getCoins();
    if (!coins || !coins[key] || !k) return;

    const coin = coins[key];
    const candle = {
      o: Number(k.o),
      h: Number(k.h),
      l: Number(k.l),
      c: Number(k.c),
      volume: Number(k.v)
    };
    if (!Number.isFinite(candle.c)) return;

    if (!Array.isArray(coin.ohlc)) coin.ohlc = [];
    if (!Array.isArray(coin.prices)) coin.prices = [];
    if (!Array.isArray(coin.volumes)) coin.volumes = [];

    const lastIndex = coin.ohlc.length - 1;
    if (lastIndex >= 0) {
      coin.ohlc[lastIndex] = {
        ...coin.ohlc[lastIndex],
        o: candle.o,
        h: candle.h,
        l: candle.l,
        c: candle.c
      };
      coin.prices[lastIndex] = candle.c;
      coin.volumes[lastIndex] = candle.volume;
    }

    coin.price = candle.c;
    refreshAnalysis(key, k.x === true);

    if (getCurrentCoin() === key && typeof updateMainChartLivePrice === 'function') {
      try { updateMainChartLivePrice(candle.c); } catch (_) {}
    }
    if (typeof updateGridChartLivePrice === 'function') {
      try { updateGridChartLivePrice(key, candle.c); } catch (_) {}
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempt, 5)));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) return;
    const coins = getCoins();
    if (!coins) {
      setTimeout(connect, 1000);
      return;
    }

    const symbols = Object.values(coins)
      .map(c => String(c.binanceSymbol || '').toLowerCase())
      .filter(Boolean);
    if (!symbols.length) return;

    const streams = [];
    symbols.forEach(symbol => {
      streams.push(`${symbol}@ticker`);
      streams.push(`${symbol}@kline_1d`);
    });

    try { if (socket) socket.close(); } catch (_) {}

    setStatus('Live Binance');
    socket = new WebSocket(STREAM_BASE + streams.join('/'));

    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
      lastMessageAt = Date.now();
      setStatus('Live Binance');
      applyStableTickerLayout();
    });

    socket.addEventListener('message', event => {
      lastMessageAt = Date.now();
      try {
        const packet = JSON.parse(event.data);
        const data = packet && packet.data ? packet.data : packet;
        if (!data || !data.e) return;
        if (data.e === '24hrTicker') updateTicker(data.s, Number(data.c), Number(data.P));
        else if (data.e === 'kline' && data.k && data.k.i === '1d') updateDailyKline(data.s, data.k);
      } catch (_) {}
    });

    socket.addEventListener('error', () => {
      setStatus('Reconnect Binance...');
      try { socket.close(); } catch (_) {}
    });

    socket.addEventListener('close', () => {
      if (stopped) return;
      reconnectAttempt += 1;
      setStatus('Reconnect Binance...');
      scheduleReconnect();
    });
  }

  function visibilityRecovery() {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastMessageAt > 15000 || !socket || socket.readyState !== WebSocket.OPEN) {
      reconnectAttempt = 0;
      connect();
    }
  }

  function boot() {
    applyStableTickerLayout();
    window.addEventListener('resize', applyStableTickerLayout, { passive: true });

    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      applyStableTickerLayout();
      if (getCoins()) {
        clearInterval(timer);
        connect();
      } else if (tries >= 30) {
        clearInterval(timer);
      }
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
