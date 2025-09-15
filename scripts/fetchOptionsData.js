/**
 * Guarantees: every run appends a new point per asset.
 * If data fetch fails, we "tick" by cloning the last row with a new timestamp.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/* ========= Config ========= */
// Track only these three by default
const BASE_ASSETS = ['BTC','ETH','LINK'];

// Optional include/exclude lists (comma-separated)
const INCLUDE = (process.env.CVI_INCLUDE || '')
  .split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
const EXCLUDE = (process.env.CVI_EXCLUDE || '')
  .split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);

// Final asset set (INCLUDE narrows, EXCLUDE removes)
const UNIVERSE = Array.from(new Set([...BASE_ASSETS, ...INCLUDE]));
const ASSETS = (INCLUDE.length ? UNIVERSE.filter(s => INCLUDE.includes(s)) : UNIVERSE)
  .filter(s => !EXCLUDE.includes(s));

const COINGECKO_IDS = {
  BTC:'bitcoin', ETH:'ethereum', LINK:'chainlink',
  // kept for safety if INCLUDE adds others later
  SOL:'solana', BNB:'binancecoin', XRP:'ripple',
  ADA:'cardano', AVAX:'avalanche-2', DOGE:'dogecoin', LTC:'litecoin'
};

// API gating / modes
const COINGECKO_API_KEY = (process.env.COINGECKO_API_KEY || '').trim();
const COINGECKO_PLAN    = (process.env.COINGECKO_PLAN || 'demo').toLowerCase(); // 'demo' or 'pro'
const CG_MODE   = (process.env.COINGECKO_MODE || 'off').toLowerCase(); // on|off|sample
const CG_SAMPLE = Math.max(0, Math.min(1, parseFloat(process.env.COINGECKO_SAMPLE || '0')));
const ALWAYS_TICK = (process.env.ALWAYS_TICK || '1') !== '0';

// Decide whether to hit CoinGecko this run
const USE_CG = (() => {
  if (CG_MODE === 'on') return true;
  if (CG_MODE === 'off') return false;
  if (CG_MODE === 'sample') return Math.random() < CG_SAMPLE;
  return false;
})();

// Correct base + headers per plan
const CG_BASE = COINGECKO_PLAN === 'pro'
  ? 'https://pro-api.coingecko.com/api/v3'
  : 'https://api.coingecko.com/api/v3';

const CG_HEADERS = (() => {
  if (!COINGECKO_API_KEY) return { 'accept': 'application/json' };
  return COINGECKO_PLAN === 'pro'
    ? { 'accept': 'application/json', 'x-cg-pro-api-key': COINGECKO_API_KEY }
    : { 'accept': 'application/json', 'x-cg-demo-api-key': COINGECKO_API_KEY };
})();

// helper: one CG GET with 401 fallback to query param (x_cg_demo_api_key / x_cg_pro_api_key)
async function cgGet(path, params = {}) {
  const url = `${CG_BASE}${path}`;
  try {
    const r = await axios.get(url, { params, timeout: 20000, headers: CG_HEADERS });
    return r.data;
  } catch (e) {
    const s = e?.response?.status;
    const qp = COINGECKO_PLAN === 'pro' ? 'x_cg_pro_api_key' : 'x_cg_demo_api_key';
    if (s === 401 && COINGECKO_API_KEY) {
      const p2 = { ...params, [qp]: COINGECKO_API_KEY };
      const r2 = await axios.get(url, { params: p2, timeout: 20000 });
      return r2.data;
    }
    throw e;
  }
}

const RISK_FREE = 0.01;
const TARGET_DAYS = 30;
const MAX_TS_POINTS = 2000;
const SIGNAL_HISTORY = 50;

/* ========= Utils ========= */
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const { ensureDir, readJSON, writeJSONAtomic } = require('./lib/io');
function writeJSON(p,data){ writeJSONAtomic(p,data); }
function clamp(x,lo,hi){ return Math.max(lo, Math.min(hi, x)); }

