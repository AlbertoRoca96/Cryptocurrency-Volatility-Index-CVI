const axios = require('axios');
const fs = require('fs');
const path = require('path');

/* ================ Settings ================ */
// Default asset universe
const BASE_ASSETS = ['BTC','ETH','SOL','BNB','XRP','ADA','AVAX','DOGE','LINK','LTC'];

// Optional include/exclude lists (comma-separated)
const INCLUDE = (process.env.CVI_INCLUDE || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const EXCLUDE = (process.env.CVI_EXCLUDE || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

// Resolve final run set
const UNIVERSE = Array.from(new Set([...BASE_ASSETS, ...INCLUDE]));
const ASSETS = (INCLUDE.length ? UNIVERSE.filter(s => INCLUDE.includes(s)) : UNIVERSE)
  .filter(s => !EXCLUDE.includes(s));

const COINGECKO_IDS = {
  BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin', XRP:'ripple',
  ADA:'cardano', AVAX:'avalanche-2', DOGE:'dogecoin', LINK:'chainlink', LTC:'litecoin'
};

/* ---- CoinGecko usage gate (quota control) ----
   COINGECKO_MODE: 'on' | 'off' | 'sample' | 'auto'
   - Default 'off' to protect your monthly cap.
   - In workflow, set to 'on' for hourly (or 4x/day) runs.
   COINGECKO_SAMPLE: 0..1 probability if MODE='sample' (default 0).
*/
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || '';
const CG_MODE   = (process.env.COINGECKO_MODE || 'off').toLowerCase();
const CG_SAMPLE = Math.max(0, Math.min(1, parseFloat(process.env.COINGECKO_SAMPLE || '0')));

function shouldUseCG(mode = CG_MODE) {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  if (mode === 'sample') return Math.random() < CG_SAMPLE;
  // 'auto' => treat as conservative (off); enable via workflow env on a schedule
  return false;
}

const USE_CG = shouldUseCG();
const CG_BASE = COINGECKO_API_KEY
  ? 'https://pro-api.coingecko.com/api/v3'
  : 'https://api.coingecko.com/api/v3';
const CG_HEADERS = COINGECKO_API_KEY ? { 'x-cg-pro-api-key': COINGECKO_API_KEY } : undefined;

const RISK_FREE = 0.01;
const TARGET_DAYS = 30;
const MAX_TS_POINTS = 2000;
const SIGNAL_HISTORY = 50;
const SEED_TWO_POINTS = true;   // seed t-1m on first run so chart shows dots/line

/* ============== Math & BS helpers ============== */
function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }
function normPDF(x){ return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); }
function normCDF(x){
  const k = 1/(1+0.2316419*Math.abs(x));
  const a1=0.319381530,a2=-0.356563782,a3=1.781477937,a4=-1.821255978,a5=1.330274429;
  const poly=(((a5*k+a4)*k+a3)*k+a2)*k+a1;
  const cnd=1-normPDF(x)*poly;
  return x>=0?cnd:1-cnd;
}
function bsCall(S,K,T,r,s){
  const st=Math.sqrt(T),d1=(Math.log(S/K)+(r+0.5*s*s)*T)/(s*st),d2=d1-s*st;
  return S*normCDF(d1)-K*Math.exp(-r*T)*normCDF(d2);
}
function vega(S,K,T,r,s){
  const st=Math.sqrt(T),d1=(Math.log(S/K)+(r+0.5*s*s)*T)/(s*st);
  return S*st*normPDF(d1);
}
// Newton on CALL price only; for puts, convert via parity first.
function impliedVol(price,S,K,T,r,isCall=true){
  if (price<=0||S<=0||K<=0||T<=0) return null;
  const callPx = isCall ? price : (price + S - K*Math.exp(-r*T));
  if (!isFinite(callPx) || callPx<=0) return null;

  // decent initial guess (Brenner-Subrahmanyam-ish)
  let s = clamp(Math.sqrt(2*Math.PI/T) * (callPx/Math.max(S,1e-9)), 0.0001, 3.0);
  const tol=1e-4;
  for (let i=0;i<100;i++){
    const model = bsCall(S,K,T,r,s);
    let diff = model - callPx;
    if (Math.abs(diff) < tol) return clamp(s, 0.0001, 5);
    const v = vega(S,K,T,r,s); if (!isFinite(v) || v<=1e-8) break;
    s = clamp(s - diff/v, 0.0001, 5);
  }
  return null;
}

