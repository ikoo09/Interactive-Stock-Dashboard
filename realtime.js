/*
 * CryptoScan Pro - Safe realtime market layer.
 * The top ticker keeps all 7 coins visible in fixed slots.
 * Only price color changes: green up, red down, yellow neutral.
 */
(() => {
  'use strict';

  const STREAM_BASE = 'wss://stream.binance.com:9443/stream?streams=';
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let lastMessageAt = 0;
  let lastDashboardRefresh = 0;
  let styleInjected = false;

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

  function injectTickerStyle() {
    if (styleInjected || document.getElementById('cryptoscan-ticker-stable-style')) return;
    const style = document.createElement('style');
    style.id = 'cryptoscan-ticker-stable-style';
    style.textContent = `
      @media (min-width: 1024px) {
        header > div:first-child {
          flex-wrap: nowrap !important;
          align-items: center !important;
          min-width: 0 !important;
        }

        /* Brand and live-status keep their natural width. */
        header > div:first-child > div:first-child,
        header > div:first-child > div:last-child {
          flex: 0 0 auto !important;
          flex-shrink: 0 !important;
        }

        /* Compact fixed ticker area so all 7 coins fit without clipping XRP. */
        header > div:first-child > div:nth-child(2) {
          flex: 0 0 760px !important;
          width: 760px !important;
          min-width: 760px !important;
          max-width: 760px !important;
          overflow: hidden !important;
          display: flex !important;
          flex-wrap: nowrap !important;
          align-items: center !important;
          white-space: nowrap !important;
          box-sizing: border-box !important;
        }

        header > div:first-child > div:nth-child(2) > div {
          width: 760px !important;
          min-width: 760px !important;
          max-width: 760px !important;
          display: flex !important;
          flex-wrap: nowrap !important;
          justify-content: flex-start !important;
          align-items: center !important;
          overflow: hidden !important;
          white-space: nowrap !important;
          gap: 4px !important;
          box-sizing: border-box !important;
        }

        /* Every coin gets the same fixed slot. */
        header > div:first-child > div:nth-child(2) > div[id^="ticker-container-"] {
          flex: 0 0 100px !important;
          width: 100px !important;
          min-width: 100px !important;
          max-width: 100px !important;
          height: 30px !important;
          margin: 0 !important;
          padding: 0 4px 0 8px !important;
          box-sizing: border-box !important;
          display: flex !important;
          flex-wrap: nowrap !important;
          align-items: center !important;
          justify-content: flex-start !important;
          gap: 4px !important;
          overflow: hidden !important;
          white-space: nowrap !important;
        }

        header > div:first-child > div:nth-child(2) > div.w-px {
          flex: 0 0 1px !important;
          width: 1px !important;
          min-width: 1px !important;
          max-width: 1px !important;
          height: 16px !important;
          margin: 0 !important;
        }

        header > div:first-child > div:nth-child(2) > div[id^="ticker-container-"] > span:first-child {
          flex: 0 0 28px !important;
          width: 28px !important;
          min-width: 28px !important;
          max-width: 28px !important;
          overflow: visible !important;
          white-space: nowrap !important;
          text-align: left !important;
        }

        header > div:first-child > div:nth-child(2) > div[id^="ticker-container-"] > span[id^="ticker-"] {
          flex: 0 0 auto !important;
          width: auto !important;
          min-width: 0 !important;
          max-width: none !important;
          display: inline-block !important;
          overflow: visible !important;
          white-space: nowrap !important;
          text-align: left !important;
          box-sizing: border-box !important;
          background: transparent !important;
          border: 0 !important;
          box-shadow: none !important;
          text-shadow: none !important;
          animation: none !important;
          transition: none !important;
        }
      }

      #ticker-BTC, #ticker-ETH, #ticker-SOL, #ticker-BNB,
      #ticker-DOGE, #ticker-TRX, #ticker-XRP {
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
        text-shadow: none !important;
        animation: none !important;
        transition: none !important;
        white-space: nowrap !important;
      }

      .cryptoscan-neutral { color: #F0B90B !important; }
      .cryptoscan-up { color: #0ECB81 !important; }
      .cryptoscan-down { color: #F6465D !important; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  function applyPriceColor(ticker, direction) {
    if (!ticker) return;
    ticker.classList.remove(
      'cryptoscan-neutral','cryptoscan-up','cryptoscan-down',
      'text-cryptoGreen','text-cryptoRed','text-cryptoYellow',
      'text-gray-300','text-green-400','text-red-400'
    );
    ticker.style.color = '';
    ticker.style.background = 'transparent';
    ticker.style.boxShadow = 'none';
    ticker.style.textShadow = 'none';
    ticker.style.animation = 'none';
    ticker.style.transition = 'none';
    ticker.classList.add(direction === 'up' ? 'cryptoscan-up' : direction === 'down' ? 'cryptoscan-down' : 'cryptoscan-neutral');
  }

  function refreshAnalysis(key, forceDashboard = false) {
    if (typeof calculateTechnicalIndicatorsWeekly === 'function') { try { calculateTechnicalIndicatorsWeekly(key); } catch (_) {} }
    const now = Date.now();
    if (getCurrentCoin() === key && typeof updateDashboard === 'function' && (forceDashboard || now - lastDashboardRefresh > 1200)) {
      lastDashboardRefresh = now;
      try { updateDashboard(); } catch (_) {}
    }
  }

  function updateTicker(symbol, price, changePct) {
    const key = normalizeKey(symbol);
    const coins = getCoins();
    if (!coins || !coins[key] || !Number.isFinite(price)) return;
    injectTickerStyle();

    const coin = coins[key];
    const previousPrice = Number(coin._lastRealtimePrice);
    const displayPrice = formatLivePrice(price);
    const ticker = document.getElementById(`ticker-${key}`);

    let direction = coin._tickerDirection || 'neutral';
    if (!Number.isFinite(previousPrice)) direction = 'neutral';
    else if (price > previousPrice) direction = 'up';
    else if (price < previousPrice) direction = 'down';

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
    applyPriceColor(ticker, direction);
    coin._lastRealtimePrice = price;
    coin._tickerDirection = direction;

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
    const candle = { o:Number(k.o), h:Number(k.h), l:Number(k.l), c:Number(k.c), volume:Number(k.v) };
    if (!Number.isFinite(candle.c)) return;
    if (!Array.isArray(coin.ohlc)) coin.ohlc = [];
    if (!Array.isArray(coin.prices)) coin.prices = [];
    if (!Array.isArray(coin.volumes)) coin.volumes = [];
    const lastIndex = coin.ohlc.length - 1;
    if (lastIndex >= 0) {
      coin.ohlc[lastIndex] = { ...coin.ohlc[lastIndex], o:candle.o, h:candle.h, l:candle.l, c:candle.c };
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
    socket.addEventListener('open', () => { reconnectAttempt = 0; lastMessageAt = Date.now(); setStatus('Live Binance'); injectTickerStyle(); });
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
    socket.addEventListener('error', () => { setStatus('Reconnect Binance...'); try { socket.close(); } catch (_) {} });
    socket.addEventListener('close', () => { if (stopped) return; reconnectAttempt += 1; setStatus('Reconnect Binance...'); scheduleReconnect(); });
  }

  function visibilityRecovery() {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastMessageAt > 15000 || !socket || socket.readyState !== WebSocket.OPEN) { reconnectAttempt = 0; connect(); }
  }

  function boot() {
    injectTickerStyle();
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      injectTickerStyle();
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