// tiny concurrency helper
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

/* ---- Black–Scholes helpers ---- */
function normPDF(x){ return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); }
function normCDF(x){
  const k=1/(1+0.2316419*Math.abs(x));
  const a1=0.319381530,a2=-0.356563782,a3=1.781477937,a4=-1.821255978,a5=1.330274429;
  const poly=(((a5*k+a4)*k+a3)*k+a2)*k+a1;
  const cnd=1-normPDF(x)*poly;
  return x>=0?cnd:1-cnd;
}
function bsCall(S,K,T,r,s){ const st=Math.sqrt(T),d1=(Math.log(S/K)+(r+0.5*s*s)*T)/(s*st),d2=d1-s*st;
  return S*normCDF(d1)-K*Math.exp(-r*T)*normCDF(d2); }
function vega(S,K,T,r,s){ const st=Math.sqrt(T),d1=(Math.log(S/K)+(r+0.5*s*s)*T)/(s*st); return S*st*normPDF(d1); }
function impliedVol(price,S,K,T,r,isCall=true){
  if (price<=0||S<=0||K<=0||T<=0) return null;
  const callPx = isCall ? price : (price + S - K*Math.exp(-r*T));
  let s = clamp(Math.sqrt(2*Math.PI/T) * (callPx/Math.max(S,1e-9)), 0.0001, 3.0);
  for (let i=0;i<100;i++){
    const model=bsCall(S,K,T,r,s), diff=model-callPx, vg=vega(S,K,T,r,s);
    if (Math.abs(diff)<1e-4) return clamp(s,0.0001,5);
    if (!isFinite(vg)||vg<=1e-8) break;
    s=clamp(s-diff/vg,0.0001,5);
  }
  return null;
}

/* ========= Resilient HTTP ========= */
async function httpGet(url, {params, timeout=20000, headers, retries=4, baseDelay=800} = {}) {
  headers = { 'User-Agent':'cvi-bot/1.0', ...headers };
  for (let i=0;i<=retries;i++){
    try { return await axios.get(url, { params, timeout, headers }); }
    catch(e){
      const s = e?.response?.status;
      if (s===429 || (s>=500 && s<=599)) {
        const backoff = baseDelay*Math.pow(1.7,i) + Math.random()*300;
        await delay(backoff);
        continue;
      }
      throw e;
    }
  }
  throw new Error('max retries exceeded for '+url);
}