/* ===== parity + synthetic helpers ===== */
function callFromPut(putPrice, S, K, T, r) {
  return putPrice + S - K * Math.exp(-r * T);
}
function buildSyntheticSmile(S, atm, n=7, width=0.35) {
  const ks = Array.from({length:n}, (_,i)=> {
    const t = i/(n-1);
    return S * (1 - width + 2*width*t);
  });
  const a = 2.0, b = -0.25; // convex smile
  return ks.map(K => {
    const m = Math.log(K / S);
    const iv = Math.max(0.01, atm * (1 + a*m*m + b*m));
    return { strike: Math.round(K), iv: clamp(iv, 0.01, 3.0) };
  });
}

/* =============== Generic helpers =============== */
const delay = (ms) => new Promise(r => setTimeout(r, ms));
function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p,{recursive:true}); }
function readJSON(p,fallback){ try{ return JSON.parse(fs.readFileSync(p,'utf8')); }catch{ return fallback; } }
function writeJSON(p,data){ fs.writeFileSync(p, JSON.stringify(data,null,2)); }

/* ===== simple concurrency limiter for bursty API loops ===== */
async function pMapLimit(items, limit, iter){
  const ret = new Array(items.length);
  let idx = 0;
  const workers = Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = idx++; if (i >= items.length) break;
      ret[i] = await iter(items[i], i);
    }
  });
  await Promise.all(workers);
  return ret;
}

// retrying GET (handles 429/5xx)
async function httpGet(url, {params, timeout=20000, headers, retries=4, baseDelay=800} = {}) {
  headers = { 'User-Agent':'cvi-bot/1.0', ...headers };
  for (let i=0;i<=retries;i++){
    try { return await axios.get(url, { params, timeout, headers }); }
    catch(e){
      const s = e?.response?.status;
      if (s===429 || (s>=500 && s<=599)) {
        const backoff = baseDelay * Math.pow(1.7, i) + Math.random()*300;
        await delay(backoff);
        continue;
      }
      throw e;
    }
  }
  throw new Error('max retries exceeded for '+url);
}

/* =============== Data sources =============== */
async function getSpotFromCoingecko(symbol){
  if (!USE_CG) return null; 
  const id = COINGECKO_IDS[symbol]; if (!id) return null;
  const r = await httpGet(`${CG_BASE}/simple/price`, { params:{ ids:id, vs_currencies:'usd' }, headers: CG_HEADERS });
  return r?.data?.[id]?.usd ?? null;
}
async function getSpotFromDeribitIndex(symbol){
  const idx = `${symbol.toLowerCase()}_usd`;
  try{
    const r = await httpGet('https://www.deribit.com/api/v2/public/get_index_price', { params:{ index_name:idx }, timeout:15000 });
    const px = Number(r?.data?.result?.index_price ?? NaN);
    return isFinite(px) ? px : null;
  }catch{ return null; }
}
async function getInstruments(symbol){
  try{
    const r = await httpGet('https://www.deribit.com/api/v2/public/get_instruments', { params:{currency:symbol, kind:'option', expired:false}, timeout:20000 });
    return r?.data?.result ?? [];
  }catch{ return []; }
}
async function getMarkOrLast(instrument_name){
  try{
    const r = await httpGet('https://www.deribit.com/api/v2/public/ticker', { params:{instrument_name}, timeout:15000 });
    const t=r?.data?.result||{};
    const p = Number(t.mark_price ?? t.last_price ?? NaN);
    return isFinite(p)?p:null;
  }catch{ return null; }
}
// 30d realized vol proxy if no options (CoinGecko)
async function getRealizedVol30d(symbol){
  if (!USE_CG) return null; 
  const id = COINGECKO_IDS[symbol]; if (!id) return null;
  try{
    const r = await httpGet(`${CG_BASE}/coins/${id}/market_chart`, { params:{ vs_currency:'usd', days:30, interval:'daily' }, timeout:20000, headers: CG_HEADERS });
    const prices = r?.data?.prices || [];
    if (prices.length < 10) return null;
    const rets = [];
    for (let i=1;i<prices.length;i++){
      const ret = Math.log(prices[i][1]/prices[i-1][1]);
      rets.push(ret);
    }
    const mean = rets.reduce((s,x)=>s+x,0)/rets.length;
    const varc = rets.reduce((s,x)=>s+(x-mean)*(x-mean),0)/rets.length;
    const std = Math.sqrt(varc);
    return std*Math.sqrt(365);
  }catch{ return null; }
}

