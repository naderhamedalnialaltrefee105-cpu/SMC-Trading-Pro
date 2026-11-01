'use strict';

const http = require('http');
const fs = require('fs');
const pathModule = require('path');

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const BIQUOTE_API_URL = (process.env.BIQUOTE_API_URL || 'https://biquote.io/api').replace(/\/+$/, '');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const APP_DIR = pathModule.resolve(__dirname, '..', 'app');

const SYMBOLS = ['XAUUSD', 'XAGUSD'];
const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const MAX_QUOTE_AGE_SECONDS = 120;
const CANDLE_LIMIT = 150;
const POLL_INTERVAL_MS = 60000;
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000;

const quoteCache = new Map();
const candleCache = new Map();
const analysisCache = new Map();
const signals = [];
const lastSignalBySymbol = new Map();
const lastProcessedBar = new Map();

let engineBusy = false;
let lastEngineRun = null;

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-webhook-secret'
  });
  res.end(JSON.stringify(data));
}

function isNumber(value) {
  return Number.isFinite(Number(value));
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = average(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function calculateATR(bars, period = 14) {
  if (bars.length < period + 1) return null;

  const ranges = [];

  for (let i = 1; i < bars.length; i++) {
    const current = bars[i];
    const previous = bars[i - 1];

    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  return average(ranges.slice(-period));
}

function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function fetchJSON(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`BiQuote HTTP ${response.status}`);
  }

  return response.json();
}

async function getQuote(symbol) {
  const cached = quoteCache.get(symbol);

  if (cached && Date.now() - cached.time < 10000) {
    return cached.data;
  }

  try {
    const raw = await fetchJSON(`${BIQUOTE_API_URL}/${symbol}`);

    const bid = Number(raw.bid);
    const ask = Number(raw.ask);
    const mid = Number(raw.mid);

    const validPrices =
      Number.isFinite(bid) &&
      Number.isFinite(ask) &&
      Number.isFinite(mid) &&
      bid > 0 &&
      ask > 0 &&
      mid > 0 &&
      ask >= bid;

    const quoteAgeSeconds = Number(raw.quoteAgeSeconds);
    const marketOpen = String(raw.marketState || '').toLowerCase() === 'open';
    const fresh =
      raw.stale !== true &&
      Number.isFinite(quoteAgeSeconds) &&
      quoteAgeSeconds <= MAX_QUOTE_AGE_SECONDS;

    const data = {
      symbol,
      bid: validPrices ? bid : null,
      ask: validPrices ? ask : null,
      mid: validPrices ? mid : null,
      validPrices,
      marketState: raw.marketState || 'unknown',
      marketOpen,
      stale: raw.stale === true,
      quoteAgeSeconds: Number.isFinite(quoteAgeSeconds) ? quoteAgeSeconds : null,
      fresh,
      tradable: validPrices && marketOpen && fresh,
      lastQuoteAt: raw.lastQuoteAt || null,
      dayDiffPercent: isNumber(raw.dayDiffPercent) ? Number(raw.dayDiffPercent) : null,
      direction: raw.direction || 'UNKNOWN',
      high: isNumber(raw.high) ? Number(raw.high) : null,
      low: isNumber(raw.low) ? Number(raw.low) : null,
      source: raw.source || 'BiQuote',
      exchange: raw.exchange || null,
      updatedAt: new Date().toISOString()
    };

    quoteCache.set(symbol, { time: Date.now(), data });
    return data;
  } catch (error) {
    if (cached) {
      return {
        ...cached.data,
        tradable: false,
        fresh: false,
        error: error.message
      };
    }

    return {
      symbol,
      validPrices: false,
      marketOpen: false,
      fresh: false,
      tradable: false,
      marketState: 'unavailable',
      error: error.message
    };
  }
}

async function getMarketData() {
  const markets = await Promise.all(SYMBOLS.map(getQuote));

  return {
    markets,
    allMarketsTradable: markets.every(market => market.tradable),
    timestamp: new Date().toISOString()
  };
}

async function getCandles(symbol, interval) {
  const key = `${symbol}_${interval}`;
  const cached = candleCache.get(key);

  if (cached && Date.now() - cached.time < 30000) {
    return cached.bars;
  }

  const url =
    `${BIQUOTE_API_URL}/${symbol}/ohlc?interval=${encodeURIComponent(interval)}&limit=${CANDLE_LIMIT}`;

  const raw = await fetchJSON(url);
  const sourceBars = Array.isArray(raw.bars) ? raw.bars : [];

  const bars = sourceBars
    .filter(bar => bar && bar.isOpen !== true)
    .map(bar => ({
      time: new Date(bar.openTime).getTime(),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume || 0),
      tickVolume: Number(bar.tickVolume || 0)
    }))
    .filter(bar =>
      Number.isFinite(bar.time) &&
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) &&
      bar.open > 0 &&
      bar.high >= bar.low &&
      bar.high >= Math.max(bar.open, bar.close) &&
      bar.low <= Math.min(bar.open, bar.close)
    )
    .sort((a, b) => a.time - b.time);

  if (!bars.length) {
    throw new Error(`لا توجد شموع مكتملة: ${symbol} ${interval}`);
  }

  candleCache.set(key, { time: Date.now(), bars });
  return bars;
}

