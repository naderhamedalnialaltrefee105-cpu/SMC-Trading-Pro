"use strict";

const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const BIQUOTE_API_URL = (
  process.env.BIQUOTE_API_URL || "https://biquote.io/api"
).replace(/\/+$/, "");

const BIQUOTE_API_KEY = process.env.BIQUOTE_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const SYMBOLS = ["XAUUSD", "XAGUSD"];
const MAX_QUOTE_AGE_SECONDS = 120;

let signals = [];
let lastUpdate = null;

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
    markets: SYMBOLS,
    lastUpdate,
    maxQuoteAgeSeconds: MAX_QUOTE_AGE_SECONDS,
    serverTime: new Date().toISOString()
  };
}

async function getQuote(symbol) {
  const headers = {
    Accept: "application/json"
  };

  if (BIQUOTE_API_KEY) {
    headers.Authorization = `Bearer ${BIQUOTE_API_KEY}`;
  }

  const response = await fetch(
    `${BIQUOTE_API_URL}/${symbol}`,
    {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    throw new Error(
      `${symbol}: BiQuote HTTP ${response.status}`
    );
  }

  const data = await response.json();

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

  return {
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
}

async function getMarketData() {
  const results = await Promise.all(
    SYMBOLS.map(async (symbol) => {
      try {
        return await getQuote(symbol);
      } catch (error) {
        return {
          symbol,
          available: false,
          error: error.message,
          tradable: false
        };
      }
    })
  );

  lastUpdate = new Date().toISOString();

  const availableMarkets = results.filter(
    market => market.validPrices
  );

  return {
    available: availableMarkets.length > 0,
    provider: "biquote",
    fetchedAt: lastUpdate,
    maxQuoteAgeSeconds: MAX_QUOTE_AGE_SECONDS,
    allMarketsTradable:
      results.length === SYMBOLS.length &&
      results.every(market => market.tradable === true),
    markets: results
  };
}

function getAnalysis() {
  return {
    available: false,
    engineReady: false,
    message: "Market analysis engine is not configured yet",
    trend: "unknown",
    strength: null,
    condition: "unknown"
  };
}

function getSignals(limit = 20) {
  return signals.slice(0, limit);
}

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

async function publishSignal(signal) {
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
            : "Signal blocked: invalid market prices",
      market
    };
  }

  const side = String(signal.side || "").toUpperCase();

  if (!["BUY", "SELL"].includes(side)) {
    return {
      success: false,
      message: "Side must be BUY or SELL"
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
      message: "Invalid entry, TP1, TP2 or SL"
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
    createdAt: new Date().toISOString(),
    marketPrice: market.mid
  };

  const message = [
    `SMC Trading Pro`,
    ``,
    `${side === "BUY" ? "🟢 شراء" : "🔴 بيع"} ${record.symbol}`,
    `الدخول: ${entry}`,
    `الهدف الأول TP1: ${tp1}`,
    `الهدف الثاني TP2: ${tp2}`,
    `وقف الخسارة SL: ${sl}`,
    ``,
    `السعر من BiQuote`,
    `وقت الإشارة: ${record.createdAt}`
  ].join("\n");

  const telegram = await publishTelegram(message);

  record.telegramSent = telegram.success;

  signals.unshift(record);
  signals = signals.slice(0, 200);

  return {
    success: true,
    signal: record,
    telegram
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJSON(res, 200, { success: true });
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
        version: "1.1.0"
      });
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJSON(res, 200, getStatus());
    }

    if (req.method === "GET" && url.pathname === "/api/markets") {
      const data = await getMarketData();
      return sendJSON(res, 200, data);
    }

    if (req.method === "GET" && url.pathname === "/api/analysis") {
      return sendJSON(res, 200, getAnalysis());
    }

    if (req.method === "GET" && url.pathname === "/api/signals") {
      const limit = Math.min(
        100,
        Math.max(
          1,
          Number(url.searchParams.get("limit") || 20)
        )
      );

      return sendJSON(res, 200, {
        signals: getSignals(limit),
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

      if (!SYMBOLS.includes(body.symbol)) {
        return sendJSON(res, 400, {
          success: false,
          message: "Unsupported market"
        });
      }

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
    console.error(error);

    return sendJSON(res, 500, {
      success: false,
      message: error.message || "Internal server error"
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `SMC Trading Pro server running on port ${PORT}`
  );
});
