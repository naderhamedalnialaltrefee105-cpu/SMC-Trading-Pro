'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const BIQUOTE_API_URL = (process.env.BIQUOTE_API_URL || 'https://biquote.io/api').replace(/\/+$/, '');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const APP_DIR = path.resolve(__dirname, '..', 'app');

const SYMBOLS = ['XAUUSD', 'XAGUSD'];
const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const MAX_QUOTE_AGE_SECONDS = 120;
const CANDLE_LIMIT = 150;
const POLL_INTERVAL_MS = 60000;
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000;
const PIVOT_LEFT = 10;
const PIVOT_RIGHT = 5;
const ATR_PERIOD = 14;
const TARGET_R = [1, 1.5, 2];

const RISK_CONFIG = {
  XAUUSD: { minStop: 2.0, minBuffer: 0.25, atrStop: 1.0, maxEntryDriftATR: 0.75 },
  XAGUSD: { minStop: 0.08, minBuffer: 0.015, atrStop: 1.0, maxEntryDriftATR: 0.75 }
};

const quoteCache = new Map();
const candleCache = new Map();
const analysisCache = new Map();
const signals = [];
const lastSignalBySymbol = new Map();
const lastProcessedBar = new Map();

let engineBusy = false;
let lastEngineRun = null;
let lastEngineSummary = {
  status: 'starting',
  checked: 0,
  emitted: 0,
  skipped: 0,
  details: []
};

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
  return value !== null && value !== undefined && value !== '' &&
    Number.isFinite(Number(value));
}

function average(values) {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;

  const k = 2 / (period + 1);
  let value = average(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    value = (values[i] - value) * k + value;
  }

  return value;
}

function calculateATR(bars, period = ATR_PERIOD) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;

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
  if (!Array.isArray(closes) || closes.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const difference = closes[i] - closes[i - 1];

    if (difference > 0) gains += difference;
    else losses += Math.abs(difference);
  }

  if (losses === 0) return 100;
  if (gains === 0) return 0;

  const rs = (gains / period) / (losses / period);

  return 100 - 100 / (1 + rs);
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
      [bid, ask, mid].every(Number.isFinite) &&
      bid > 0 && ask > 0 && mid > 0 && ask >= bid;

    const quoteAgeSeconds = Number(raw.quoteAgeSeconds);
    const marketOpen =
      String(raw.marketState || '').toLowerCase() === 'open';

    const fresh =
      raw.stale !== true &&
      Number.isFinite(quoteAgeSeconds) &&
      quoteAgeSeconds >= 0 &&
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
      quoteAgeSeconds: Number.isFinite(quoteAgeSeconds)
        ? quoteAgeSeconds
        : null,
      fresh,
      tradable: validPrices && marketOpen && fresh,
      lastQuoteAt: raw.lastQuoteAt || null,
      dayDiffPercent: isNumber(raw.dayDiffPercent)
        ? Number(raw.dayDiffPercent)
        : null,
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

  if (cached && Date.now() - cached.time < 20000) {
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
      [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) &&
      bar.open > 0 &&
      bar.high >= Math.max(bar.open, bar.close) &&
      bar.low <= Math.min(bar.open, bar.close) &&
      bar.high >= bar.low
    )
    .sort((a, b) => a.time - b.time);

  if (!bars.length) {
    throw new Error(`لا توجد شموع مكتملة: ${symbol} ${interval}`);
  }

  candleCache.set(key, { time: Date.now(), bars });

  return bars;
}