/* =============== Signals =============== */
function ema(arr, period){
  const k=2/(period+1); let e=null; const out=[];
  for (const x of arr){ e = (e===null)? x : (x*k + e*(1-k)); out.push(e); }
  return out;
}
function percentile(arr, p){ if(!arr.length) return null;
  const a=[...arr].sort((x,y)=>x-y); const idx=Math.max(0, Math.min((p/100)*(a.length-1), a.length-1));
  const lo=Math.floor(idx), hi=Math.ceil(idx); if (lo===hi) return a[lo];
  const w=idx-lo; return a[lo]*(1-w)+a[hi]*w;
}
function buildSignal(series){
  const y = series.map(p => Number(p.vega_weighted_iv ?? p.atm_iv)).filter(x => isFinite(x));
  if (y.length < 30) return null;
  const fast = ema(y, 20), slow = ema(y, 100);
  const last = y[y.length-1], fLast = fast[fast.length-1], sLast = slow[slow.length-1];
  const fPrev = fast[fast.length-2], sPrev = slow[slow.length-2];
  const crossedUp   = fPrev <= sPrev && fLast > sLast;
  const crossedDown = fPrev >= sPrev && fLast < sLast;
  const window = y.slice(-252);
  const loP = percentile(window,10), hiP = percentile(window,90);
  let rec = 'Hold', strength = 0.0, reason = [];
  if (crossedUp){ rec='Long Volatility'; strength+=0.5; reason.push('EMA20 > EMA100 (bullish IV trend)'); }
  if (crossedDown){ rec='Short Volatility'; strength+=0.5; reason.push('EMA20 < EMA100 (bearish IV trend)'); }
  if (isFinite(hiP) && last >= hiP){ rec='Short Volatility'; strength+=0.6; reason.push('IV at 90th percentile'); }
  if (isFinite(loP) && last <= loP){ rec='Long Volatility';  strength+=0.6; reason.push('IV at 10th percentile'); }
  strength = clamp(strength, 0, 1);
  const sizing = Math.round( (0.5 + strength/2) * 100 )/100;
  return { ts:new Date().toISOString(), recommendation:rec, strength, size_hint:sizing,
           reason:reason.join('; '), last_iv:last, ema20:fLast, ema100:sLast };
}

