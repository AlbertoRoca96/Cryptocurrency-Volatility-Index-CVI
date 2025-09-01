const axios = require('axios');
const fs = require('fs');

// ---------- math helpers ----------
const SQRT2 = Math.SQRT2;
const N = (x) => 0.5 * (1 + erf(x / SQRT2));
const n = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

// Accurate erf (Abramowitz–Stegun 7.1.26)
function erf(x) {
  const sign = Math.sign(x);
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function bsD1(S, K, T, r, sigma) {
  return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}
function bsPrice(S, K, T, r, sigma, type) {
  const d1 = bsD1(S, K, T, r, sigma);
  const d2 = d1 - sigma * Math.sqrt(T);
  return type === 'put'
    ? K * Math.exp(-r * T) * N(-d2) - S * N(-d1)
    : S * N(d1) - K * Math.exp(-r * T) * N(d2);
}
function bsVega(S, K, T, r, sigma) {
  const d1 = bsD1(S, K, T, r, sigma);
  return S * Math.sqrt(T) * n(d1);
}
function impliedVol(price, S, K, T, r, type) {
  if (!isFinite(price) || price <= 0 || !isFinite(T) || T <= 0) return null;
  let sigma = 0.5;
  for (let i = 0; i < 60; i++) {
    const f = bsPrice(S, K, T, r, sigma, type) - price;
    if (Math.abs(f) < 1e-4) return +sigma.toFixed(4);
    const v = bsVega(S, K, T, r, sigma);
    if (!isFinite(v) || v < 1e-8) break;
    sigma = Math.max(0.0001, Math.min(5, sigma - f / v));
  }
  return null;
}

// ---------- Deribit helpers ----------
const BASE = 'https://www.deribit.com/api/v2';
const DOCS_DIR = './docs';
const SMILE_PATH = `${DOCS_DIR}/cvi.json`;
const TS_PATH = `${DOCS_DIR}/cvi_timeseries.json`;
const RISK_FREE = 0.01;

if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

async function getSpot() {
  const { data } = await axios.get(`${BASE}/public/get_index_price`, { params: { index_name: 'btc_usd' } });
  return data?.result?.index_price;
}
async function getOptions() {
  const { data } = await axios.get(`${BASE}/public/get_instruments`, {
    params: { currency: 'BTC', kind: 'option', expired: false },
  });
  return (data?.result || []).filter(o => o.is_active);
}
async function getTicker(name) {
  const { data } = await axios.get(`${BASE}/public/ticker`, { params: { instrument_name: name } });
  return data?.result || {};
}
const yearsToExpiry = (ms) => Math.max(0, ms - Date.now()) / (365 * 24 * 3600 * 1000);

function pickExpiryClosestTo(days, instruments) {
  if (!instruments.length) return null;
  const withDays = instruments.map(i => ({ i, days: yearsToExpiry(i.expiration_timestamp) * 365 }));
  const filtered = withDays.filter(x => x.days >= 20 && x.days <= 45);
  const pool = filtered.length ? filtered : withDays;
  const target = pool.reduce((best, x) =>
    (best == null || Math.abs(x.days - days) < Math.abs(best.days - days)) ? x : best, null);
  return target?.i?.expiration_timestamp || null;
}

async function fetchOptionsData() {
  try {
    const S = await getSpot();
    if (!isFinite(S)) {
      console.error('Spot price unavailable; aborting.');
      return;
    }

    const all = await getOptions();
    const expiryMs = pickExpiryClosestTo(30, all);
    if (!expiryMs) {
      console.error('No suitable expiry found.');
      return;
    }
    const T = yearsToExpiry(expiryMs);
    const sameExpiry = all.filter(o => o.expiration_timestamp === expiryMs);

    const rows = [];
    for (const o of sameExpiry) {
      const t = await getTicker(o.instrument_name);

      // robust option price: mid(bid,ask) -> mark -> last
      let px = null;
      if (isFinite(t.best_bid_price) && isFinite(t.best_ask_price) && t.best_bid_price > 0 && t.best_ask_price > 0) {
        px = (t.best_bid_price + t.best_ask_price) / 2;
      } else if (isFinite(t.mark_price) && t.mark_price > 0) {
        px = t.mark_price;
      } else if (isFinite(t.last_price) && t.last_price > 0) {
        px = t.last_price;
      }
      if (!isFinite(px) || px <= 0) continue;

      let iv = null;
      if (isFinite(t.mark_iv)) {
        iv = t.mark_iv > 1 ? t.mark_iv / 100 : t.mark_iv; // percent → decimal if needed
      } else {
        const type = o.option_type === 'put' ? 'put' : 'call';
        iv = impliedVol(px, S, o.strike, T, RISK_FREE, type);
      }
      if (iv == null || !isFinite(iv) || iv <= 0 || iv > 5) continue;

      rows.push({
        instrument: o.instrument_name,
        option_type: o.option_type === 'put' ? 'put' : 'call',
        strike: o.strike,
        implied_volatility: +iv.toFixed(4),
      });
    }

    // sort smile by strike and write it
    rows.sort((a, b) => a.strike - b.strike);
    fs.writeFileSync(SMILE_PATH, JSON.stringify(rows, null, 2));
    console.log(`Saved ${rows.length} smile points → ${SMILE_PATH}`);

    // ---- derive CVI numbers from the smile ----
    if (!rows.length) return;

    // ATM IV = row with strike closest to spot
    const atmRow = rows.reduce((best, r) =>
      (best == null || Math.abs(r.strike - S) < Math.abs(best.strike - S)) ? r : best, null);
    const atm_iv = atmRow ? atmRow.implied_volatility : null;

    // Vega-weighted IV over strikes within ±10% of spot
    const windowRows = rows.filter(r => r.strike >= 0.9 * S && r.strike <= 1.1 * S);
    let vegaWeighted = null;
    if (windowRows.length) {
      let num = 0, den = 0;
      for (const r of windowRows) {
        const type = r.option_type;
        const vega = bsVega(S, r.strike, T, RISK_FREE, r.implied_volatility);
        if (isFinite(vega) && vega > 0) {
          num += vega * r.implied_volatility;
          den += vega;
        }
      }
      if (den > 0) vegaWeighted = +(num / den).toFixed(4);
    }

    // append to timeseries
    let ts = [];
    if (fs.existsSync(TS_PATH)) {
      try { ts = JSON.parse(fs.readFileSync(TS_PATH, 'utf8')); } catch {}
      if (!Array.isArray(ts)) ts = [];
    }
    ts.push({
      timestamp: new Date().toISOString(),
      spot: +S,
      expiry_iso: new Date(expiryMs).toISOString(),
      atm_iv,
      vega_weighted_iv: vegaWeighted
    });
    fs.writeFileSync(TS_PATH, JSON.stringify(ts, null, 2));
    console.log(`Appended CVI point → ${TS_PATH}`);
  } catch (err) {
    console.error('Fatal error building CVI:', err?.response?.data || err);
  }
}

fetchOptionsData();
