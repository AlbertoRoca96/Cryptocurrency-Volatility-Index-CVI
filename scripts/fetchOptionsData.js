// scripts/fetchOptionsData.js
const axios = require("axios");
const fs = require("fs");

// ---------- helpers ----------
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function readJsonSafe(path, fallback) {
  try {
    if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (_) {}
  return fallback;
}
function writeJson(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2));
}

// Normal PDF/CDF (Abramowitz-Stegun approx)
function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
function normCdf(x) {
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const a1 = 0.319381530, a2 = -0.356563782, a3 = 1.781477937, a4 = -1.821255978, a5 = 1.330274429;
  const poly = ((((a5 * k + a4) * k + a3) * k + a2) * k + a1) * k;
  const approx = 1 - normPdf(Math.abs(x)) * poly;
  return x >= 0 ? approx : 1 - approx;
}

// Black–Scholes prices + vega
function bsPrice({ S, K, T, r, sigma, isCall }) {
  if (T <= 0 || sigma <= 0) return Math.max((isCall ? S - K : K - S), 0);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (isCall) return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}
function bsVega({ S, K, T, r, sigma }) {
  if (T <= 0 || sigma <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  return S * sqrtT * normPdf(d1);
}

// Invert Black–Scholes via Newton–Raphson
function impliedVol({ price, S, K, T, r, isCall }) {
  let sigma = 0.3;                      // initial guess
  const MAX_ITERS = 100, TOL = 1e-6, MIN = 1e-4, MAX = 3.0;

  for (let i = 0; i < MAX_ITERS; i++) {
    const p = bsPrice({ S, K, T, r, sigma, isCall });
    const v = bsVega({ S, K, T, r, sigma }) || 1e-8;
    const diff = p - price;
    if (Math.abs(diff) < TOL) break;
    sigma = Math.min(MAX, Math.max(MIN, sigma - diff / v));
  }
  return Number(sigma.toFixed(6));
}

// ---------- main job ----------
async function fetchOptionsData() {
  ensureDir("./docs");

  // 1) Get the full option instrument list (strike + expiry)
  const instRes = await axios.get(
    "https://www.deribit.com/api/v2/public/get_instruments",
    { params: { currency: "BTC", kind: "option" } }
  );
  const instruments = instRes.data?.result || [];
  const instMap = new Map(
    instruments.map(o => [
      o.instrument_name,
      { strike: o.strike, expiryMs: o.expiration_timestamp, optionType: o.option_type } // call/put
    ])
  );

  // 2) Get book summaries (mark_price + underlying)
  const bookRes = await axios.get(
    "https://www.deribit.com/api/v2/public/get_book_summary_by_currency",
    { params: { currency: "BTC", kind: "option" } }
  );
  const book = bookRes.data?.result || [];

  if (!book.length) {
    console.log("No option book data returned; leaving previous files unchanged.");
    return;
  }

  const nowMs = Date.now();
  // Build joined rows we can work with
  const rows = book
    .map(x => {
      const meta = instMap.get(x.instrument_name);
      if (!meta) return null;
      const K = meta.strike;
      const S = x.underlying_price || null;
      const mark = x.mark_price || x.last_price || null;
      const Tyears = Math.max( (meta.expiryMs - nowMs) / (365 * 24 * 3600 * 1000), 0 );
      const isCall = (meta.optionType || "").toLowerCase() === "call" || x.instrument_name.endsWith("-C");
      return (S && mark && K && Tyears > 0) ? { name: x.instrument_name, S, K, T: Tyears, mark, isCall } : null;
    })
    .filter(Boolean);

  if (!rows.length) {
    console.log("No usable rows (missing mark/S/K/T).");
    return;
  }

  // 3) Pick an expiry ~30 days (20–40 day window; fall back to closest >7 days)
  const days = r => r.T * 365;
  const target = rows
    .filter(r => days(r) >= 20 && days(r) <= 40)
    .sort((a, b) => Math.abs(days(a) - 30) - Math.abs(days(b) - 30));
  const candidateSet = (target.length ? target : rows.filter(r => days(r) > 7))
    .sort((a, b) => a.T - b.T);
  if (!candidateSet.length) {
    console.log("No expiries > 7 days; aborting.");
    return;
  }
  const expiryT = candidateSet[0].T; // use the closest matching expiry
  const sameExpiry = rows.filter(r => Math.abs(r.T - expiryT) < 1e-6);

  // 4) Compute IVs for that expiry (volatility smile)
  const r = 0.01; // risk-free
  const smile = sameExpiry.map(rw => ({
    strike: rw.K,
    implied_volatility: impliedVol({ price: rw.mark, S: rw.S, K: rw.K, T: rw.T, r, isCall: rw.isCall })
  }))
  .filter(d => Number.isFinite(d.implied_volatility))
  .sort((a, b) => a.strike - b.strike);

  // 5) Compute a single “CVI number”: ATM IV (strike closest to S)
  const Sref = sameExpiry[0].S; // they all share same underlying snapshot
  let atm = null, minDist = Infinity;
  for (const rw of sameExpiry) {
    const iv = impliedVol({ price: rw.mark, S: rw.S, K: rw.K, T: rw.T, r, isCall: rw.isCall });
    const dist = Math.abs(rw.K - Sref);
    if (Number.isFinite(iv) && dist < minDist) {
      minDist = dist;
      atm = iv;
    }
  }

  // 6) Write docs/cvi.json (smile) and append docs/cvi_timeseries.json
  writeJson("./docs/cvi.json", smile);

  const seriesPath = "./docs/cvi_timeseries.json";
  const series = readJsonSafe(seriesPath, []);
  const nowIso = new Date().toISOString();

  // de-dup if last point is within 20 minutes
  const last = series[series.length - 1];
  const shouldAppend =
    !last ||
    (Date.now() - new Date(last.timestamp).getTime()) > 20 * 60 * 1000 ||
    Math.abs(last.cvi - atm) > 1e-6;

  if (atm != null && shouldAppend) {
    series.push({ timestamp: nowIso, cvi: Number(atm.toFixed(6)) });
    // keep the last 2000 points to avoid repo bloat
    while (series.length > 2000) series.shift();
  }
  writeJson(seriesPath, series);

  console.log(`Wrote ${smile.length} smile points to docs/cvi.json`);
  console.log(`Appended CVI=${atm} at ${nowIso} to docs/cvi_timeseries.json`);
}

fetchOptionsData().catch(err => {
  console.error("Fatal error in fetchOptionsData:", err?.message || err);
  process.exit(1);
});