/* =============== Per-asset pipeline =============== */
async function buildForAsset(symbol){
  const docsDir = path.join(process.cwd(), 'docs');
  const assetDir = path.join(docsDir, symbol);
  ensureDir(docsDir); ensureDir(assetDir);

  // -------- Robust SPOT fetch with fallbacks --------
  let S = await getSpotFromCoingecko(symbol);
  if (!S) S = await getSpotFromDeribitIndex(symbol);
  const prevSeries = readJSON(path.join(assetDir, 'cvi_timeseries.json'), []);
  if (!S && prevSeries.length) S = Number(prevSeries[prevSeries.length-1].spot) || null;

  const instruments = await getInstruments(symbol);
  const now = Date.now();

  // If still no spot but we *do* have instruments, estimate S from strikes around the nearest expiry
  if (!S && instruments.length){
    const byProx = instruments
      .filter(x=>x.is_active && x.expiration_timestamp > now + 86400000)
      .sort((a,b)=>Math.abs(a.expiration_timestamp-now - TARGET_DAYS*86400000) -
                   Math.abs(b.expiration_timestamp-now - TARGET_DAYS*86400000));
    const tgt = byProx[0]?.expiration_timestamp;
    if (tgt){
      const rawAtT = instruments.filter(x => x.expiration_timestamp===tgt && x.is_active);
      if (rawAtT.length){
        const strikes = rawAtT.map(x=>x.strike).filter(Number.isFinite).sort((a,b)=>a-b);
        const mid = strikes[Math.floor(strikes.length/2)];
        if (isFinite(mid)) S = mid; // rough but workable for smile layout
      }
    }
  }
  // Last resort: choose a sane constant so we never bail (smile can still be synthetic)
  if (!S) S = 100;

  let smile = [], atm_iv=null, vega_weighted_iv=null, days_to_expiry=null;
  let smileSynthetic = false;

  if (instruments.length){
    const daysTo = (ts)=> (ts-now)/86400000;
    const byProx = instruments
      .filter(x=>x.is_active && x.expiration_timestamp > now + 86400000)
      .map(x=>({...x,dte:daysTo(x.expiration_timestamp)}))
      .sort((a,b)=>Math.abs(a.dte-TARGET_DAYS)-Math.abs(b.dte-TARGET_DAYS));

    if (byProx.length){
      const tgt = byProx[0].expiration_timestamp;
      days_to_expiry = ((tgt-now)/86400000).toFixed(2);
      const T = (tgt-now)/(365*24*3600*1000);

      // widen to ±40% and fetch both sides
      const rawAtT = instruments
        .filter(x => x.expiration_timestamp === tgt && x.is_active)
        .filter(x => Math.abs(x.strike / S - 1) <= 0.40);

      const calls = rawAtT.filter(x => x.option_type === 'call')
        .sort((a,b)=>Math.abs(a.strike-S)-Math.abs(b.strike-S))
        .slice(0, 180);

      const puts  = rawAtT.filter(x => x.option_type === 'put')
        .sort((a,b)=>Math.abs(a.strike-S)-Math.abs(b.strike-S))
        .slice(0, 180);

      // limit concurrency to be nice to the API
      const callTicks = await pMapLimit(calls, 10, async inst => ({ inst, price: await getMarkOrLast(inst.instrument_name) }));
      const putTicks  = await pMapLimit(puts,  10, async inst => ({ inst, price: await getMarkOrLast(inst.instrument_name) }));

      const putByStrike = new Map();
      for (const kv of putTicks) {
        const price = kv?.price;
        if (price && isFinite(price)) putByStrike.set(kv.inst.strike, price);
      }

      for (const kv of callTicks) {
        const {inst} = kv || {};
        if (!inst) continue;
        let px = (kv.price && isFinite(kv.price)) ? kv.price : null;
        if (!px) {
          const p = putByStrike.get(inst.strike);
          if (p && isFinite(p)) px = callFromPut(p, S, inst.strike, T, RISK_FREE);
        }
        if (!px || px <= 0) continue;
        const iv = impliedVol(px, S, inst.strike, T, RISK_FREE, true);
        if (iv && isFinite(iv)) smile.push({ strike: inst.strike, iv: clamp(iv, 0.01, 3.0) });
      }

      // If still sparse, compute IVs directly from puts (via parity inside impliedVol)
      if (smile.length < 3) {
        for (const kv of putTicks) {
          const {inst, price} = kv || {};
          if (!inst || !price || !isFinite(price) || price <= 0) continue;
          const iv = impliedVol(price, S, inst.strike, T, RISK_FREE, false);
          if (iv && isFinite(iv)) smile.push({ strike: inst.strike, iv: clamp(iv, 0.01, 3.0) });
        }
      }

      smile.sort((a,b)=>a.strike-b.strike);

      if (smile.length){
        const atm = smile.reduce((best,p)=>Math.abs(p.strike-S)<Math.abs(best.strike-S)?p:best, smile[0]);
        atm_iv = atm.iv;

        const band20 = smile.filter(p=>Math.abs(p.strike/S-1)<=0.10);
        const band = band20.length ? band20 : smile;
        const parts = band.map(p=>{
          const sig=p.iv, vg=vega(S,p.strike,T,RISK_FREE,sig);
          return { w: Math.max(1e-8, vg), iv: sig };
        });
        const wsum = parts.reduce((s,x)=>s+x.w,0);
        const ivsum = parts.reduce((s,x)=>s+x.w*x.iv,0);
        vega_weighted_iv = ivsum/wsum;

        // display-friendly band
        const displayBand = smile.filter(p => Math.abs(p.strike/S - 1) <= 0.20);
        if (displayBand.length >= 3) smile = displayBand;
      }
    }
  }

  // Existing series (for seeding / fallback)
  const tsPath = path.join(assetDir,'cvi_timeseries.json');
  let series = prevSeries;

  // If both IVs are still null, build them from smile / realized vol / last known
  if (atm_iv==null && vega_weighted_iv==null){
    if (smile.length){
      const median = smile[Math.floor(smile.length/2)].iv;
      const near = smile.filter(p=>Math.abs(p.strike/S-1)<=0.10);
      const vw = near.length
        ? near.reduce((s,p)=>s+p.iv,0)/near.length
        : smile.reduce((s,p)=>s+p.iv,0)/smile.length;
      atm_iv = median; vega_weighted_iv = vw;
      days_to_expiry = days_to_expiry ?? TARGET_DAYS.toFixed(2);
    } else {
      let rv = await getRealizedVol30d(symbol);
      if (rv==null && series.length){
        // compute realized vol from our own series if CoinGecko failed/disabled
        const y = series.slice(-30).map(p => Number(p.vega_weighted_iv ?? p.atm_iv)).filter(x=>isFinite(x));
        if (y.length) rv = y.reduce((s,x)=>s+x,0)/y.length;
      }
      const val = (rv!=null) ? rv : 0.5;
      atm_iv = vega_weighted_iv = clamp(val, 0.05, 2.0);
      days_to_expiry = days_to_expiry ?? TARGET_DAYS.toFixed(2);
    }
  }

  // If smile is empty, synthesize one so the chart never blanks
  if (!smile.length) {
    const base = Number(vega_weighted_iv ?? atm_iv);
    if (isFinite(base) && base > 0) {
      smile = buildSyntheticSmile(S, clamp(base, 0.05, 2.0));
      smileSynthetic = true;
    }
  }

  // Write smile (real or synthetic) + meta badge
  writeJSON(path.join(assetDir,'cvi.json'), smile);
  writeJSON(path.join(assetDir,'smile_meta.json'), {
    synthetic: !!smileSynthetic,
    source: smileSynthetic ? 'synthetic' : 'real',
    coingecko_used: !!USE_CG,
    generated_at: new Date().toISOString()
  });

  // Build new timeseries row
  const nowISO = new Date().toISOString();
  const newRow = {
    t: nowISO,
    spot: S,
    days_to_expiry,
    atm_iv, vega_weighted_iv
  };

  // Seed with a t-1m row on first run so the top chart always has ≥2 points
  if (SEED_TWO_POINTS && series.length === 0) {
    const seed = { ...newRow, t: new Date(Date.now()-60_000).toISOString() };
    series.push(seed);
  }

  // Append the new row
  series.push(newRow);
  if (series.length>MAX_TS_POINTS) series = series.slice(series.length-MAX_TS_POINTS);
  writeJSON(tsPath, series);

  // Signals
  const sig = buildSignal(series);
  const sigPath = path.join(assetDir,'signals.json');
  let sigs = readJSON(sigPath, []);
  if (sig){ sigs.push(sig); if (sigs.length> SIGNAL_HISTORY) sigs = sigs.slice(sigs.length-SIGNAL_HISTORY); }
  writeJSON(sigPath, sigs);

  return {
    symbol,
    latest: series[series.length-1],
    files: {
      smile:`/${symbol}/cvi.json`,
      smile_meta:`/${symbol}/smile_meta.json`,
      series:`/${symbol}/cvi_timeseries.json`,
      signals:`/${symbol}/signals.json`
    }
  };
}

/* =============== Orchestrate all assets + manifest =============== */
(async function main(){
  if (EXCLUDE.length) console.log('Skipping assets:', EXCLUDE.join(', '));
  if (INCLUDE.length) console.log('Explicit include:', INCLUDE.join(', '));
  console.log('CoinGecko mode:', CG_MODE, 'sample=', CG_SAMPLE, 'use=', USE_CG);
  console.log('Running for assets:', ASSETS.join(', '));
  if (!ASSETS.length) { console.log('No assets selected. Exiting.'); process.exit(0); }

  const docsDir = path.join(process.cwd(),'docs'); ensureDir(docsDir);

  const results = [];
  for (const sym of ASSETS){
    try{
      const r = await buildForAsset(sym);
      if (r) results.push(r);
    }catch(e){ console.error(`[${sym}] failed:`, e?.message || e); }
    // gentle to public APIs
    await delay(2000 + Math.random()*1500);
  }

  const manifest = { assets: results.map(r=>({ symbol:r.symbol, files:r.files, latest:r.latest })) };
  writeJSON(path.join(docsDir,'cvi_manifest.json'), manifest);
  console.log('Updated manifest with', manifest.assets.length, 'asset(s).');
})();
