
"use strict";

/*
 * SMC Trading Pro
 * Server + BiQuote + Technical Analysis + Telegram
 * Markets: XAUUSD, XAGUSD
 * Node.js 20+
 */

const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const BIQUOTE_API_URL = (
  process.env.BIQUOTE_API_URL || "https://biquote.io/api"
).replace(/\/+$/, "");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const SYMBOLS = ["XAUUSD", "XAGUSD"];
const MAX_QUOTE_AGE_SECONDS = 120;
const POLL_INTERVAL_MS = 60000;
const CANDLE_LIMIT = 150;
const SIGNAL_HISTORY_LIMIT = 200;

const INTERVALS = [
  "1m", "5m", "15m", "30m", "1h", "4h", "1d"
];

const INTERVAL_MS = {
  "1m": 60000,
  "3m": 180000,
  "5m": 300000,
  "15m": 900000,
  "30m": 1800000,
  "1h": 3600000,
  "4h": 14400000,
  "1d": 86400000
};

let signals = [];
let lastUpdate = null;
let lastAnalysisUpdate = null;

const quoteCache = new Map();
const candleCache = new Map();
const lastProcessedBar = new Map();
const lastSignalTime = new Map();
const analysisCache = new Map();

let analysisRunning = false;

// ---------- HTTP HELPERS ----------

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-webhook-secret"
  });

  res.end(JSON.stringify(data));
}

function getStatus() {
  return {
    status: "running",
    provider: "biquote",
    providerConfigured: Boolean(BIQUOTE_API_URL),
    telegramConfigured: Boolean(
      TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID
    ),
    analysisEngineReady: true,
    markets: SYMBOLS,
    lastUpdate,
    lastAnalysisUpdate,
    maxQuoteAgeSeconds: MAX_QUOTE_AGE_SECONDS,
    serverTime: new Date().toISOString()
  };
}

async function fetchJSON(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(12000),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

// ---------- MARKET QUOTES ----------

async function getQuote(symbol) {
  const cached = quoteCache.get(symbol);

  if (cached && Date.now() - cached.time < 10000) {
    return cached.data;
  }

  const data = await fetchJSON(
    `${BIQUOTE_API_URL}/${symbol}`
  );

  const bid = Number(data.bid);
  const ask = Number(data.ask);
  const age = Number(data.quoteAgeSeconds);

  const validPrices =
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask > 0 &&
    ask >= bid;

  const marketOpen =
    String(data.marketState || "").toLowerCase() === "open";

  const fresh =
    Number.isFinite(age) &&
    age >= 0 &&
    age <= MAX_QUOTE_AGE_SECONDS &&
    data.stale !== true;

  const quote = {
    symbol,
    description: data.description || symbol,
    bid: validPrices ? bid : null,
    ask: validPrices ? ask : null,
    mid: validPrices ? (bid + ask) / 2 : null,
    high: Number.isFinite(Number(data.high))
      ? Number(data.high)
      : null,
    low: Number.isFinite(Number(data.low))
      ? Number(data.low)
      : null,
    direction: data.direction || "UNKNOWN",
    dayDiffPercent: Number(data.dayDiffPercent) || 0,
    spread: validPrices ? ask - bid : null,
    timestamp: data.timestamp || null,
    lastQuoteAt: data.lastQuoteAt || null,
    quoteAgeSeconds: Number.isFinite(age) ? age : null,
    marketState: data.marketState || "unknown",
    stale: data.stale === true,
    exchange: data.exchange || null,
    source: data.source || "BiQuote",
    validPrices,
    marketOpen,
    fresh,
    tradable: validPrices && marketOpen && fresh
  };

  quoteCache.set(symbol, {
    time: Date.now(),
    data: quote
  });

  return quote;
}

async function getMarketData() {
  const results = await Promise.all(
    SYMBOLS.map(async symbol => {
      try {
        return await getQuote(symbol);
      } catch (error) {
        return {
          symbol,
          available: false,
          error: error.message,
          validPrices: false,
          marketOpen: false,
          fresh: false,
          tradable: false
        };
      }
    })
  );

  lastUpdate = new Date().toISOString();

  return {
    available: results.some(item => item.validPrices),
    provider: "biquote",
    fetchedAt: lastUpdate,
    maxQuoteAgeSeconds: MAX_QUOTE_AGE_SECONDS,
    allMarketsTradable:
      results.length === SYMBOLS.length &&
      results.every(item => item.tradable),
    markets: results
  };
}

// ---------- CANDLE DATA ----------

async function getCandles(symbol, interval, limit = CANDLE_LIMIT) {
  const key = `${symbol}:${interval}`;
  const cached = candleCache.get(key);

  if (cached && Date.now() - cached.time < 30000) {
    return cached.bars;
  }

  const params = new URLSearchParams({
    interval,
    limit: String(limit)
  });

  const data = await fetchJSON(
    `${BIQUOTE_API_URL}/${symbol}/ohlc?${params}`
  );

  if (!Array.isArray(data.bars)) {
    throw new Error(
      `Invalid candle response for ${symbol} ${interval}`
    );
  }

  const bars = data.bars
    .filter(bar =>
      Number.isFinite(Number(bar.open)) &&
      Number.isFinite(Number(bar.high)) &&
      Number.isFinite(Number(bar.low)) &&
      Number.isFinite(Number(bar.close)) &&
      bar.openTime
    )
    .map(bar => ({
      openTime: bar.openTime,
      time: new Date(bar.openTime).getTime(),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume) || 0,
      tickVolume: Number(bar.tickVolume) || 0,
      isOpen: bar.isOpen === true
    }))
    .filter(bar => Number.isFinite(bar.time))
    .filter(bar => !bar.isOpen)
    .sort((a, b) => a.time - b.time);

  candleCache.set(key, {
    time: Date.now(),
    bars
  });

  return bars;
}