function buildThreeMinuteCandles(oneMinuteBars) {
  const groups = new Map();

  for (const bar of oneMinuteBars) {
    const bucket = Math.floor(bar.time / 180000) * 180000;

    if (!groups.has(bucket)) groups.set(bucket, []);

    groups.get(bucket).push(bar);
  }

  const result = [];

  for (const [time, group] of groups) {
    group.sort((a, b) => a.time - b.time);

    if (
      group.length !== 3 ||
      group[1].time - group[0].time !== 60000 ||
      group[2].time - group[1].time !== 60000
    ) {
      continue;
    }

    result.push({
      time,
      open: group[0].open,
      high: Math.max(...group.map(item => item.high)),
      low: Math.min(...group.map(item => item.low)),
      close: group[2].close,
      volume: group.reduce((sum, item) => sum + item.volume, 0),
      tickVolume: group.reduce((sum, item) => sum + item.tickVolume, 0)
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
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const atr = calculateATR(bars);
  const rsi = calculateRSI(closes);

  if (![e20, e50, atr, rsi].every(Number.isFinite) || atr <= 0) {
    return {
      available: false,
      trend: 'غير متاح',
      strength: 0,
      reason: 'تعذر حساب المؤشرات'
    };
  }

  let trend = 'متذبذب';

  if (e20 > e50 && closes.at(-1) > e20 && rsi >= 50) {
    trend = 'صاعد';
  } else if (e20 < e50 && closes.at(-1) < e20 && rsi <= 50) {
    trend = 'هابط';
  }

  return {
    available: true,
    trend,
    strength: Math.min(100, Math.round(Math.abs(e20 - e50) / atr * 100)),
    ema20: e20,
    ema50: e50,
    atr,
    rsi,
    price: closes.at(-1)
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

  return {
    symbol,
    available: mainBars.length >= 60 && candles['15m'].length >= 55,
    trend: timeframes['5m'].trend,
    strength: timeframes['5m'].strength,
    indicators: timeframes['5m'],
    levels: calculateLevels(mainBars),
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

  if (cached && now - cached.time < 20000) {
    return cached.data;
  }

  const [gold, silver, marketData] = await Promise.all([
    analyzeSymbol('XAUUSD'),
    analyzeSymbol('XAGUSD'),
    getMarketData()
  ]);

  const ready = [gold, silver].filter(item => item.available);
  const trends = ready
    .map(item => item.trend)
    .filter(trend => trend !== 'غير متاح');

  const up = trends.filter(trend => trend === 'صاعد').length;
  const down = trends.filter(trend => trend === 'هابط').length;

  const overallTrend = !trends.length
    ? 'غير متاح'
    : up > down
      ? 'صاعد'
      : down > up
        ? 'هابط'
        : 'متذبذب';

  const data = {
    available: ready.length > 0,
    engineReady: ready.length > 0,
    overallTrend,
    strength: ready.length
      ? Math.round(average(ready.map(item => item.strength)))
      : 0,
    condition: overallTrend === 'متذبذب'
      ? 'السوق متذبذب'
      : overallTrend === 'غير متاح'
        ? 'بيانات التحليل غير مكتملة'
        : `الاتجاه العام ${overallTrend}`,
    timeframes: gold.timeframes,
    symbols: {
      XAUUSD: gold,
      XAGUSD: silver
    },
    markets: marketData.markets,
    timestamp: new Date().toISOString()
  };

  analysisCache.set('all', { time: now, data });

  return data;
}

// تأكيد القمة أو القاع يتم بعد خمس شموع.
// سعر الدخول هو سعر السوق الحالي، وليس إغلاق شمعة القمة أو القاع القديمة.
function buildSignal(symbol, analysis, quote) {
  if (!quote || !quote.tradable || !analysis?.candles) {
    return {
      signal: null,
      reason: 'السعر غير متاح أو غير قابل للتداول'
    };
  }

  const bars = analysis.candles['5m'];

  if (
    !Array.isArray(bars) ||
    bars.length < PIVOT_LEFT + PIVOT_RIGHT + ATR_PERIOD + 2
  ) {
    return {
      signal: null,
      reason: 'شموع 5 دقائق غير كافية'
    };
  }

  const currentIndex = bars.length - 1;
  const pivotIndex = currentIndex - PIVOT_RIGHT;
  const pivot = bars[pivotIndex];

  const left = bars.slice(pivotIndex - PIVOT_LEFT, pivotIndex);
  const right = bars.slice(pivotIndex + 1, currentIndex + 1);

  if (
    !pivot ||
    left.length !== PIVOT_LEFT ||
    right.length !== PIVOT_RIGHT
  ) {
    return {
      signal: null,
      reason: 'بيانات تأكيد القمة أو القاع غير كافية'
    };
  }

  const priorHigh = Math.max(...left.map(bar => bar.high));
  const priorLow = Math.min(...left.map(bar => bar.low));
  const laterHigh = Math.max(...right.map(bar => bar.high));
  const laterLow = Math.min(...right.map(bar => bar.low));

  const pivotHigh = pivot.high > priorHigh && pivot.high > laterHigh;
  const pivotLow = pivot.low < priorLow && pivot.low < laterLow;

  const sweepHigh = pivotHigh && pivot.close < priorHigh;
  const sweepLow = pivotLow && pivot.close > priorLow;

  if (sweepHigh === sweepLow) {
    return {
      signal: null,
      reason: 'لم تتكون قمة أو قاع اصطياد سيولة مؤكد'
    };
  }

  const side = sweepHigh ? 'SELL' : 'BUY';
  const entry = side === 'BUY'
    ? Number(quote.ask)
    : Number(quote.bid);

  const atr = calculateATR(bars, ATR_PERIOD);

  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(atr) ||
    atr <= 0
  ) {
    return {
      signal: null,
      reason: 'تعذر تحديد سعر الدخول أو ATR'
    };
  }

  const config = RISK_CONFIG[symbol] || RISK_CONFIG.XAUUSD;
  const drift = Math.abs(entry - pivot.close);

  if (drift > atr * config.maxEntryDriftATR) {
    return {
      signal: null,
      reason: 'تم إلغاء الإشارة لأن السعر تحرك بعيداً عن نقطة التأكيد'
    };
  }

  const buffer = Math.max(config.minBuffer, atr * 0.15);

  let sl = side === 'BUY'
    ? pivot.low - buffer
    : pivot.high + buffer;

  let risk = Math.abs(entry - sl);

  const minimumRisk = Math.max(config.minStop, atr * config.atrStop);

  if (risk < minimumRisk) {
    sl = side === 'BUY'
      ? entry - minimumRisk
      : entry + minimumRisk;

    risk = minimumRisk;
  }

  if (!Number.isFinite(risk) || risk <= 0 || risk > atr * 3) {
    return {
      signal: null,
      reason: 'مسافة وقف الخسارة غير مناسبة؛ تم رفض الإشارة'
    };
  }

  const decimals = symbol === 'XAUUSD' ? 2 : 3;
  const round = value => Number(value.toFixed(decimals));

  const target = multiple => side === 'BUY'
    ? entry + risk * multiple
    : entry - risk * multiple;

  const signal = {
    id: `${symbol}-${side}-${pivot.time}-${currentIndex}`,
    symbol,
    side,
    type: side === 'BUY' ? 'شراء' : 'بيع',
    entry: round(entry),
    sl: round(sl),
    tp1: round(target(TARGET_R[0])),
    tp2: round(target(TARGET_R[1])),
    tp3: round(target(TARGET_R[2])),
    timeframe: '5m',
    trend: side === 'BUY' ? 'صاعد' : 'هابط',
    reason: side === 'BUY'
      ? 'اصطياد سيولة أسفل قاع مؤكد بعد خمس شموع؛ الدخول بسعر السوق الحالي'
      : 'اصطياد سيولة أعلى قمة مؤكدة بعد خمس شموع؛ الدخول بسعر السوق الحالي',
    candleTime: pivot.time,
    confirmationTime: bars[currentIndex].time,
    createdAt: new Date().toISOString(),
    status: 'جديدة',
    telegramSent: false,
    riskDistance: round(risk),
    atr: round(atr),
    entrySource: side === 'BUY' ? 'ask' : 'bid',
    quoteAgeSeconds: quote.quoteAgeSeconds
  };

  return {
    signal,
    reason: 'اكتملت شروط الإشارة'
  };
}

function validateSignal(signal) {
  if (!signal) return false;

  if (
    ![signal.entry, signal.tp1, signal.tp2, signal.tp3, signal.sl]
      .every(Number.isFinite)
  ) {
    return false;
  }

  if (signal.side === 'BUY') {
    return signal.sl < signal.entry &&
      signal.tp1 > signal.entry &&
      signal.tp2 > signal.tp1 &&
      signal.tp3 > signal.tp2;
  }

  if (signal.side === 'SELL') {
    return signal.sl > signal.entry &&
      signal.tp1 < signal.entry &&
      signal.tp2 < signal.tp1 &&
      signal.tp3 < signal.tp2;
  }

  return false;
}

async function sendTelegram(signal) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return {
      sent: false,
      reason: 'إعدادات Telegram غير مكتملة'
    };
  }

  const direction = signal.side === 'BUY'
    ? 'شراء 🟢'
    : 'بيع 🔴';

  const message = [
    '📊 SMC Trading Pro',
    '',
    `السوق: ${signal.symbol}`,
    `الإشارة: ${direction}`,
    `سعر الدخول: ${signal.entry}`,
    `الهدف الأول TP1: ${signal.tp1}`,
    `الهدف الثاني TP2: ${signal.tp2}`,
    `الهدف الثالث TP3: ${signal.tp3}`,
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
    return {
      sent: false,
      reason: error.message
    };
  }
}

async function publishSignal(signal) {
  if (!validateSignal(signal)) {
    return {
      success: false,
      error: 'بيانات الإشارة غير صحيحة'
    };
  }

  const quote = await getQuote(signal.symbol);

  if (!quote.tradable) {
    return {
      success: false,
      error: 'السوق مغلق أو بيانات السعر قديمة؛ لم يتم الإرسال'
    };
  }

  const live = signal.side === 'BUY'
    ? quote.ask
    : quote.bid;

  if (
    Math.abs(Number(signal.entry) - live) >
    Math.max(0.02, live * 0.0005)
  ) {
    return {
      success: false,
      error: 'سعر الدخول لم يعد قريباً من سعر السوق الحالي'
    };
  }

  const previous = lastSignalBySymbol.get(signal.symbol);

  if (
    previous &&
    Date.now() - previous.time < SIGNAL_COOLDOWN_MS
  ) {
    return {
      success: false,
      error: 'فترة منع تكرار الإشارات لم تنتهِ بعد'
    };
  }

  const telegram = await sendTelegram(signal);

  signal.telegramSent = telegram.sent;
  signal.telegramError = telegram.sent ? null : telegram.reason;

  signals.unshift(signal);

  if (signals.length > 200) {
    signals.length = 200;
  }

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

  const details = [];
  let checked = 0;
  let emitted = 0;
  let skipped = 0;

  try {
    lastEngineRun = new Date().toISOString();

    const marketData = await getMarketData();

    for (const symbol of SYMBOLS) {
      checked++;

      const quote = marketData.markets.find(
        market => market.symbol === symbol
      );

      if (!quote || !quote.tradable) {
        skipped++;
        details.push({
          symbol,
          result: 'skipped',
          reason: 'السعر غير متاح أو السوق مغلق أو البيانات قديمة'
        });
        continue;
      }

      let analysis;

      try {
        analysis = await analyzeSymbol(symbol);
      } catch (error) {
        skipped++;
        details.push({
          symbol,
          result: 'error',
          reason: error.message
        });
        continue;
      }

      const bars = analysis.candles['5m'];

      if (!bars || bars.length < 60) {
        skipped++;
        details.push({
          symbol,
          result: 'skipped',
          reason: `شموع 5 دقائق غير كافية: ${bars?.length || 0}/60`
        });
        continue;
      }

      const latest = bars.at(-1);
      const previous = lastProcessedBar.get(symbol);

      if (previous === latest.time) {
        details.push({
          symbol,
          result: 'waiting',
          reason: 'بانتظار إغلاق شمعة 5 دقائق جديدة'
        });
        continue;
      }

      lastProcessedBar.set(symbol, latest.time);

      const outcome = buildSignal(symbol, analysis, quote);

      if (!outcome.signal) {
        skipped++;
        details.push({
          symbol,
          result: 'no_signal',
          reason: outcome.reason
        });
        continue;
      }

      const result = await publishSignal(outcome.signal);

      if (result.success) {
        emitted++;

        details.push({
          symbol,
          result: 'signal_created',
          telegramSent: result.telegram.sent,
          telegramError: result.telegram.reason || null
        });
      } else {
        skipped++;

        details.push({
          symbol,
          result: 'rejected',
          reason: result.error
        });
      }
    }

    lastEngineSummary = {
      status: 'ok',
      checked,
      emitted,
      skipped,
      details,
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    lastEngineSummary = {
      status: 'error',
      checked,
      emitted,
      skipped,
      details: [{
        result: 'engine_error',
        reason: error.message
      }],
      updatedAt: new Date().toISOString()
    };

    console.error('Signal engine error:', error.message);
  } finally {
    engineBusy = false;
  }
}

function readBody(req) {
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

async function serveAppFile(requestPath, res) {
  const requested = requestPath === '/'
    ? 'index.html'
    : requestPath.slice('/app/'.length);

  let decoded;

  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return json(res, 400, {
      success: false,
      error: 'مسار الملف غير صالح'
    });
  }

  const filePath = path.resolve(APP_DIR, decoded);
  const relative = path.relative(APP_DIR, filePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return json(res, 403, {
      success: false,
      error: 'غير مسموح'
    });
  }

  try {
    const file = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();

    const types = {
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
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html'
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

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  const requestPath = url.pathname;

  if (
    req.method === 'GET' &&
    (requestPath === '/' || requestPath.startsWith('/app/'))
  ) {
    return serveAppFile(requestPath, res);
  }

  if (
    req.method === 'GET' &&
    requestPath === '/api/status'
  ) {
    const marketData = await getMarketData();

    return json(res, 200, {
      online: true,
      server: 'running',
      provider: 'BiQuote',
      providerConfigured: true,
      telegramConfigured: Boolean(
        TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID
      ),
      marketOpen: marketData.markets.some(
        market => market.marketOpen
      ),
      allMarketsTradable: marketData.allMarketsTradable,
      lastEngineRun,
      engine: lastEngineSummary,
      timestamp: new Date().toISOString()
    });
  }

  if (
    req.method === 'GET' &&
    requestPath === '/api/markets'
  ) {
    return json(res, 200, await getMarketData());
  }

  if (
    req.method === 'GET' &&
    requestPath === '/api/analysis'
  ) {
    return json(res, 200, await getAnalysis());
  }

  if (
    req.method === 'GET' &&
    requestPath === '/api/signals'
  ) {
    const limit = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get('limit') || 20))
    );

    return json(res, 200, {
      signals: signals.slice(0, limit),
      count: signals.length
    });
  }

  if (
    req.method === 'POST' &&
    requestPath === '/api/signals/publish'
  ) {
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

  if (
    req.method === 'POST' &&
    requestPath === '/api/telegram/test'
  ) {
    if (!authorized(req)) {
      return json(res, 401, {
        success: false,
        error: 'غير مصرح'
      });
    }

    const test = {
      symbol: 'SMC Trading Pro',
      side: 'BUY',
      entry: 0,
      tp1: 0,
      tp2: 0,
      tp3: 0,
      sl: 0,
      timeframe: 'اختبار',
      reason: 'رسالة اختبار اتصال Telegram'
    };

    const result = await sendTelegram(test);

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
  console.log(`Market data endpoint: ${BIQUOTE_API_URL}`);
  console.log('Supported markets: XAUUSD, XAGUSD');
  console.log(`App directory: ${APP_DIR}`);

  runSignalEngine();
  setInterval(runSignalEngine, POLL_INTERVAL_MS);
});