function buildThreeMinuteCandles(oneMinuteBars) {
  const result = [];
  const groups = new Map();

  for (const bar of oneMinuteBars) {
    const bucket = Math.floor(bar.time / 180000) * 180000;

    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(bar);
  }

  for (const [time, group] of groups.entries()) {
    group.sort((a, b) => a.time - b.time);

    if (group.length !== 3) continue;

    const first = group[0];
    const last = group[2];

    result.push({
      time,
      open: first.open,
      high: Math.max(...group.map(bar => bar.high)),
      low: Math.min(...group.map(bar => bar.low)),
      close: last.close,
      volume: group.reduce((sum, bar) => sum + bar.volume, 0),
      tickVolume: group.reduce((sum, bar) => sum + bar.tickVolume, 0)
    });
  }

  return result.sort((a, b) => a.time - b.time);
}

function calculateTrend(bars) {
  if (!bars || bars.length < 55) {
    return {
      available: false,
      trend: 'غير متاح',
      strength: 0,
      reason: 'بيانات الشموع غير كافية'
    };
  }

  const closes = bars.map(bar => bar.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atr = calculateATR(bars, 14);
  const rsi = calculateRSI(closes, 14);

  if (!ema20 || !ema50 || !atr || !Number.isFinite(rsi)) {
    return {
      available: false,
      trend: 'غير متاح',
      strength: 0,
      reason: 'تعذر حساب المؤشرات'
    };
  }

  const gap = Math.abs(ema20 - ema50);
  const strength = Math.min(100, Math.round((gap / atr) * 100));

  let trend = 'متذبذب';

  if (ema20 > ema50 && closes[closes.length - 1] > ema20 && rsi >= 50) {
    trend = 'صاعد';
  } else if (
    ema20 < ema50 &&
    closes[closes.length - 1] < ema20 &&
    rsi <= 50
  ) {
    trend = 'هابط';
  }

  return {
    available: true,
    trend,
    strength,
    ema20,
    ema50,
    atr,
    rsi,
    price: closes[closes.length - 1]
  };
}

function calculateLevels(bars) {
  if (!bars || bars.length < 10) {
    return { support: null, resistance: null };
  }

  const recent = bars.slice(-50);

  return {
    support: Math.min(...recent.map(bar => bar.low)),
    resistance: Math.max(...recent.map(bar => bar.high))
  };
}

async function analyzeSymbol(symbol) {
  const results = await Promise.allSettled(
    INTERVALS.map(interval => getCandles(symbol, interval))
  );

  const candles = {};
  const timeframes = {};

  INTERVALS.forEach((interval, index) => {
    const result = results[index];

    if (result.status === 'fulfilled') {
      candles[interval] = result.value;
      timeframes[interval] = calculateTrend(result.value);
      timeframes[interval].candleCount = result.value.length;
    } else {
      candles[interval] = [];
      timeframes[interval] = {
        available: false,
        trend: 'غير متاح',
        strength: 0,
        reason: result.reason?.message || 'تعذر جلب البيانات'
      };
    }
  });

  candles['3m'] = buildThreeMinuteCandles(candles['1m']);
  timeframes['3m'] = calculateTrend(candles['3m']);
  timeframes['3m'].candleCount = candles['3m'].length;

  const mainBars = candles['5m'];
  const levels = calculateLevels(mainBars);

  const available = mainBars.length >= 60 &&
    candles['15m'].length >= 55;

  const mainTrend = timeframes['5m'];

  return {
    symbol,
    available,
    trend: mainTrend.trend,
    strength: mainTrend.strength,
    indicators: mainTrend,
    levels,
    timeframes,
    candleCounts: Object.fromEntries(
      Object.entries(candles).map(([key, value]) => [key, value.length])
    ),
    candles
  };
}

async function getAnalysis() {
  const now = Date.now();
  const cached = analysisCache.get('all');

  if (cached && now - cached.time < 30000) {
    return cached.data;
  }

  const [gold, silver, marketData] = await Promise.all([
    analyzeSymbol('XAUUSD'),
    analyzeSymbol('XAGUSD'),
    getMarketData()
  ]);

  const availableSymbols = [gold, silver].filter(item => item.available);

  const trends = availableSymbols
    .map(item => item.trend)
    .filter(trend => trend !== 'غير متاح');

  let overallTrend = 'غير متاح';

  if (trends.length) {
    const bullish = trends.filter(t => t === 'صاعد').length;
    const bearish = trends.filter(t => t === 'هابط').length;

    if (bullish > bearish) overallTrend = 'صاعد';
    else if (bearish > bullish) overallTrend = 'هابط';
    else overallTrend = 'متذبذب';
  }

  const data = {
    available: availableSymbols.length > 0,
    engineReady: availableSymbols.length > 0,
    overallTrend,
    strength: availableSymbols.length
      ? Math.round(average(availableSymbols.map(item => item.strength)))
      : 0,
    condition: overallTrend === 'متذبذب'
      ? 'السوق متذبذب'
      : overallTrend === 'غير متاح'
        ? 'بيانات التحليل غير مكتملة'
        : `الاتجاه العام ${overallTrend}`,
    timeframes: gold.timeframes,
    symbols: { XAUUSD: gold, XAGUSD: silver },
    markets: marketData.markets,
    timestamp: new Date().toISOString()
  };

  analysisCache.set('all', { time: now, data });
  return data;
}

function buildSignal(symbol, analysis, quote) {
  if (!quote || !quote.tradable) return null;
  if (!analysis || !analysis.available) return null;

  const bars = analysis.candles['5m'];
  const bars15 = analysis.candles['15m'];
  const bars1h = analysis.candles['1h'];

  if (!bars || bars.length < 60 || !bars15 || bars15.length < 55) {
    return null;
  }

  const current = bars[bars.length - 1];
  const previous = bars[bars.length - 2];

  const trend5 = analysis.timeframes['5m'];
  const trend15 = analysis.timeframes['15m'];
  const trend1h = analysis.timeframes['1h'];

  if (!trend5.available || !trend15.available) return null;

  const atr = trend5.atr;
  if (!atr || atr <= 0) return null;

  const recent = bars.slice(-21, -1);
  const support = Math.min(...recent.map(bar => bar.low));
  const resistance = Math.max(...recent.map(bar => bar.high));

  const candleRange = current.high - current.low;
  if (candleRange <= 0) return null;

  const lowerWick = Math.min(current.open, current.close) - current.low;
  const upperWick = current.high - Math.max(current.open, current.close);

  const bullishCandle = current.close > current.open;
  const bearishCandle = current.close < current.open;

  const nearSupport = current.low <= support + atr * 0.30;
  const nearResistance = current.high >= resistance - atr * 0.30;

  const bullishRejection =
    bullishCandle &&
    lowerWick / candleRange >= 0.25 &&
    current.close > previous.close &&
    nearSupport;

  const bearishRejection =
    bearishCandle &&
    upperWick / candleRange >= 0.25 &&
    current.close < previous.close &&
    nearResistance;

  const bullishTrend =
    trend5.trend === 'صاعد' &&
    trend15.trend === 'صاعد' &&
    (!trend1h.available || trend1h.trend !== 'هابط');

  const bearishTrend =
    trend5.trend === 'هابط' &&
    trend15.trend === 'هابط' &&
    (!trend1h.available || trend1h.trend !== 'صاعد');

  let side = null;

  if (bullishRejection && bullishTrend) side = 'BUY';
  if (bearishRejection && bearishTrend) side = 'SELL';

  if (!side) return null;

  const entry = current.close;
  const swingBars = bars.slice(-7, -1);

  let sl;
  let risk;

  if (side === 'BUY') {
    const swingLow = Math.min(...swingBars.map(bar => bar.low));
    sl = Math.min(swingLow, entry - atr * 1.2);
    risk = entry - sl;
  } else {
    const swingHigh = Math.max(...swingBars.map(bar => bar.high));
    sl = Math.max(swingHigh, entry + atr * 1.2);
    risk = sl - entry;
  }

  if (!Number.isFinite(risk) || risk <= 0) return null;

  const tp1 = side === 'BUY' ? entry + risk : entry - risk;
  const tp2 = side === 'BUY' ? entry + risk * 2 : entry - risk * 2;

  const decimals = symbol === 'XAUUSD' ? 2 : 3;
  const round = value => Number(value.toFixed(decimals));

  return {
    id: `${symbol}-${side}-${current.time}`,
    symbol,
    side,
    type: side === 'BUY' ? 'شراء' : 'بيع',
    entry: round(entry),
    tp1: round(tp1),
    tp2: round(tp2),
    sl: round(sl),
    timeframe: '5m',
    trend: side === 'BUY' ? 'صاعد' : 'هابط',
    reason: side === 'BUY'
      ? 'ارتداد صاعد من منطقة دعم مع تأكيد الاتجاه'
      : 'رفض سعري من منطقة مقاومة مع تأكيد الاتجاه',
    candleTime: current.time,
    createdAt: new Date().toISOString(),
    status: 'جديدة',
    telegramSent: false
  };
}

function validateSignal(signal) {
  if (!signal) return false;

  const values = [signal.entry, signal.tp1, signal.tp2, signal.sl];
  if (!values.every(Number.isFinite)) return false;

  if (signal.side === 'BUY') {
    return signal.sl < signal.entry &&
      signal.tp1 > signal.entry &&
      signal.tp2 > signal.tp1;
  }

  if (signal.side === 'SELL') {
    return signal.sl > signal.entry &&
      signal.tp1 < signal.entry &&
      signal.tp2 < signal.tp1;
  }

  return false;
}

async function sendTelegram(signal) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, reason: 'إعدادات Telegram غير مكتملة' };
  }

  const direction = signal.side === 'BUY' ? 'شراء 🟢' : 'بيع 🔴';

  const message = [
    '📊 SMC Trading Pro',
    '',
    `السوق: ${signal.symbol}`,
    `الإشارة: ${direction}`,
    `سعر الدخول: ${signal.entry}`,
    `الهدف الأول TP1: ${signal.tp1}`,
    `الهدف الثاني TP2: ${signal.tp2}`,
    `وقف الخسارة SL: ${signal.sl}`,
    `الإطار الزمني: ${signal.timeframe}`,
    '',
    `سبب الإشارة: ${signal.reason}`,
    '',
    '⚠️ تحليل فني وليس ضماناً للربح.'
  ].join('\n');

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message
        }),
        signal: AbortSignal.timeout(12000)
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      return {
        sent: false,
        reason: result.description || `Telegram HTTP ${response.status}`
      };
    }

    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