// ---------- THREE-MINUTE CANDLES ----------

function buildThreeMinuteCandles(oneMinuteBars) {
  const groups = new Map();

  for (const bar of oneMinuteBars) {
    const bucket = Math.floor(
      bar.time / INTERVAL_MS["3m"]
    ) * INTERVAL_MS["3m"];

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups.get(bucket).push(bar);
  }

  const result = [];

  for (const [time, group] of groups) {
    group.sort((a, b) => a.time - b.time);

    // لا نستخدم مجموعة ناقصة من ثلاث شموع.
    if (group.length !== 3) continue;

    const expected = [
      time,
      time + 60000,
      time + 120000
    ];

    const complete = expected.every(
      (value, index) => group[index].time === value
    );

    if (!complete) continue;

    result.push({
      openTime: new Date(time).toISOString(),
      time,
      open: group[0].open,
      high: Math.max(...group.map(bar => bar.high)),
      low: Math.min(...group.map(bar => bar.low)),
      close: group[2].close,
      volume: group.reduce(
        (sum, bar) => sum + bar.volume,
        0
      ),
      tickVolume: group.reduce(
        (sum, bar) => sum + bar.tickVolume,
        0
      ),
      isOpen: false
    });
  }

  return result;
}

// ---------- TECHNICAL INDICATORS ----------

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    averageGain =
      (averageGain * (period - 1) + Math.max(change, 0)) /
      period;

    averageLoss =
      (averageLoss * (period - 1) + Math.max(-change, 0)) /
      period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

