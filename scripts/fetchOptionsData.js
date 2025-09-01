const axios = require('axios');
const math = require('mathjs');
const fs = require('fs');

// ---------- helpers (math) ----------
const SQRT2 = Math.SQRT2;
const N = (x) => 0.5 * (1 + math.erf(x / SQRT2));           // standard normal CDF
const n = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); // PDF

function bsD1(S, K, T, r, sigma) {
  return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}

function bsPrice(S, K, T, r, sigma, type) {
  const d1 = bsD1(S, K, T, r, sigma);
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === 'call') return S * N(d1) - K * Math.exp(-r * T) * N(d2);
  return K * Math.exp(-r * T) * N(-d2) - S * N(-d1); // put
}

function bsVega(S, K, T, r, sigma) {
  const d1 = bsD1(S, K, T, r, sigma);
  return S * Math.sqrt(T) * n(d1);
}

function impliedVol(price, S, K, T, r, type) {
  if (!isFinite(price) || price <= 0 || !isFinite(T) || T <= 0) return null;

  let sigma = 0.5;               // start guess
  const MAX_IT = 60;
  for (let i = 0; i < MAX_IT; i++) {
    const model = bsPrice(S, K, T, r, sigma, type);
    const diff = model - price;
    if (Math.abs(diff) < 1e-4) return +sigma.toFixed(4);
    const v = bsVega(S, K, T, r, sigma);
    if (!isFinite(v) || v < 1e-8) break;    // avoid blowing up
    sigma = Math.max(0.0001, Math.min(5, sigma - diff / v)); // NR step with clamping
  }
  return +sigma.toFixed(4);
}

// ---------- config ----------
const BASE = 'https://www.deribit.com/api/v2';
const DOCS_PATH = './docs/cvi.json';
const RISK_FREE = 0.01;

// ensure docs folder exists
if (!fs.existsSync('./docs')) fs.mkdirSync('./docs', { recursive: true });

async function getSpot() {
  const { data } = await axios.get(`${BASE}/public/get_index_price`, { params: { index_name: 'btc_usd' } });
  return data?.result?.index_price;
}

async function getActiveOptions() {
  const { data } = await axios.get(`${BASE}/public/get_instruments`, {
    params: { currency: 'BTC', kind: 'option', expired: false },
  });
  return (data?.result || []).filter(o => o.is_active);
}

async function getTicker(instrument_name) {
  const { data } = await axios.get(`${BASE}/public/ticker`, { params: { instrument_name } });
  const t = data?.result || {};
  // robust option price: mark -> mid(bid/ask) -> last
  if (isFinite(t.mark_price)) return t.mark_price;
  if (isFinite(t.best_bid_price) && isFinite(t.best_ask_price))
    return (t.best_bid_price + t.best_ask_price) / 2;
  if (isFinite(t.last_price)) return t.last_price;
  return null;
}

function yearsToExpiry(expiration_ms) {
  const ms = Math.max(0, expiration_ms - Date.now());
  return ms / (365 * 24 * 60 * 60 * 1000);
}

async function fetchOptionsData() {
  try {
    const S = await getSpot();
    if (!isFinite(S)) {
      console.error('Spot price unavailable; aborting.');
      return;
    }

    const options = await getActiveOptions();
    if (!options.length) {
      console.error('No active options returned.');
      return;
    }

    // pick a focused set: near-the-money, soonest expiries
    const candidates = options
      .sort((a, b) => Math.abs(a.strike - S) - Math.abs(b.strike - S) || a.expiration_timestamp - b.expiration_timestamp)
      .slice(0, 60); // limit requests

    const rows = [];
    for (const opt of candidates) {
      const price = await getTicker(opt.instrument_name);
      const T = yearsToExpiry(opt.expiration_timestamp);
      const type = opt.option_type === 'put' ? 'put' : 'call';

      if (!isFinite(price) || price <= 0 || T <= 0) continue;

      const iv = impliedVol(price, S, opt.strike, T, RISK_FREE, type);
      if (iv !== null && isFinite(iv)) {
        rows.push({
          instrument: opt.instrument_name,
          option_type: type,
          strike: opt.strike,
          expiration: opt.expiration_timestamp,
          spot: +S,
          option_price: +price,
          implied_volatility: iv
        });
      }
    }

    // sort by strike for a clean chart
    rows.sort((a, b) => a.strike - b.strike);

    // write file (creates if missing, overwrites if present)
    fs.writeFileSync(DOCS_PATH, JSON.stringify(rows, null, 2));
    console.log(`Saved ${rows.length} IV points -> ${DOCS_PATH}`);
  } catch (err) {
    console.error('Fatal error building CVI:', err?.response?.data || err);
  }
}

fetchOptionsData();
