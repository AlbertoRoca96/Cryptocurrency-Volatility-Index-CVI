const fs = require('fs');
const nodemailer = require('nodemailer');
const path = require('path');

/* ---------- Email configuration (GitHub Secrets) ---------- */
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const TO_EMAIL   = process.env.TO_EMAIL   || '';

/* ---------- Alert policy (based on fields we actually write) ----------
   NOTIFY_ON:           "strong" | "non-hold" | "all"
   NOTIFY_MIN_STRENGTH: minimum strength for "strong" mode (default 0.5)
   EMA_CROSS_THRESHOLD: relative |ema20-ema100|/|ema100| needed to call it a cross (default 0)
----------------------------------------------------------------------- */
const NOTIFY_ON = (process.env.NOTIFY_ON || 'strong').toLowerCase();
const NOTIFY_MIN_STRENGTH = Number(process.env.NOTIFY_MIN_STRENGTH || '0.5');
const EMA_CROSS_THRESHOLD = Number(process.env.EMA_CROSS_THRESHOLD || '0');

/* ---------- Transport (Gmail) ---------- */
if (!EMAIL_USER || !EMAIL_PASS || !TO_EMAIL) {
  console.log('Email secrets missing; skipping notifications.');
  process.exit(0);
}
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});
transporter.verify((error) => {
  if (error) console.log('Email transporter verification error:', error?.message || error);
  else console.log('Email transporter ready.');
});

/* ---------- IO helpers ---------- */
const docsDir = path.join(process.cwd(), 'docs');
const statePath = path.join(docsDir, 'notify_state.json');
const assetManifestPath = path.join(docsDir, 'cvi_manifest.json');

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function sendEmail(subject, body) {
  const mailOptions = { from: EMAIL_USER, to: TO_EMAIL, subject, text: body };
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) console.log('Error sending email:', error);
    else console.log('Email sent:', info.response);
  });
}

/* ---------- Policy helpers ---------- */
function recIsNonHold(rec) {
  return typeof rec === 'string' && rec.toLowerCase() !== 'hold';
}

function shouldNotifyByPolicy(last, prev) {
  const rec = (last.recommendation || '').toString();
  const nonHold = recIsNonHold(rec);
  const strengthOK = Number(last.strength) >= NOTIFY_MIN_STRENGTH;
  const recChanged = !prev || prev.recommendation !== last.recommendation;

  if (NOTIFY_ON === 'all') return true;
  if (NOTIFY_ON === 'non-hold') return nonHold;
  // strong
  return nonHold && strengthOK && recChanged;
}

/* Detect EMA crossover between the last two signals */
function emaCrossInfo(prev, last) {
  if (!prev || !isFinite(prev.ema20) || !isFinite(prev.ema100) ||
      !isFinite(last.ema20) || !isFinite(last.ema100)) return null;

  const prevDiff = prev.ema20 - prev.ema100;
  const lastDiff = last.ema20 - last.ema100;
  const crossedUp   = prevDiff <= 0 && lastDiff > 0;
  const crossedDown = prevDiff >= 0 && lastDiff < 0;

  if (!(crossedUp || crossedDown)) return null;

  const base = Math.abs(last.ema100) || 1;
  const relMag = Math.abs(lastDiff) / base;
  if (relMag < EMA_CROSS_THRESHOLD) return null;

  return { dir: crossedUp ? 'up' : 'down', relMag };
}

/* ---------- Main ---------- */
(async function main () {
  const manifest = readJSON(assetManifestPath, { assets: [] });
  let state = readJSON(statePath, {});

  for (const asset of manifest.assets || []) {
    const sym = asset.symbol;
    const sigPath = path.join(docsDir, sym, 'signals.json');
    if (!fs.existsSync(sigPath)) continue;

    const signals = readJSON(sigPath, []);
    if (!Array.isArray(signals) || signals.length === 0) continue;

    const last = signals[signals.length - 1];
    const prev = signals.length > 1 ? signals[signals.length - 2] : null;

    const lastSentTs = state[sym]?.last_ts ? new Date(state[sym].last_ts) : null;
    const thisTs = new Date(last.ts);

    // De-dupe: if we already notified at this exact signal timestamp, skip.
    if (lastSentTs && thisTs <= lastSentTs) continue;

    // Policy: recommendation/strength based
    const policyOk = shouldNotifyByPolicy(last, prev);

    // EMA cross (optional extra line in the email)
    const cross = emaCrossInfo(prev, last);

    if (!policyOk && !cross) {
      // Nothing to report for this asset
      continue;
    }

    // Build the email (single email per asset per new signal)
    let subject = `${sym} Volatility Signal: ${last.recommendation} (${Math.round((last.strength || 0)*100)}%)`;
    if (cross) subject += ` — EMA cross ${cross.dir === 'up' ? '↑' : '↓'}`;

    const body =
`Asset: ${sym}
Time: ${new Date(last.ts).toLocaleString()}
Recommendation: ${last.recommendation}
Strength: ${Math.round((last.strength || 0)*100)}%
Reason(s): ${last.reason || 'n/a'}
IV: ${isFinite(last.last_iv) ? last.last_iv.toFixed(4) : 'n/a'}
EMA20: ${isFinite(last.ema20) ? last.ema20.toFixed(4) : 'n/a'} | EMA100: ${isFinite(last.ema100) ? last.ema100.toFixed(4) : 'n/a'}
${cross ? `EMA crossover detected (${cross.dir}), relative magnitude ~ ${(cross.relMag*100).toFixed(2)}%` : ''}

Mode: ${NOTIFY_ON}${NOTIFY_ON==='strong' ? ` (min strength ${NOTIFY_MIN_STRENGTH})` : ''}`;

    sendEmail(subject, body);

    // Update de-dupe state
    state[sym] = {
      last_ts: last.ts,
      last_recommendation: last.recommendation,
      last_cross: cross ? cross.dir : (state[sym]?.last_cross || null)
    };
  }

  try { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); } catch {}
})();
