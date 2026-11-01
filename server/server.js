
"use strict";

const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const BIQUOTE_API_URL = process.env.BIQUOTE_API_URL || "";
const BIQUOTE_API_KEY = process.env.BIQUOTE_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const SYMBOLS = ["XAUUSD", "XAGUSD"];

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
    serverTime: new Date().toISOString()
  };
}

async function getMarketData() {
  if (!BIQUOTE_API_URL) {
    return {
      available: false,
      message: "BiQuote API is not configured",
      markets: []
    };
  }

  try {
    const headers = {
      "Accept": "application/json"
    };

    if (BIQUOTE_API_KEY) {
      headers["Authorization"] = `Bearer ${BIQUOTE_API_KEY}`;
    }

    const response = await fetch(BIQUOTE_API_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`BiQuote HTTP ${response.status}`);
    }

    const data = await response.json();

    // لا نفترض شكل بيانات BiQuote قبل التحقق من استجابته.
    return {
      available: true,
      verified: false,
      message: "Provider response received; data mapping is pending",
      rawData: data
    };

  } catch (error) {
    return {
      available: false,
      message: error.message,
      markets: []
    };
  }
}

function getAnalysis() {
  return {
    available: false,
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

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJSON(res, 200, { success: true });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    return sendJSON(res, 200, {
      name: "SMC Trading Pro",
      status: "running",
      version: "1.0.0"
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
      Math.max(1, Number(url.searchParams.get("limit") || 20))
    );

    return sendJSON(res, 200, {
      signals: getSignals(limit),
      count: signals.length
    });
  }

  if (req.method === "POST" && url.pathname === "/api/telegram/test") {
    if (!WEBHOOK_SECRET ||
        req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
      return sendJSON(res, 401, {
        success: false,
        message: "Unauthorized"
      });
    }

    const result = await publishTelegram(
      "اختبار اتصال SMC Trading Pro"
    );

    return sendJSON(res, result.success ? 200 : 503, result);
  }

  return sendJSON(res, 404, {
    success: false,
    message: "Endpoint not found"
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SMC Trading Pro server running on port ${PORT}`);
});