/* ========= Data sources ========= */
async function getSpotFromCoingecko(symbol){
  if (!USE_CG) return null;
  const id = COINGECKO_IDS[symbol]; if (!id) return null;
  const data = await cgGet('/simple/price', { ids:id, vs_currencies:'usd' });
  return data?.[id]?.usd ?? null;
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
// 30d realized (CoinGecko), used when options fail
async function getRealizedVol30d(symbol){
  if (!USE_CG) return null;
  const id = COINGECKO_IDS[symbol]; if (!id) return null;
  try{
    const data = await cgGet(`/coins/${id}/market_chart`, { vs_currency:'usd', days:30, interval:'daily' });
    const prices = data?.prices || [];
    if (prices.length < 10) return null;
    const rets = [];
    for (let i=1;i<prices.length;i++) rets.push(Math.log(prices[i][1]/prices[i-1][1]));
    const mean = rets.reduce((s,x)=>s+x,0)/rets.length;
    const varc = rets.reduce((s,x)=>s+(x-mean)*(x-mean),0)/rets.length;
    const std = Math.sqrt(varc);
    return std*Math.sqrt(365);
  }catch{ return null; }
}

/* ========= Signal helpers ========= */
function ema(arr, period){ const k=2/(period+1); let e=null; const out=[]; for (const x of arr){ e=(e===null)?x:(x*k+e*(1-k)); out.push(e);} return out; }
function percentile(arr, p){ if(!arr.length) return null; const a=[...arr].sort((x,y)=>x-y);
  const idx=Math.max(0, Math.min((p/100)*(a.length-1), a.length-1)); const lo=Math.floor(idx), hi=Math.ceil(idx);
  if (lo===hi) return a[lo]; const w=idx-lo; return a[lo]*(1-w)+a[hi]*w; }

function buildSignal(series){
  const y = series.map(p => Number(p.vega_weighted_iv ?? p.atm_iv)).filter(x => isFinite(x));
  if (y.length < 30) return null;
  const fast=ema(y,20), slow=ema(y,100);
  const last=y[y.length-1], fLast=fast[fast.length-1], sLast=slow[slow.length-1];
  const fPrev=fast[fast.length-2], sPrev=slow[slow.length-2];
  const crossedUp   = fPrev <= sPrev && fLast > sLast;
  const crossedDown = fPrev >= sPrev && fLast < sLast;
  const window=y.slice(-252); const loP=percentile(window,10), hiP=percentile(window,90);
  let rec='Hold', strength=0.0, reason=[];
  if (crossedUp){ rec='Long Volatility'; strength+=0.5; reason.push('EMA20 > EMA100 (bullish IV trend)'); }
  if (crossedDown){ rec='Short Volatility'; strength+=0.5; reason.push('EMA20 < EMA100 (bearish IV trend)'); }
  if (isFinite(hiP) && last>=hiP){ rec='Short Volatility'; strength+=0.6; reason.push('IV at 90th percentile'); }
  if (isFinite(loP) && last<=loP){ rec='Long Volatility'; strength+=0.6; reason.push('IV at 10th percentile'); }
  strength=clamp(strength,0,1);
  const sizing=Math.round((0.5+strength/2)*100)/100;
  return { ts:new Date().toISOString(), recommendation:rec, strength, size_hint:sizing,
           reason:reason.join('; '), last_iv:last, ema20:fLast, ema100:sLast };
}

/* ========= Tick helpers ========= */
function cloneLastRowWithNewTime(series){
  if (!series || !series.length) return null;
  const last = series[series.length-1];
  return {
    t: new Date().toISOString(),
    spot: last.spot ?? null,
    days_to_expiry: last.days_to_expiry ?? TARGET_DAYS.toFixed(2),
    atm_iv: last.atm_iv ?? null,
    vega_weighted_iv: last.vega_weighted_iv ?? null
  };
}

/* ========= Per-asset build (never returns without writing a row) ========= */
async function buildForAsset(symbol){
  const docsDir = path.join(process.cwd(), 'docs');
  const assetDir = path.join(docsDir, symbol);
  ensureDir(docsDir); ensureDir(assetDir);

  const tsPath = path.join(assetDir,'cvi_timeseries.json');
  let series = readJSON(tsPath, []);

  const nowISO = new Date().toISOString();

  try {
    // ---- Spot ----
    let S = await getSpotFromCoingecko(symbol);
    if (!S) S = await getSpotFromDeribitIndex(symbol);
    if (!S && series.length) S = Number(series[series.length-1].spot) || null;

    // ---- Options (Deribit) ----
    const instruments = await getInstruments(symbol);
    const now = Date.now();

    let smile = [], atm_iv=null, vega_weighted_iv=null, days_to_expiry=null, smileSynthetic=false;

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

        // ±40% around spot, fewer strikes, low concurrency
        const rawAtT = instruments
          .filter(x => x.expiration_timestamp === tgt && x.is_active)
          .filter(x => Math.abs(x.strike / (S||1) - 1) <= 0.40);

        const calls = rawAtT.filter(x => x.option_type === 'call')
          .sort((a,b)=>Math.abs(a.strike-(S||a.strike))-Math.abs(b.strike-(S||b.strike)))
          .slice(0, 80);
        const puts  = rawAtT.filter(x => x.option_type === 'put')
          .sort((a,b)=>Math.abs(a.strike-(S||a.strike))-Math.abs(b.strike-(S||b.strike)))
          .slice(0, 80);

        // polite to the API
        const callTicks = await pMapLimit(calls, 3, async inst => {
          const price = await getMarkOrLast(inst.instrument_name);
          await delay(120); // tiny jitter
          return { inst, price };
        });
        const putTicks  = await pMapLimit(puts,  3, async inst => {
          const price = await getMarkOrLast(inst.instrument_name);
          await delay(120);
          return { inst, price };
        });

        const putByStrike = new Map();
        for (const kv of putTicks) {
          const price = kv?.price;
          if (price && isFinite(price)) putByStrike.set(kv.inst.strike, price);
        }

        for (const kv of callTicks) {
          const {inst} = kv || {}; if (!inst) continue;
          let px = (kv.price && isFinite(kv.price)) ? kv.price : null;
          if (!px) {
            const p = putByStrike.get(inst.strike);
            if (p && isFinite(p)) px = p + (S||0) - inst.strike*Math.exp(-RISK_FREE*T);
          }
          if (!px || px <= 0) continue;
          const iv = impliedVol(px, (S||inst.strike), inst.strike, T, RISK_FREE, true);
          if (iv && isFinite(iv)) smile.push({ strike: inst.strike, iv: clamp(iv, 0.01, 3.0) });
        }

        // if still sparse, use puts directly
        if (smile.length < 3) {
          for (const kv of putTicks) {
            const {inst, price} = kv || {};
            if (!inst || !price || !isFinite(price) || price <= 0) continue;
            const iv = impliedVol(price, (S||inst.strike), inst.strike, T, RISK_FREE, false);
            if (iv && isFinite(iv)) smile.push({ strike: inst.strike, iv: clamp(iv, 0.01, 3.0) });
          }
        }

        smile.sort((a,b)=>a.strike-b.strike);

        if (smile.length){
          const atm = smile.reduce((best,p)=>
            Math.abs(p.strike-(S||p.strike))<Math.abs(best.strike-(S||best.strike))?p:best, smile[0]);
          atm_iv = atm.iv;

          const band20 = smile.filter(p=>Math.abs(p.strike/(S||p.strike)-1)<=0.10);
          const band = band20.length ? band20 : smile;
          const parts = band.map(p=>{
            const sig=p.iv, vg=vega((S||p.strike),p.strike,(parseFloat(days_to_expiry)||TARGET_DAYS)/365,RISK_FREE,sig);
            return { w: Math.max(1e-8, vg), iv: sig };
          });
          const wsum = parts.reduce((s,x)=>s+x.w,0);
          const ivsum = parts.reduce((s,x)=>s+x.w*x.iv,0);
          vega_weighted_iv = ivsum/wsum;

          // keep display tidy
          const displayBand = smile.filter(p => Math.abs(p.strike/(S||p.strike) - 1) <= 0.20);
          if (displayBand.length >= 3) smile = displayBand;
        }
      }
    }

    // Fallbacks if no IV computed
    if (atm_iv==null && vega_weighted_iv==null){
      let rv = await getRealizedVol30d(symbol);
      if (rv==null && series.length){
        const y = series.slice(-30).map(p => Number(p.vega_weighted_iv ?? p.atm_iv)).filter(x=>isFinite(x));
        if (y.length) rv = y.reduce((s,x)=>s+x,0)/y.length;
      }
      const val = (rv!=null) ? rv : (series.length ? (series[series.length-1].vega_weighted_iv ?? series[series.length-1].atm_iv ?? 0.5) : 0.5);
      atm_iv = vega_weighted_iv = clamp(val, 0.05, 2.0);
    }

    // Write real smile if present; else synthesize one so charts never blank
    if (Array.isArray(smile) && smile.length) {
      writeJSON(path.join(assetDir,'cvi.json'), smile);
      writeJSON(path.join(assetDir,'smile_meta.json'), {
        synthetic:false, source:'real', coingecko_used:!!USE_CG, generated_at: nowISO
      });
    } else {
      const baseIV = Number(vega_weighted_iv ?? atm_iv);
      const Sguess = (series[series.length-1]?.spot ?? 100);
      const width = 0.35, n=7;
      const ks = Array.from({length:n}, (_,i)=>{ const t=i/(n-1); return Sguess*(1 - width + 2*width*t); });
      const smileSynth = ks.map(K => {
        const m=Math.log(K / (Sguess||1));
        const iv=Math.max(0.01, (baseIV||0.5)*(1 + 2*m*m - 0.25*m));
        return { strike: Math.round(K), iv: clamp(iv, 0.01, 3.0) };
      });
      writeJSON(path.join(assetDir,'cvi.json'), smileSynth);
      writeJSON(path.join(assetDir,'smile_meta.json'), {
        synthetic:true, source:'synthetic', coingecko_used:!!USE_CG, generated_at: nowISO
      });
    }

    // ---- Append row (real or fallback) ----
    const newRow = {
      t: nowISO,
      spot: (series.length? (S ?? series[series.length-1].spot) : (S ?? 100)),
      days_to_expiry: (typeof days_to_expiry==='string' || typeof days_to_expiry==='number')
        ? days_to_expiry : TARGET_DAYS.toFixed(2),
      atm_iv, vega_weighted_iv
    };
    series.push(newRow);
  } catch (err) {
    console.error(`[${symbol}] build failed, ticking last row:`, err?.message || err);
    if (ALWAYS_TICK){
      const clone = cloneLastRowWithNewTime(series);
      if (clone) series.push(clone);
      else {
        // first-ever run and everything failed: write a neutral seed so UI shows a dot
        series.push({ t: nowISO, spot: 100, days_to_expiry: TARGET_DAYS.toFixed(2), atm_iv: 0.2, vega_weighted_iv: 0.2 });
      }
    }
  }

  // Trim, persist, and update signal + manifest hooks
  if (series.length > MAX_TS_POINTS) series = series.slice(series.length - MAX_TS_POINTS);
  writeJSON(tsPath, series);

  // Signals
  const sigPath = path.join(assetDir,'signals.json');
  const sigs = readJSON(sigPath, []);
  const sig = buildSignal(series);
  if (sig){ sigs.push(sig); if (sigs.length> SIGNAL_HISTORY) sigs.splice(0, sigs.length - SIGNAL_HISTORY); }
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