function calculateATR(bars, period = 14) {
  if (bars.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < bars.length; i++) {
    const current = bars[i];
    const previous = bars[i - 1];

    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  const recent = ranges.slice(-period);

  return recent.reduce((sum, value) => sum + value, 0) /
    recent.length;
}

function calculateTrend(bars) {
  if (!Array.isArray(bars) || bars.length < 55) {
    return {
      trend: "unknown",
      strength: null,
      ema20: null,
      ema50: null,
      rsi: null,
      atr: null
    };
  }

  const closes = bars.map(bar => bar.close);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi = calculateRSI(closes, 14);
  const atr = calculateATR(bars, 14);

  const last = closes[closes.length - 1];

  if (
    ema20 === null ||
    ema50 === null ||
    atr === null ||
    !Number.isFinite(rsi)
  ) {
    return {
      trend: "unknown",
      strength: null,
      ema20,
      ema50,
      rsi,
      atr
    };
  }

  const difference = Math.abs(ema20 - ema50);
  const strength = Math.min(
    100,
    Math.round((difference / atr) * 100)
  );

  let trend = "ranging";

  if (ema20 > ema50 && last > ema20 && rsi >= 50) {
    trend = "bullish";
  } else if (
    ema20 < ema50 &&
    last < ema20 &&
    rsi <= 50
  ) {
    trend = "bearish";
  }

  return {
    trend,
    strength,
    ema20,
    ema50,
    rsi,
    atr
  };
}

// ---------- MARKET LEVELS ----------

function calculateLevels(bars) {
  if (!bars || bars.length < 20) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent = bars.slice(-50);

  return {
    support: Math.min(...recent.map(bar => bar.low)),
    resistance: Math.max(...recent.map(bar => bar.high))
  };
}

// ---------- MULTI-TIMEFRAME ANALYSIS ----------

async function analyzeSymbol(symbol) {
  const result = {
    symbol,
    available: false,
    trend: "unknown",
    strength: null,
    condition: "unknown",
    timeframes: {},
    indicators: {},
    levels: {},
    candleCounts: {},
    error: null
  };

  try {
    const candleResults = await Promise.all(
      INTERVALS.map(async interval => ({
        interval,
        bars: await getCandles(symbol, interval)
      }))
    );

    const data = {};

    for (const item of candleResults) {
      data[item.interval] = item.bars;
    }

    data["3m"] = buildThreeMinuteCandles(data["1m"]);

    for (const interval of [
      "1m", "3m", "5m", "15m",
      "30m", "1h", "4h", "1d"
    ]) {
      const bars = data[interval] || [];
      const metrics = calculateTrend(bars);

      result.timeframes[interval] = metrics.trend;
      result.candleCounts[interval] = bars.length;

      if (interval === "5m") {
        result.indicators = {
          ema20: metrics.ema20,
          ema50: metrics.ema50,
          rsi: metrics.rsi,
          atr: metrics.atr
        };

        result.levels = calculateLevels(bars);
      }
    }

    const fiveMinute = calculateTrend(data["5m"]);
    const fifteenMinute = calculateTrend(data["15m"]);
    const hourly = calculateTrend(data["1h"]);

    result.trend = fiveMinute.trend;
    result.strength = fiveMinute.strength;
    result.condition = fiveMinute.trend === "ranging"
      ? "ranging"
      : fiveMinute.trend;

    result.available =
      fiveMinute.trend !== "unknown";

    result.candles = data;

    if (
      fifteenMinute.trend !== "unknown" &&
      hourly.trend !== "unknown"
    ) {
      result.confirmation = {
        "15m": fifteenMinute.trend,
        "1h": hourly.trend
      };
    }

  } catch (error) {
    result.error = error.message;
  }

  analysisCache.set(symbol, result);

  return result;
}

async function getAnalysis() {
  const results = await Promise.all(
    SYMBOLS.map(analyzeSymbol)
  );

  const gold = results.find(item => item.symbol === "XAUUSD");
  const silver = results.find(item => item.symbol === "XAGUSD");

  const available = results.filter(item => item.available);

  let overallTrend = "unknown";

  if (available.length === 2) {
    if (gold.trend === silver.trend) {
      overallTrend = gold.trend;
    } else {
      overallTrend = "ranging";
    }
  } else if (available.length === 1) {
    overallTrend = available[0].trend;
  }

  const strengths = available
    .map(item => item.strength)
    .filter(Number.isFinite);

  const strength = strengths.length
    ? Math.round(
        strengths.reduce((sum, value) => sum + value, 0) /
        strengths.length
      )
    : null;

  const primary = gold || {};

  lastAnalysisUpdate = new Date().toISOString();

  return {
    available: available.length > 0,
    engineReady: true,
    provider: "biquote",
    overallTrend,
    strength,
    condition: overallTrend,
    timeframes: primary.timeframes || {},
    markets: results,
    updatedAt: lastAnalysisUpdate
  };
}

// ---------- SIGNAL VALIDATION ----------

function getSignalKey(symbol) {
  return `signal:${symbol}`;
}

function hasRecentSignal(symbol, side, barTime) {
  const previous = lastSignalTime.get(getSignalKey(symbol));

  if (!previous) return false;

  return (
    previous.side === side ||
    barTime - previous.time < 15 * 60 * 1000
  );
}

function buildSignal(symbol, bars, analysis) {
  if (!bars || bars.length < 60) return null;

  const current = bars[bars.length - 1];
  const previous = bars[bars.length - 2];

  const closes = bars.map(bar => bar.close);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atr = calculateATR(bars, 14);

  if (!ema20 || !ema50 || !atr || atr <= 0) {
    return null;
  }

  const body = Math.abs(current.close - current.open);
  const lowerWick =
    Math.min(current.open, current.close) - current.low;

  const upperWick =
    current.high - Math.max(current.open, current.close);

  const bullishRejection =
    current.close > current.open &&
    lowerWick >= body * 0.5 &&
    current.low <= ema20 + atr * 0.20 &&
    current.close > ema20 &&
    current.close > previous.high;

  const bearishRejection =
    current.close < current.open &&
    upperWick >= body * 0.5 &&
    current.high >= ema20 - atr * 0.20 &&
    current.close < ema20 &&
    current.close < previous.low;

  const trend15 = analysis.timeframes["15m"];
  const trend1h = analysis.timeframes["1h"];

  let side = null;

  if (
    ema20 > ema50 &&
    trend15 === "bullish" &&
    trend1h === "bullish" &&
    bullishRejection
  ) {
    side = "BUY";
  }

  if (
    ema20 < ema50 &&
    trend15 === "bearish" &&
    trend1h === "bearish" &&
    bearishRejection
  ) {
    side = "SELL";
  }

  if (!side) return null;

  const entry = current.close;

  let sl;
  let risk;

  const recent = bars.slice(-6);

  if (side === "BUY") {
    const swingLow = Math.min(
      ...recent.map(bar => bar.low)
    );

    sl = Math.min(
      swingLow,
      entry - atr * 1.2
    );

    risk = entry - sl;
  } else {
    const swingHigh = Math.max(
      ...recent.map(bar => bar.high)
    );

    sl = Math.max(
      swingHigh,
      entry + atr * 1.2
    );

    risk = sl - entry;
  }

  if (!Number.isFinite(risk) || risk <= 0) {
    return null;
  }

  const tp1 = side === "BUY"
    ? entry + risk
    : entry - risk;

  const tp2 = side === "BUY"
    ? entry + risk * 2
    : entry - risk * 2;

  return {
    symbol,
    side,
    entry,
    tp1,
    tp2,
    sl,
    timeframe: "5m",
    candleTime: current.openTime,
    risk,
    method: "EMA + RSI + ATR + Multi-timeframe rejection"
  };
}

// ---------- TELEGRAM ----------

async function publishTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return {
      success: false,
      message: "Telegram is not configured"
    };
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    }),
    signal: AbortSignal.timeout(10000)
  });

  const result = await response.json();

  return {
    success: response.ok && result.ok === true,
    result
  };
}