async function publishSignal(signal) {
  if (!validateSignal(signal)) {
    return { success: false, error: 'بيانات الإشارة غير صحيحة' };
  }

  const quote = await getQuote(signal.symbol);

  if (!quote.tradable) {
    return {
      success: false,
      error: 'السوق مغلق أو بيانات السعر قديمة؛ لم يتم الإرسال'
    };
  }

  const previous = lastSignalBySymbol.get(signal.symbol);

  if (previous) {
    if (previous.side === signal.side) {
      return { success: false, error: 'تم منع تكرار نفس اتجاه الإشارة' };
    }

    if (Date.now() - previous.time < SIGNAL_COOLDOWN_MS) {
      return { success: false, error: 'فترة منع التكرار لم تنتهِ بعد' };
    }
  }

  const telegram = await sendTelegram(signal);

  signal.telegramSent = telegram.sent;
  signal.telegramError = telegram.sent ? null : telegram.reason;

  signals.unshift(signal);
  if (signals.length > 200) signals.length = 200;

  lastSignalBySymbol.set(signal.symbol, {
    side: signal.side,
    time: Date.now()
  });

  return {
    success: true,
    signal,
    telegram
  };
}

async function runSignalEngine() {
  if (engineBusy) return;
  engineBusy = true;

  try {
    lastEngineRun = new Date().toISOString();

    const marketData = await getMarketData();

    for (const symbol of SYMBOLS) {
      const quote = marketData.markets.find(item => item.symbol === symbol);

      if (!quote || !quote.tradable) continue;

      const analysis = await analyzeSymbol(symbol);
      if (!analysis.available) continue;

      const bars = analysis.candles['5m'];
      if (!bars || bars.length < 60) continue;

      const latestBar = bars[bars.length - 1];
      const previousBarTime = lastProcessedBar.get(symbol);

      if (previousBarTime === latestBar.time) continue;

      lastProcessedBar.set(symbol, latestBar.time);

      const signal = buildSignal(symbol, analysis, quote);
      if (!signal) continue;

      await publishSignal(signal);
    }
  } catch (error) {
    console.error('Signal engine error:', error.message);
  } finally {
    engineBusy = false;
  }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;

      if (body.length > 100000) {
        reject(new Error('حجم الطلب كبير'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('JSON غير صالح'));
      }
    });

    req.on('error', reject);
  });
}

