/*
 * CryptoScan Pro - Safe realtime market layer
 * This module only updates existing state/DOM/chart live-price hooks.
 * It never replaces the dashboard's original chart initialization.
 */
(() => {
  'use strict';

  const STREAM_BASE = 'wss://stream.binance.com:9443/stream?streams=';
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let lastMessageAt = 0;

  function getCoins() {
    return (window.cryptoDatabase && typeof window.cryptoDatabase === 'object')
      ? window.cryptoDatabase
      : null;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function formatLivePrice(price) {
    if (!Number.isFinite(price)) return '--';
    if (price < 1) return price.toFixed(5);
    if (price < 100) return price.toFixed(2);
    if (price < 1000) return price.toFixed(2);
    return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function setStatus(text) {
    const el = document.getElementById('status-text');
    if (el) el.textContent = text;
  }

  function normalizeSymbol(symbol) {
    return String(symbol || '').toUpperCase();
  }

  function updateTicker(symbol, price, changePct) {
    const key = normalizeSymbol(symbol).replace('USDT', '');
    const coins = getCoins();
    if (coins && coins[key]) {
      coins[key].price = price;
      if (Number.isFinite(changePct)) coins[key].change24h = changePct;
    }

    setText(`ticker-${key}`, formatLivePrice(price));

    const ticker = document.getElementById(`ticker-${key}`);
    if (ticker) {
      ticker.classList.remove('text-green-400', 'text-red-400');
      ticker.classList.add(changePct >= 0 ? 'text-green-400' : 'text-red-400');
    }

    if (typeof window.updateMainChartLivePrice === 'function' &&
        typeof window.currentCoin === 'string' &&
        window.currentCoin === key) {
      try { window.updateMainChartLivePrice(price); } catch (_) {}
    }

    if (typeof window.updateGridChartLivePrice === 'function') {
      try { window.updateGridChartLivePrice(key, price); } catch (_) {}
    }

    if (window.currentCoin === key) {
      setText('adv-coin-price', formatLivePrice(price));
      setText('adv-coin-change', `${changePct >= 0 ? '▲' : '▼'} ${Math.abs(changePct || 0).toFixed(2)}%`);
    }
  }

  function updateDailyKline(symbol, k) {
    const key = normalizeSymbol(symbol).replace('USDT', '');
    const coins = getCoins();
    if (!coins || !coins[key] || !k) return;

    const coin = coins[key];
    const candle = {
      o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c),
      time: Number(k.t), volume: Number(k.v)
    };

    if (!Number.isFinite(candle.c)) return;

    if (!Array.isArray(coin.ohlc)) coin.ohlc = [];
    if (!Array.isArray(coin.prices)) coin.prices = [];
    if (!Array.isArray(coin.volumes)) coin.volumes = [];

    const lastIndex = coin.ohlc.length - 1;
    if (lastIndex >= 0) {
      coin.ohlc[lastIndex] = {
        ...coin.ohlc[lastIndex],
        o: candle.o, h: candle.h, l: candle.l, c: candle.c
      };
      coin.prices[lastIndex] = candle.c;
      coin.volumes[lastIndex] = candle.volume;
    }

    coin.price = candle.c;

    if (typeof window.updateMainChartLivePrice === 'function' &&
        window.currentCoin === key) {
      try { window.updateMainChartLivePrice(candle.c); } catch (_) {}
    }

    if (typeof window.updateGridChartLivePrice === 'function') {
      try { window.updateGridChartLivePrice(key, candle.c); } catch (_) {}
    }

    if (k.x === true && typeof window.calculateTechnicalIndicatorsWeekly === 'function') {
      try { window.calculateTechnicalIndicatorsWeekly(key); } catch (_) {}
      if (window.currentCoin === key && typeof window.updateDashboard === 'function') {
        try { window.updateDashboard(); } catch (_) {}
      }
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

    try {
      if (socket) socket.close();
    } catch (_) {}

    setStatus('Live Binance');
    socket = new WebSocket(STREAM_BASE + streams.join('/'));

    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
      lastMessageAt = Date.now();
      setStatus('Live Binance');
    });

    socket.addEventListener('message', event => {
      lastMessageAt = Date.now();
      try {
        const packet = JSON.parse(event.data);
        const data = packet && packet.data ? packet.data : packet;
        if (!data || !data.e) return;

        if (data.e === '24hrTicker') {
          updateTicker(data.s, Number(data.c), Number(data.P));
        } else if (data.e === 'kline' && data.k && data.k.i === '1d') {
          updateDailyKline(data.s, data.k);
        }
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
    if (document.visibilityState === 'visible') {
      const stale = Date.now() - lastMessageAt > 15000;
      if (stale || !socket || socket.readyState !== WebSocket.OPEN) {
        reconnectAttempt = 0;
        connect();
      }
    }
  }

  function boot() {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (getCoins()) {
        clearInterval(timer);
        connect();
      } else if (tries > 30) {
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