// ---------- SIGNAL STORAGE AND PUBLISHING ----------

function formatSignalMessage(signal) {
  return [
    "SMC Trading Pro",
    "",
    signal.side === "BUY"
      ? `🟢 إشارة شراء ${signal.symbol}`
      : `🔴 إشارة بيع ${signal.symbol}`,
    `الإطار الزمني: ${signal.timeframe}`,
    `الدخول: ${signal.entry}`,
    `الهدف الأول TP1: ${signal.tp1}`,
    `الهدف الثاني TP2: ${signal.tp2}`,
    `وقف الخسارة SL: ${signal.sl}`,
    "",
    "التحليل: EMA + RSI + ATR",
    "مصدر الأسعار: BiQuote",
    `وقت الإشارة: ${signal.createdAt}`,
    "",
    "إدارة المخاطر مسؤولية المتداول."
  ].join("\n");
}

async function publishSignal(signal) {
  if (!SYMBOLS.includes(signal.symbol)) {
    return {
      success: false,
      message: "Unsupported market"
    };
  }

  const marketData = await getMarketData();

  const market = marketData.markets.find(
    item => item.symbol === signal.symbol
  );

  if (!market || !market.tradable) {
    return {
      success: false,
      blocked: true,
      message: !market
        ? "Market data unavailable"
        : !market.marketOpen
          ? "Signal blocked: market is closed"
          : !market.fresh
            ? "Signal blocked: quote is stale"
            : "Signal blocked: invalid market prices"
    };
  }

  const side = String(signal.side || "").toUpperCase();

  if (!["BUY", "SELL"].includes(side)) {
    return {
      success: false,
      message: "Invalid signal side"
    };
  }

  const entry = Number(signal.entry);
  const tp1 = Number(signal.tp1);
  const tp2 = Number(signal.tp2);
  const sl = Number(signal.sl);

  if (![entry, tp1, tp2, sl].every(
    value => Number.isFinite(value) && value > 0
  )) {
    return {
      success: false,
      message: "Invalid signal prices"
    };
  }

  const validTargets = side === "BUY"
    ? sl < entry && entry < tp1 && tp1 < tp2
    : tp2 < tp1 && tp1 < entry && entry < sl;

  if (!validTargets) {
    return {
      success: false,
      message: "Invalid target or stop-loss order"
    };
  }

  const record = {
    id: `${Date.now()}-${signal.symbol}`,
    symbol: signal.symbol,
    side,
    entry,
    tp1,
    tp2,
    sl,
    timeframe: signal.timeframe || "5m",
    createdAt: new Date().toISOString(),
    marketPrice: market.mid,
    telegramSent: false
  };

  const telegram = await publishTelegram(
    formatSignalMessage(record)
  );

  record.telegramSent = telegram.success;

  signals.unshift(record);
  signals = signals.slice(0, SIGNAL_HISTORY_LIMIT);

  lastSignalTime.set(getSignalKey(signal.symbol), {
    side,
    time: Date.now()
  });

  return {
    success: true,
    signal: record,
    telegram
  };
}

