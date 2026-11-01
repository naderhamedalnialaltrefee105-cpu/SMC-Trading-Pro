
"use strict";

/*
 * SMC Trading Pro
 * Frontend application
 * Market data provider: BiQuote (through our server)
 */

const API = {
  status: "/api/status",
  markets: "/api/markets",
  analysis: "/api/analysis",
  signals: "/api/signals?limit=20"
};

const $ = (id) => document.getElementById(id);

const state = {
  loading: false,
  lastUpdate: null,
  signals: []
};

const TIMEFRAMES = [
  ["1m", "1 دقيقة"],
  ["3m", "3 دقائق"],
  ["5m", "5 دقائق"],
  ["15m", "15 دقيقة"],
  ["30m", "30 دقيقة"],
  ["1h", "ساعة"],
  ["4h", "4 ساعات"],
  ["1d", "يومي"]
];

// ---------- GENERAL HELPERS ----------

function formatPrice(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return "--";

  return number.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3
  });
}

function formatTime(value) {
  if (!value) return "--";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "--";

  return date.toLocaleTimeString("ar-SA", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value ?? "--";
}

function setStatus(id, text, connected) {
  const element = $(id);
  if (!element) return;

  element.textContent = text;

  element.classList.toggle("connected", Boolean(connected));
  element.classList.toggle("disconnected", !connected);
}

async function apiGet(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Server error: ${response.status}`);
  }

  return response.json();
}

// ---------- NOTIFICATIONS ----------

function showToast(message, type = "info") {
  const container = $("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3500);
}

// ---------- DATE ----------

function updateDate() {
  const element = $("current-date");
  if (!element) return;

  element.textContent = new Date().toLocaleDateString("ar-SA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

// ---------- MARKET PRICES ----------

function updateMarketCard(symbol, data) {
  const isGold = symbol === "XAUUSD";

  const priceId = isGold ? "gold-price" : "silver-price";
  const changeId = isGold ? "gold-change" : "silver-change";

  if (!data || data.price === undefined) {
    setText(priceId, "--");
    setText(changeId, "بانتظار البيانات");
    return;
  }

  setText(priceId, formatPrice(data.price));

  const change = Number(data.change ?? 0);
  const percent = Number(data.changePercent ?? 0);

  const changeElement = $(changeId);

  if (changeElement) {
    const sign = change > 0 ? "+" : "";

    changeElement.textContent =
      `${sign}${formatPrice(change)} (${sign}${percent.toFixed(2)}%)`;

    changeElement.classList.toggle("positive", change > 0);
    changeElement.classList.toggle("negative", change < 0);
  }
}

async function loadMarkets() {
  try {
    const result = await apiGet(API.markets);

    updateMarketCard("XAUUSD", result.XAUUSD);
    updateMarketCard("XAGUSD", result.XAGUSD);

    state.lastUpdate = result.updatedAt || new Date().toISOString();
    setText("last-update", formatTime(state.lastUpdate));

  } catch (error) {
    console.error("Market data:", error);

    setText("gold-change", "تعذر جلب السعر");
    setText("silver-change", "تعذر جلب السعر");
  }
}

// ---------- MARKET ANALYSIS ----------

function translateTrend(value) {
  const trend = String(value || "").toLowerCase();

  const translations = {
    bullish: "صاعد",
    bearish: "هابط",
    ranging: "متذبذب",
    sideways: "متذبذب",
    neutral: "محايد",
    unknown: "غير محدد"
  };

  return translations[trend] || value || "--";
}

async function loadAnalysis() {
  try {
    const result = await apiGet(API.analysis);

    setText("overall-trend", translateTrend(result.overallTrend));

    setText(
      "trend-strength",
      result.strength !== undefined
        ? `${result.strength}%`
        : "--"
    );

    setText(
      "market-condition",
      translateTrend(result.condition)
    );

    const timeframes = result.timeframes || {};

    for (const [key] of TIMEFRAMES) {
      const elementId = `trend-${key}`;
      setText(elementId, translateTrend(timeframes[key]));
    }

  } catch (error) {
    console.error("Market analysis:", error);
  }
}

// ---------- SIGNALS ----------

function createCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value ?? "--";
  return cell;
}

function signalSide(signal) {
  const side = String(signal.side || signal.type || "").toLowerCase();

  if (side === "buy" || side === "شراء") return "شراء";
  if (side === "sell" || side === "بيع") return "بيع";

  return signal.side || signal.type || "--";
}

function renderSignalCard(signal) {
  const card = document.createElement("article");
  card.className = "signal-card";

  const side = signalSide(signal);
  const isBuy = side === "شراء";

  const heading = document.createElement("div");
  heading.className = "signal-card-header";

  const title = document.createElement("strong");
  title.textContent = `${signal.symbol || "--"} | ${side}`;
  title.className = isBuy ? "buy-text" : "sell-text";

  const time = document.createElement("span");
  time.textContent = formatTime(signal.time || signal.createdAt);

  heading.append(title, time);

  const details = document.createElement("div");
  details.className = "signal-details";

  const values = [
    ["الدخول", signal.entry],
    ["الهدف الأول TP1", signal.tp1],
    ["الهدف الثاني TP2", signal.tp2],
    ["وقف الخسارة SL", signal.sl]
  ];

  for (const [label, value] of values) {
    const item = document.createElement("div");

    const name = document.createElement("span");
    name.textContent = label;

    const price = document.createElement("strong");
    price.textContent = formatPrice(value);

    item.append(name, price);
    details.appendChild(item);
  }

  card.append(heading, details);

  return card;
}

function renderSignals(signals) {
  const container = $("signal-list");
  const empty = $("signals-empty");
  const history = $("history-table-body");

  if (!container || !history) return;

  container.querySelectorAll(".signal-card").forEach(item => item.remove());
  history.replaceChildren();

  if (!Array.isArray(signals) || signals.length === 0) {
    if (empty) empty.hidden = false;

    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 7;
    cell.className = "table-empty";
    cell.textContent = "لا توجد بيانات مسجلة";

    row.appendChild(cell);
    history.appendChild(row);

    setText("signal-count", "0 إشارة");
    return;
  }

  if (empty) empty.hidden = true;

  setText("signal-count", `${signals.length} إشارة`);

  signals.forEach(signal => {
    container.appendChild(renderSignalCard(signal));

    const row = document.createElement("tr");

    row.append(
      createCell(formatTime(signal.time || signal.createdAt)),
      createCell(signal.symbol),
      createCell(signalSide(signal)),
      createCell(formatPrice(signal.entry)),
      createCell(formatPrice(signal.tp1)),
      createCell(formatPrice(signal.tp2)),
      createCell(formatPrice(signal.sl))
    );

    history.appendChild(row);
  });
}

async function loadSignals() {
  try {
    const result = await apiGet(API.signals);

    const signals = Array.isArray(result)
      ? result
      : result.signals || [];

    state.signals = signals;
    renderSignals(signals);

  } catch (error) {
    console.error("Signals:", error);
  }
}

// ---------- SERVER STATUS ----------

async function loadStatus() {
  try {
    const result = await apiGet(API.status);

    const online = result.ok === true || result.status === "online";

    setStatus(
      "server-status",
      online ? "متصل" : "غير متصل",
      online
    );

    setStatus(
      "sidebar-status-text",
      online ? "الخادم متصل" : "الخادم غير متصل",
      online
    );

    setStatus(
      "system-status",
      online ? "النظام متصل" : "النظام غير متصل",
      online
    );

    const provider = String(result.provider || "").toLowerCase();

    setText(
      "webhook-status",
      provider === "biquote"
        ? "BiQuote متصل"
        : "بانتظار بيانات BiQuote"
    );

    setText(
      "telegram-status",
      result.telegram === true ? "متصل" : "غير مفحوص"
    );

  } catch (error) {
    console.error("Server status:", error);

    setStatus("server-status", "غير متصل", false);
    setStatus("sidebar-status-text", "الخادم غير متصل", false);
    setStatus("system-status", "الخادم غير متصل", false);

    setText("webhook-status", "بانتظار الخادم");
    setText("telegram-status", "غير مفحوص");
  }
}

// ---------- REFRESH ----------

async function refreshDashboard() {
  if (state.loading) return;

  state.loading = true;

  const button = $("refresh-button");

  if (button) {
    button.disabled = true;
    button.classList.add("is-loading");
  }

  try {
    await Promise.all([
      loadStatus(),
      loadMarkets(),
      loadAnalysis(),
      loadSignals()
    ]);
  } finally {
    state.loading = false;

    if (button) {
      button.disabled = false;
      button.classList.remove("is-loading");
    }
  }
}

// ---------- MOBILE MENU ----------

function setupMenu() {
  const button = $("menu-toggle");
  const sidebar = $("sidebar");

  if (!button || !sidebar) return;

  button.addEventListener("click", () => {
    sidebar.classList.toggle("open");
  });

  document.querySelectorAll(".nav-link").forEach(link => {
    link.addEventListener("click", () => {
      sidebar.classList.remove("open");
    });
  });
}

// ---------- NAVIGATION ----------

function setupNavigation() {
  document.querySelectorAll(".nav-link").forEach(link => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".nav-link").forEach(item => {
        item.classList.remove("active");
      });

      link.classList.add("active");
    });
  });
}

// ---------- INITIALIZATION ----------

function initializeApp() {
  updateDate();
  setupMenu();
  setupNavigation();

  const refreshButton = $("refresh-button");

  if (refreshButton) {
    refreshButton.addEventListener("click", () => {
      refreshDashboard();
      showToast("جاري تحديث بيانات النظام", "info");
    });
  }

  refreshDashboard();

  // Update dashboard every 15 seconds.
  setInterval(() => {
    refreshDashboard();
  }, 15000);

  console.log("SMC Trading Pro initialized.");
}

document.addEventListener("DOMContentLoaded", initializeApp);
