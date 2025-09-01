// scripts/fetchOptionsData.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');

/* ============== Settings ============== */
const ASSETS = ['BTC','ETH','SOL','BNB','XRP','ADA','AVAX','DOGE','LINK','LTC'];
const DERIBIT_ASSETS = new Set(['BTC','ETH']); // Only these have options on Deribit
const COINGECKO_IDS = {
  BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin', XRP:'ripple',
  ADA:'cardano', AVAX:'avalanche-2', DOGE:'dogecoin', LINK:'chainlink', LTC:'litecoin'
};
const RISK_FREE = 0.01;
const TARGET_DAYS = 30;
const MAX_TS_POINTS = 2000;
const SIGNAL_HISTORY = 50;
const MAX_TICKERS_CONCURRENCY = 24; // limit parallel Deribit ticker fetches

/* ============== HTTP (retry + keep-alive) ============== */
const http = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true })
});

async function getWithRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await http.get(url, opts); }
    catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

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
function impliedVol(price,S,K,T,r,isCall=true){
  if (price<=0||S<=0||K<=0||T<=0) return null;
  let s=0.5; const tol=1e-4;
  for (let i=0;i<100;i++){
    const st=Math.sqrt(T);
    const d1=(Math.log(S/K)+(r+0.5*s*s)*T)/(s*st), d2=d1-s*st;
    const model = isCall
      ? S*normCDF(d1) - K*Math.exp(-r*T)*normCDF(d2)
      : K*Math.exp(-r*T)*normCDF(-d2) - S*normCDF(-d1);
    const diff=model-price; if (Math.abs(diff)<tol) return clamp(s,0.0001,5);
    const v=vega(S,K,T,r,s); if (!isFinite(v)||v<=1e-8) break;
    s=clamp(s-diff/v,0.0001,5);
  }
  return null;
}

/* ============== Generic helpers ============== */
function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p,{recursive:true}); }
function readJSON(p,fallback){ try{ return JSON.parse(fs.readFileSync(p,'utf8')); }catch{ return fallback; } }
function writeJSON(p,data){ fs.writeFileSync(p, JSON.stringify(data,null,2)); }

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0, active = 0;
  return await new Promise(resolve => {
    const next = () => {
      while (active < limit && i < items.length) {
        const idx = i++, item = items[idx];
        active++;
        Promise.resolve(worker(item, idx))
          .then(res => results[idx] = res)
          .catch(() => results[idx] = null)
          .finally(() => { active--; if (i === items.length && active === 0) resolve(results); else next(); });
      }
    };
    next();
  });
}