/* ========= Orchestrate all assets + merge manifest ========= */
(async function main(){
  if (!ASSETS.length) { console.log('No assets selected. Exiting.'); process.exit(0); }
  console.log('CoinGecko mode:', CG_MODE, 'use=', USE_CG, 'ALWAYS_TICK=', ALWAYS_TICK);
  console.log('CoinGecko plan:', COINGECKO_PLAN);
  console.log('Assets:', ASSETS.join(', '));

  const docsDir = path.join(process.cwd(),'docs'); ensureDir(docsDir);
  const manifestPath = path.join(docsDir,'cvi_manifest.json');
  const prev = readJSON(manifestPath, { assets: [] });
  const prevMap = new Map((prev.assets || []).map(a => [a.symbol, a]));

  const results = [];
  for (const sym of ASSETS){
    try { results.push(await buildForAsset(sym)); }
    catch (e) { console.error(`[${sym}] unrecoverable error`, e?.message||e); }
    await delay(600 + Math.random()*400);
  }

  for (const r of results) prevMap.set(r.symbol, { symbol:r.symbol, files:r.files, latest:r.latest });
  const mergedAssets = Array.from(prevMap.values())
    .filter(a => ASSETS.includes(a.symbol)); // keep manifest tight to tracked set
  writeJSON(manifestPath, { assets: mergedAssets });
  console.log('Updated manifest with', mergedAssets.length, 'asset(s).');
})();