// ---------- AUTOMATIC SIGNAL ENGINE ----------

async function runSignalEngine() {
  if (analysisRunning) return;

  analysisRunning = true;

  try {
    const marketData = await getMarketData();

    const analyses = await Promise.all(
      SYMBOLS.map(analyzeSymbol)
    );

    for (const symbol of SYMBOLS) {
      const market = marketData.markets.find(
        item => item.symbol === symbol
      );

      // لا إشارات عند إغلاق السوق أو قدم الأسعار.
      if (!market || !market.tradable) continue;

      const analysis = analyses.find(
        item => item.symbol === symbol
      );

      if (!analysis || !analysis.available) continue;

      const bars = analysis.candles?.["5m"];

      if (!bars || bars.length < 60) continue;

      const latest = bars[bars.length - 1];
      const barKey = `${symbol}:5m`;
      const previousTime = lastProcessedBar.get(barKey);

      if (previousTime === latest.time) continue;

      // لا نرسل إشارة على شمعة قديمة.
      const candleCloseTime =
        latest.time + INTERVAL_MS["5m"];

      if (
        Date.now() - candleCloseTime >
        10 * 60 * 1000
      ) {
        lastProcessedBar.set(barKey, latest.time);
        continue;
      }

      lastProcessedBar.set(barKey, latest.time);

      const signal = buildSignal(
        symbol,
        bars,
        analysis
      );

      if (!signal) continue;

      if (
        hasRecentSignal(
          symbol,
          signal.side,
          latest.time
        )
      ) {
        continue;
      }

      await publishSignal(signal);
    }

  } catch (error) {
    console.error("Signal engine:", error.message);
  } finally {
    analysisRunning = false;
  }
}

// ---------- REQUEST BODY ----------

function isAuthorized(req) {
  return Boolean(
    WEBHOOK_SECRET &&
    req.headers["x-webhook-secret"] === WEBHOOK_SECRET
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;

      if (size > 10000) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }

      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

// ---------- API SERVER ----------

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJSON(res, 200, {
      success: true
    });
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  try {
    if (req.method === "GET" && url.pathname === "/") {
      return sendJSON(res, 200, {
        name: "SMC Trading Pro",
        status: "running",
        version: "2.0.0",
        provider: "BiQuote",
        markets: SYMBOLS
      });
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/status"
    ) {
      return sendJSON(res, 200, getStatus());
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/markets"
    ) {
      return sendJSON(
        res,
        200,
        await getMarketData()
      );
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/analysis"
    ) {
      return sendJSON(
        res,
        200,
        await getAnalysis()
      );
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/signals"
    ) {
      const limit = Math.min(
        100,
        Math.max(
          1,
          Number(url.searchParams.get("limit") || 20)
        )
      );

      return sendJSON(res, 200, {
        signals: signals.slice(0, limit),
        count: signals.length
      });
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/signals/publish"
    ) {
      if (!isAuthorized(req)) {
        return sendJSON(res, 401, {
          success: false,
          message: "Unauthorized"
        });
      }

      const body = await readBody(req);
      const result = await publishSignal(body);

      return sendJSON(
        res,
        result.success ? 200 : 409,
        result
      );
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/telegram/test"
    ) {
      if (!isAuthorized(req)) {
        return sendJSON(res, 401, {
          success: false,
          message: "Unauthorized"
        });
      }

      const result = await publishTelegram(
        "اختبار اتصال SMC Trading Pro\nهذه رسالة اختبار وليست إشارة تداول."
      );

      return sendJSON(
        res,
        result.success ? 200 : 503,
        result
      );
    }

    return sendJSON(res, 404, {
      success: false,
      message: "Endpoint not found"
    });

  } catch (error) {
    console.error("API error:", error);

    return sendJSON(res, 500, {
      success: false,
      message: error.message || "Internal server error"
    });
  }
});

// ---------- START ----------

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `SMC Trading Pro v2 running on port ${PORT}`
  );

  // بدء محرك التحليل بعد تشغيل الخادم.
  runSignalEngine();

  setInterval(() => {
    runSignalEngine();
  }, POLL_INTERVAL_MS);
});
