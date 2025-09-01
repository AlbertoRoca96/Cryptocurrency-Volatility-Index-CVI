// scripts/strategyEngine.js
const fs = require('fs');
const path = require('path');

/** ---------- utils ---------- **/
function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
const nonNull = v => v != null && isFinite(v);

/** Percentile rank of x within arr (0..1). If window is tiny, return 0.5 */
function pctRank(arr, x) {
  const a = arr.filter(nonNull).slice().sort((m,n)=>m-n);
  if (a.length < 8 || !nonNull(x)) return 0.5;
  let lo = 0;
  while (lo < a.length && a[lo] <= x) lo++;
  return lo / a.length;
}

/**
 * ERI (Equitable Risk Index) 0..100
 * - uses last 252 snapshots of vega IV (fallback to ATM)
 * - 10th percentile -> ~0, 90th -> ~100
 */
function computeERI(series) {
  const y = series.map(p => Number(p.vega_weighted_iv ?? p.atm_iv)).filter(nonNull);
  const window = y.slice(-252);
  const last = y[y.length - 1];
  if (!nonNull(last)) return { score: null, last };

  const r = pctRank(window, last);
  const stretched = Math.min(1, Math.max(0, (r - 0.1) / 0.8)); // emphasize extremes
  const score = Math.round(stretched * 100);
  return { score, last };
}

/** Turn ERI into a simple trade idea + size (paper trading) */
function decideAction(score) {
  if (!nonNull(score)) return { action: 'HOLD', size: 0.0, reason: 'no score' };
  if (score >= 80) return { action: 'SHORT_VOL', size: +(0.5 + 0.5*((score-80)/20)).toFixed(2), reason: 'IV ≥ 80th pct' };
  if (score <= 20) return { action: 'LONG_VOL',  size: +(0.5 + 0.5*((20-score)/20)).toFixed(2), reason: 'IV ≤ 20th pct' };
  return { action: 'HOLD', size: 0.25, reason: 'mid regime' };
}

/** ---------- main ---------- **/
(function main() {
  const manifestPath = path.join('docs', 'cvi_manifest.json');
  const manifest = readJSON(manifestPath, { assets: [] });

  const orders = [];
  for (const a of manifest.assets || []) {
    const sym = a.symbol;
    const tsPath = path.join('docs', sym, 'cvi_timeseries.json');
    const series = readJSON(tsPath, []);
    const { score, last } = computeERI(series);
    const { action, size, reason } = decideAction(score);

    const out = {
      symbol: sym,
      ts: new Date().toISOString(),
      last_iv: nonNull(last) ? +(+last).toFixed(6) : null,
      eri: score,
      recommendation: action,
      size_hint: size,
      reason
    };

    writeJSON(path.join('docs', sym, 'risk_index.json'), out);
    orders.push(out);
  }

  // Roll-up for downstream bots/dashboards
  writeJSON(path.join('docs', 'orders.json'), {
    generated_at: new Date().toISOString(),
    items: orders
  });

  console.log('Strategy engine wrote', orders.length, 'asset(s).');
})();
