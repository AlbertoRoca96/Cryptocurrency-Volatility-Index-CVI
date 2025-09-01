// scripts/fetchOptionsData.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// -------- helpers: normal pdf/cdf, BS pricers, IV via Newton --------
function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function normCDF(x) {
  // Abramowitz-Stegun approximation
  const k = 1.0 / (1.0 + 0.2316419 * Math.abs(x));
  const a1 = 0.319381530, a2 = -0.356563782, a3 = 1.781477937, a4 = -1.821255978, a5 = 1.330274429;
  const poly = (((a5 * k + a4) * k + a3) * k + a2) * k + a1;
  const cnd = 1 - normPDF(x) * poly;
  return x >= 0 ? cnd : 1 - cnd;
}
function bsCall(S, K, T, r, sigma) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
}
function bsPut(S, K, T, r, sigma) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}
function vega(S, K, T, r, sigma) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  return S * sqrtT * normPDF(d1);
}
function impliedVol(price, S, K, T, r, isCall) {
  // Newton-Raphson; fallbacks if non-convergent
  if (price <= 0 || T <= 0 || S <= 0 || K <= 0) return null;
  let sigma = 0.5;           // starting guess
  const tol = 1e-4;
  for (let i = 0; i < 100; i++) {
    const model = isCall ? bsCall(S, K, T, r, sigma) : bsPut(S, K, T, r, sigma);
    const diff = model - price;
    if (Math.abs(diff) < tol) return Math.max(0.0001, sigma);
    const veg = vega(S, K, T, r, sigma);
    if (veg <= 1e-8 || !isFinite(veg)) break; // can't proceed
    sigma = Math.max(0.0001, sigma - diff / veg);
  }
  return null;
}

// --------- main job: build smile + cvi, write docs/* files ----------
async function main() {
  // Ensure docs/
  const docsDir = path.join(process.cwd(), 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  // risk-free and target terms
  const r = 0.01;

  // 1) spot from Coingecko (simple, no key)
  const spotResp = await axios.get(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    { timeout: 15000 }
  );
  const S = spotResp?.data?.bitcoin?.usd;
  if (!S) {
    console.error('Failed to get BTC spot – aborting run');
    return;
  }

  // 2) list Deribit BTC options
  const instResp = await axios.get(
    'https://www.deribit.com/api/v2/public/get_instruments',
    { params: { currency: 'BTC', kind: 'option' }, timeout: 20000 }
  );

  const instruments = instResp?.data?.result || [];
  if (!instruments.length) {
    console.error('No instruments from Deribit – aborting run');
    return;
  }

  const now = Date.now();

  // choose expiry closest to ~30 days
  function daysToExpiry(ms) { return (ms - now) / (1000 * 60 * 60 * 24); }
  const byProximity = [...instruments]
    .filter(x => x.is_active && x.expiration_timestamp > now + 24 * 3600 * 1000) // at least > 1 day
    .map(x => ({ ...x, dte: daysToExpiry(x.expiration_timestamp) }))
    .sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30));

  if (!byProximity.length) {
    console.error('No suitable expiries.');
    return;
  }

  const targetExpiryTs = byProximity[0].expiration_timestamp;
  const expiryInstruments = instruments.filter(
    x => x.expiration_timestamp === targetExpiryTs && x.option_type && x.is_active
  );

  // get a focused set of CALL options around ATM (±10%) to form the smile
  const nearATM = expiryInstruments
    .filter(x => x.option_type === 'call')
    .sort((a, b) => Math.abs(a.strike - S) - Math.abs(b.strike - S))
    .filter(x => Math.abs(x.strike / S - 1) <= 0.20) // ±20% band to have a fuller smile
    .slice(0, 120);                                  // cap

  // fetch last/mark price per instrument
  async function fetchPrice(instName) {
    try {
      const t = await axios.get('https://www.deribit.com/api/v2/public/ticker',
        { params: { instrument_name: instName }, timeout: 15000 });
      const r = t?.data?.result || {};
      // prefer mark_price, then last_price
      const p = Number(r.mark_price ?? r.last_price ?? NaN);
      return isFinite(p) ? p : null;
    } catch {
      return null;
    }
  }

  const prices = await Promise.all(
    nearATM.map(async (inst) => ({
      inst,
      price: await fetchPrice(inst.instrument_name)
    }))
  );

  // Build smile with IV
  const T = (targetExpiryTs - now) / (365 * 24 * 3600 * 1000);
  const smile = [];
  for (const { inst, price } of prices) {
    if (!price || price <= 0) continue;
    const isCall = inst.option_type === 'call';
    const iv = impliedVol(price, S, inst.strike, T, r, isCall);
    if (iv && isFinite(iv)) {
      smile.push({ strike: inst.strike, iv });
    }
  }
  smile.sort((a, b) => a.strike - b.strike);

  // 3) Compute CVI(s)
  let atm_iv = null;
  if (smile.length) {
    const atm = smile.reduce((best, p) =>
      Math.abs(p.strike - S) < Math.abs(best.strike - S) ? p : best, smile[0]);
    atm_iv = atm.iv;
  }

  // vega-weighted average IV across ±10% band
  let vega_weighted_iv = null;
  if (smile.length) {
    const band = smile.filter(p => Math.abs(p.strike / S - 1) <= 0.10);
    if (band.length) {
      const parts = band.map(p => {
        const sig = p.iv;
        const v = vega(S, p.strike, T, r, sig);
        return { w: Math.max(1e-8, v), iv: sig };
      });
      const wsum = parts.reduce((s, x) => s + x.w, 0);
      const ivsum = parts.reduce((s, x) => s + x.w * x.iv, 0);
      vega_weighted_iv = ivsum / wsum;
    }
  }

  // 4) Write docs/cvi.json (smile)
  const smilePath = path.join(docsDir, 'cvi.json');
  fs.writeFileSync(smilePath, JSON.stringify(smile, null, 2));

  // 5) Append to docs/cvi_timeseries.json
  const tsPath = path.join(docsDir, 'cvi_timeseries.json');
  let series = [];
  if (fs.existsSync(tsPath)) {
    try { series = JSON.parse(fs.readFileSync(tsPath, 'utf8') || '[]'); }
    catch { series = []; }
  }
  const point = {
    t: new Date().toISOString(),
    spot: S,
    days_to_expiry: ((targetExpiryTs - now) / 86400000).toFixed(2),
    atm_iv,
    vega_weighted_iv
  };
  series.push(point);
  if (series.length > 2000) series = series.slice(series.length - 2000);
  fs.writeFileSync(tsPath, JSON.stringify(series, null, 2));

  console.log('Wrote:', smilePath, 'and', tsPath);
}

main().catch(err => {
  console.error('Fatal error in fetchOptionsData:', err);
  process.exit(1);
});