/* ============== Data sources ============== */
async function getSpotUSD(symbol){
  const id = COINGECKO_IDS[symbol]; if (!id) return null;
  const url=`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
  const r = await getWithRetry(url);
  return r?.data?.[id]?.usd ?? null;
}
async function getInstruments(symbol){
  const r = await getWithRetry('https://www.deribit.com/api/v2/public/get_instruments', {
    params:{currency:symbol,kind:'option'}, timeout:20000
  });
  return r?.data?.result ?? [];
}
async function getMarkOrLast(instrument_name){
  try{
    const r = await getWithRetry('https://www.deribit.com/api/v2/public/ticker', {
      params:{instrument_name}, timeout:15000
    });
    const t=r?.data?.result||{};
    const p = Number(t.mark_price ?? t.last_price ?? NaN);
    return isFinite(p)?p:null;
  }catch{ return null; }
}
// 30d realized volatility proxy if no options (daily closes from Coingecko)
async function getRealizedVol30d(symbol){
  const id = COINGECKO_IDS[symbol]; if (!id) return null;
  const url=`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=30&interval=daily`;
  try{
    const r = await getWithRetry(url, { timeout:20000 });
    const prices = r?.data?.prices || []; // [ [ts, price], ... ]
    if (prices.length < 10) return null;
    const rets = [];
    for (let i=1;i<prices.length;i++){
      rets.push(Math.log(prices[i][1]/prices[i-1][1]));
    }
    const mean = rets.reduce((s,x)=>s+x,0)/rets.length;
    const varN = rets.reduce((s,x)=>s+(x-mean)*(x-mean),0)/Math.max(1, rets.length-1);
    return Math.sqrt(varN)*Math.sqrt(365); // annualized daily stdev
  }catch{ return null; }
}

/* ============== Signals ============== */
function ema(arr, period){
  const k=2/(period+1); let e=null; const out=[];
  for (const x of arr){ e = (e===null)? x : (x*k + e*(1-k)); out.push(e); }
  return out;
}
function percentile(arr, p){ if(!arr.length) return null;
  const a=[...arr].sort((x,y)=>x-y); const idx=clamp((p/100)*(a.length-1),0,a.length-1);
  const lo=Math.floor(idx), hi=Math.ceil(idx); if (lo===hi) return a[lo];
  const w=idx-lo; return a[lo]*(1-w)+a[hi]*w;
}
function buildSignal(series){
  const y = series.map(p => Number(p.vega_weighted_iv ?? p.atm_iv)).filter(x => isFinite(x));
  if (y.length < 30) return null;

  const fast = ema(y, 20);
  const slow = ema(y, 100);
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
  const sizing = Math.round( (0.5 + strength/2) * 100 )/100; // 0.5x..1.0x

  return {
    ts: new Date().toISOString(),
    recommendation: rec,
    strength,
    size_hint: sizing,
    reason: reason.join('; '),
    last_iv: last,
    ema20: fLast,
    ema100: sLast
  };
}

/* ============== Per-asset pipeline ============== */
async function buildForAsset(symbol){
  const docsDir = path.join(process.cwd(), 'docs');
  const assetDir = path.join(docsDir, symbol);
  ensureDir(docsDir); ensureDir(assetDir);

  // Always ensure files exist so UI never 404s
  const seriesPath = path.join(assetDir,'cvi_timeseries.json');
  const smilePath  = path.join(assetDir,'cvi.json');
  const sigsPath   = path.join(assetDir,'signals.json');
  if (!fs.existsSync(seriesPath)) writeJSON(seriesPath, []);
  if (!fs.existsSync(smilePath))  writeJSON(smilePath, []);
  if (!fs.existsSync(sigsPath))   writeJSON(sigsPath, []);

  const S = await getSpotUSD(symbol);
  if (!S){ console.log(`[${symbol}] No spot`); return { symbol, latest: null, files: mkFiles(symbol) }; }

  let smile = [], atm_iv=null, vega_weighted_iv=null, days_to_expiry=null;

  if (DERIBIT_ASSETS.has(symbol)) {
    try {
      const instruments = await getInstruments(symbol);
      const now = Date.now();
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

          const calls = instruments
            .filter(x => x.expiration_timestamp===tgt && x.option_type==='call' && x.is_active)
            .sort((a,b)=>Math.abs(a.strike-S)-Math.abs(b.strike-S))
            .filter(x=>Math.abs(x.strike/S-1)<=0.20)
            .slice(0,120);

          const tickers = await mapLimit(calls, MAX_TICKERS_CONCURRENCY, async inst => ({
            inst, price: await getMarkOrLast(inst.instrument_name)
          }));

          for (const item of tickers){
            if (!item || !item.price || item.price<=0) continue;
            const iv = impliedVol(item.price, S, item.inst.strike, T, RISK_FREE, true);
            if (iv && isFinite(iv)) smile.push({ strike: item.inst.strike, iv });
          }
          smile.sort((a,b)=>a.strike-b.strike);

          if (smile.length){
            const atm = smile.reduce((best,p)=>Math.abs(p.strike-S)<Math.abs(best.strike-S)?p:best, smile[0]);
            atm_iv = atm.iv;

            const band = smile.filter(p=>Math.abs(p.strike/S-1)<=0.10);
            if (band.length){
              const parts = band.map(p=>{
                const sig=p.iv, vg=vega(S,p.strike,T,RISK_FREE,sig);
                return { w: Math.max(1e-8, vg), iv: sig };
              });
              const wsum = parts.reduce((s,x)=>s+x.w,0);
              const ivsum = parts.reduce((s,x)=>s+x.w*x.iv,0);
              vega_weighted_iv = ivsum/wsum;
            }
          }
        }
      }
    } catch (e) {
      console.log(`[${symbol}] Deribit path failed: ${e.message}`);
    }
  }

  // Fallback for non-Deribit or failures: realized vol
  if (atm_iv==null && vega_weighted_iv==null){
    const rv = await getRealizedVol30d(symbol);
    if (rv!=null){ atm_iv = vega_weighted_iv = rv; days_to_expiry = TARGET_DAYS.toFixed(2); }
  }

  // Write smile (empty ok)
  writeJSON(smilePath, smile);

  // Append timeseries if we have a measurement
  let series = readJSON(seriesPath, []);
  if (atm_iv!=null || vega_weighted_iv!=null){
    series.push({
      t: new Date().toISOString(),
      spot: S,
      days_to_expiry,
      atm_iv, vega_weighted_iv
    });
    if (series.length>MAX_TS_POINTS) series = series.slice(series.length-MAX_TS_POINTS);
    writeJSON(seriesPath, series);
  }

  // Signals (only if we have enough history)
  const sig = buildSignal(series);
  let sigs = readJSON(sigsPath, []);
  if (sig){ sigs.push(sig); if (sigs.length> SIGNAL_HISTORY) sigs = sigs.slice(sigs.length-SIGNAL_HISTORY); }
  writeJSON(sigsPath, sigs);

  return { symbol, latest: series[series.length-1] || null, files: mkFiles(symbol) };
}

function mkFiles(symbol){
  return {
    smile:`/${symbol}/cvi.json`,
    series:`/${symbol}/cvi_timeseries.json`,
    signals:`/${symbol}/signals.json`
  };
}

/* ============== Orchestrate all assets + manifest ============== */
(async function main(){
  const docsDir = path.join(process.cwd(),'docs'); ensureDir(docsDir);

  const results = [];
  for (const sym of ASSETS){
    try{
      const r = await buildForAsset(sym);
      results.push(r); // include even if latest is null so tabs always show
    }catch(e){ console.error(`[${sym}] failed:`, e.message); }
  }

  // deterministic order in manifest (UI tabs stable)
  results.sort((a,b)=> a.symbol.localeCompare(b.symbol));

  const manifest = { version: 1, generated_at: new Date().toISOString(), assets: results };
  writeJSON(path.join(docsDir,'cvi_manifest.json'), manifest);
  console.log('Updated manifest with', manifest.assets.length, 'asset(s).');
})();
