const fs = require('fs');
const path = require('path');

/* ================== Config ================== */
// Risk knobs (can be overridden via Actions env)
const RISK_BUDGET_USD = Number(process.env.RISK_BUDGET_USD || 100); // per ticket
const HORIZON_DAYS    = Number(process.env.HORIZON_DAYS || 1);      // holding horizon
const DEFAULT_LEVERAGE = Number(process.env.DEFAULT_LEVERAGE || 1); // informational only

// How many points to use for EMAs / percentiles (series is intraday cadence)
const FAST_N = 20;
const SLOW_N = 100;
const PCT_WINDOW = 252; // "trading days" window analog (uses last 252 points)

/* =============== Helpers =============== */
function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p,{recursive:true}); }
function readJSON(p,fallback){ try{ return JSON.parse(fs.readFileSync(p,'utf8')); }catch{ return fallback; } }
function writeJSON(p,data){ fs.writeFileSync(p, JSON.stringify(data,null,2)); }

function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }

function ema(arr, period){
  const k=2/(period+1); let e=null; const out=[];
  for (const x of arr){ const v = Number(x); if (!isFinite(v)) { out.push(e); continue; }
    e = (e===null)? v : (v*k + e*(1-k)); out.push(e); }
  return out;
}

function percentile(arr, p){ 
  const a=arr.filter(Number.isFinite).slice().sort((x,y)=>x-y);
  if(!a.length) return null;
  const idx = clamp((p/100)*(a.length-1),0,a.length-1);
  const lo=Math.floor(idx), hi=Math.ceil(idx);
  if (lo===hi) return a[lo];
  const w=idx-lo; return a[lo]*(1-w)+a[hi]*w;
}

/* ERI math (unitless, comparable across assets)
   sigma_d = IV / sqrt(365)
   ERI     = 100 * sigma_d
*/
const SQRT_365 = Math.sqrt(365);

function lastIv(row){ 
  if (!row) return null;
  const v = Number(row.vega_weighted_iv ?? row.atm_iv);
  return isFinite(v) ? v : null;
}

function toSigmaDaily(iv){ return isFinite(iv) ? iv / SQRT_365 : null; }
function toERI(iv){ const sd = toSigmaDaily(iv); return isFinite(sd)? 100*sd : null; }

/* Size hint:
   expected_move = S * sigma_d * sqrt(h)
   qty = B / expected_move
*/
function sizeHint(spot, iv, budget=RISK_BUDGET_USD, horizonDays=HORIZON_DAYS){
  const sd = toSigmaDaily(iv);
  if (!isFinite(spot) || !isFinite(sd) || spot<=0 || sd<=0) return null;
  const expMove = spot * sd * Math.sqrt(Math.max(0.0001, horizonDays));
  const qty = budget / expMove;
  return {
    horizon_days: horizonDays,
    risk_budget_usd: budget,
    expected_move_usd: expMove,
    qty,
    notional_usd: qty * spot,
    leverage: DEFAULT_LEVERAGE
  };
}

/* ================== Engine ================== */
(async function main(){
  const docsDir = path.join(process.cwd(), 'docs');
  const manifestPath = path.join(docsDir, 'cvi_manifest.json');
  const manifest = readJSON(manifestPath, { assets: [] });

  const allOrders = [];

  for (const a of (manifest.assets || [])){
    const symbol = a.symbol;
    const assetDir = path.join(docsDir, symbol);
    const tsPath  = path.join(assetDir, 'cvi_timeseries.json');
    const series  = readJSON(tsPath, []);

    if (!Array.isArray(series) || series.length === 0){
      // Nothing to do for this asset yet
      continue;
    }

    // IV history for analytics
    const ivSeries = series.map(r => {
      const v = Number(r.vega_weighted_iv ?? r.atm_iv);
      return isFinite(v) ? v : NaN;
    });

    // Current snapshot
    const last = series[series.length-1];
    const spot = Number(last.spot);
    const iv   = lastIv(last);
    const eri  = toERI(iv);

    // Build ERI history (derived from IV)
    const eriHist = ivSeries.map(v => toERI(v));
    const window  = eriHist.slice(-PCT_WINDOW).filter(Number.isFinite);
    const p10 = percentile(window,10), p50 = percentile(window,50), p90 = percentile(window,90);

    // EMAs on IV (use your same convention for continuity)
    const fast = ema(ivSeries, FAST_N);
    const slow = ema(ivSeries, SLOW_N);
    const fLast = fast[fast.length-1];
    const sLast = slow[slow.length-1];
    const fPrev = fast[fast.length-2];
    const sPrev = slow[slow.length-2];

    const crossedUp   = isFinite(fPrev) && isFinite(sPrev) && isFinite(fLast) && isFinite(sLast) && (fPrev <= sPrev && fLast > sLast);
    const crossedDown = isFinite(fPrev) && isFinite(sPrev) && isFinite(fLast) && isFinite(sLast) && (fPrev >= sPrev && fLast < sLast);

    // Compute size hint
    const size = sizeHint(spot, iv);

    // Persist risk.json
    const risk = {
      t: last.t,
      spot,
      sigma_d: toSigmaDaily(iv),
      ERI: eri,
      percentiles: { p10, p50, p90 },
      ema: { fast: fLast, slow: sLast, fast_period: FAST_N, slow_period: SLOW_N },
      etv: size
    };
    writeJSON(path.join(assetDir, 'risk.json'), risk);

    // ---- Generate paper orders (simple, conservative rules) ----
    // BUY if regime turns up and ERI not stretched (<= median)
    // SELL if regime turns down and ERI rich (>= 90th pct)
    const orders = [];
    if (size && isFinite(eri)) {
      if (crossedUp && (eri <= (p50 ?? eri))) {
        orders.push({
          t: last.t,
          symbol,
          type: 'entry',
          side: 'buy',
          reason: 'EMA20 > EMA100 and ERI <= median',
          qty: size.qty,
          price: 'mkt',
          exchange: 'paper',
          risk_budget_usd: size.risk_budget_usd,
          horizon_days: size.horizon_days
        });
      }
      if (crossedDown && (p90!=null && eri >= p90)) {
        orders.push({
          t: last.t,
          symbol,
          type: 'exit',
          side: 'sell',
          reason: 'EMA20 < EMA100 and ERI >= 90th pct',
          qty: size.qty,
          price: 'mkt',
          exchange: 'paper',
          risk_budget_usd: size.risk_budget_usd,
          horizon_days: size.horizon_days
        });
      }
    }

    // Write per-asset orders.json (append but trim to last 100)
    const assetOrdersPath = path.join(assetDir, 'orders.json');
    const prevOrders = readJSON(assetOrdersPath, []);
    const merged = [...prevOrders, ...orders].slice(-100);
    writeJSON(assetOrdersPath, merged);

    // collect for global view
    for (const o of merged.slice(-5)) { // keep only a few recent per asset for aggregator
      allOrders.push({ ...o });
    }
  }

  // Global orders aggregator (sorted desc by time)
  allOrders.sort((a,b)=> new Date(b.t) - new Date(a.t));
  writeJSON(path.join(docsDir, 'orders.json'), allOrders.slice(0, 200));
})();