function authorized(req) {
  if (!WEBHOOK_SECRET) return false;

  const supplied =
    req.headers['x-webhook-secret'] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, '');

  return supplied === WEBHOOK_SECRET;
}

/*
 * تقديم ملفات واجهة التطبيق من مجلد app
 * المسار / يفتح index.html
 * والمسارات /app/... تقدم ملفات الواجهة وPWA
 */
async function serveAppFile(path, res) {
  const requestedFile = path === '/'
    ? 'index.html'
    : path.slice('/app/'.length);

  let decodedFile;

  try {
    decodedFile = decodeURIComponent(requestedFile);
  } catch {
    return json(res, 400, {
      success: false,
      error: 'مسار الملف غير صالح'
    });
  }

  const filePath = pathModule.resolve(APP_DIR, decodedFile);
  const relativePath = pathModule.relative(APP_DIR, filePath);

  if (
    relativePath.startsWith('..') ||
    pathModule.isAbsolute(relativePath)
  ) {
    return json(res, 403, {
      success: false,
      error: 'غير مسموح'
    });
  }

  try {
    const file = await fs.promises.readFile(filePath);
    const extension = pathModule.extname(filePath).toLowerCase();

    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/manifest+json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.webp': 'image/webp'
    };

    res.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html'
        ? 'no-cache'
        : 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });

    return res.end(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return json(res, 404, {
        success: false,
        error: 'ملف التطبيق غير موجود'
      });
    }

    throw error;
  }
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    return json(res, 204, {});
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // الصفحة الرئيسية وملفات الواجهة
  if (
    req.method === 'GET' &&
    (path === '/' || path.startsWith('/app/'))
  ) {
    return serveAppFile(path, res);
  }

  if (req.method === 'GET' && path === '/api/status') {
    const marketData = await getMarketData();

    return json(res, 200, {
      online: true,
      server: 'running',
      provider: 'BiQuote',
      providerConfigured: true,
      telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      marketOpen: marketData.markets.some(market => market.marketOpen),
      allMarketsTradable: marketData.allMarketsTradable,
      lastEngineRun,
      timestamp: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && path === '/api/markets') {
    return json(res, 200, await getMarketData());
  }

  if (req.method === 'GET' && path === '/api/analysis') {
    return json(res, 200, await getAnalysis());
  }

  if (req.method === 'GET' && path === '/api/signals') {
    const limit = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get('limit') || 20))
    );

    return json(res, 200, {
      signals: signals.slice(0, limit),
      count: signals.length
    });
  }

  if (req.method === 'POST' && path === '/api/signals/publish') {
    if (!authorized(req)) {
      return json(res, 401, {
        success: false,
        error: 'غير مصرح'
      });
    }

    try {
      const body = await readBody(req);
      const result = await publishSignal(body);

      return json(res, result.success ? 200 : 400, result);
    } catch (error) {
      return json(res, 400, {
        success: false,
        error: error.message
      });
    }
  }

  if (req.method === 'POST' && path === '/api/telegram/test') {
    if (!authorized(req)) {
      return json(res, 401, {
        success: false,
        error: 'غير مصرح'
      });
    }

    const testMessage = {
      symbol: 'SMC Trading Pro',
      side: 'BUY',
      entry: 0,
      tp1: 0,
      tp2: 0,
      sl: 0,
      timeframe: 'اختبار',
      reason: 'رسالة اختبار اتصال Telegram'
    };

    const result = await sendTelegram(testMessage);

    return json(res, result.sent ? 200 : 400, {
      success: result.sent,
      telegram: result
    });
  }

  return json(res, 404, {
    error: 'المسار غير موجود'
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('Request error:', error.message);

    if (!res.headersSent) {
      json(res, 500, {
        success: false,
        error: 'حدث خطأ داخلي في الخادم'
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});

server.listen(PORT, () => {
  console.log(`SMC Trading Pro running on port ${PORT}`);
  console.log('Market data source: BiQuote');
  console.log('Supported markets: XAUUSD, XAGUSD');
  console.log(`App directory: ${APP_DIR}`);

  runSignalEngine();
  setInterval(runSignalEngine, POLL_INTERVAL_MS);
});
