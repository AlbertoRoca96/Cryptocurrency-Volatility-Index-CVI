// scripts/notifyEmail.js
// Sends email notifications when a *new* signal appears for any asset.
// Uses NodeMailer; configure via GitHub Secrets. Plays nice with your docs/ tree.

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// ---- Required env (set in GitHub Secrets) ----
const EMAIL_USER = process.env.EMAIL_USER || ''; // Your email address
const EMAIL_PASS = process.env.EMAIL_PASS || ''; // Your email app password (not the regular email password)
const TO_EMAIL = process.env.TO_EMAIL || 'alroca308@gmail.com'; // Your email for receiving alerts

// ---- Optional env tuning ----
// 'strong' (default): only non-Hold with strength >= NOTIFY_MIN_STRENGTH
// 'non-hold'        : only recommendations != 'Hold'
// 'all'             : every new signal, regardless of strength
const MODE = (process.env.NOTIFY_ON || 'strong').toLowerCase();
const MIN_STRENGTH = Math.max(0, Math.min(1, parseFloat(process.env.NOTIFY_MIN_STRENGTH || '0.5')));

// Exit quietly if not configured
if (!EMAIL_USER || !EMAIL_PASS || !TO_EMAIL) {
  console.log('Email disabled: missing EMAIL_* or TO_EMAIL env.');
  process.exit(0);
}

const transporter = nodemailer.createTransport({
  service: 'gmail', // change if you're using another service
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

const docsDir = path.join(process.cwd(), 'docs');
const manifestPath = path.join(docsDir, 'cvi_manifest.json');
const statePath = path.join(docsDir, 'notify_state.json');

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function shouldSend(rec, strength) {
  const recLow = (rec || '').toLowerCase();
  if (MODE === 'all') return true;
  if (MODE === 'non-hold') return recLow !== 'hold';
  // strong (default)
  return recLow !== 'hold' && (Number(strength) >= MIN_STRENGTH);
}

(async function main(){
  const manifest = readJSON(manifestPath, { assets: [] });
  let state = readJSON(statePath, {});
  const messages = [];

  for (const a of manifest.assets || []) {
    const sym = a.symbol;
    const sigPath = path.join(docsDir, sym, 'signals.json');
    if (!fs.existsSync(sigPath)) continue;

    const sigs = readJSON(sigPath, []);
    if (!sigs.length) continue;

    const last = sigs[sigs.length - 1];
    const lastSentTs = state[sym]?.last_ts ? new Date(state[sym].last_ts) : null;
    const thisTs = new Date(last.ts);

    if (lastSentTs && thisTs <= lastSentTs) continue; // already alerted

    if (!shouldSend(last.recommendation, last.strength)) continue;

    const lv = (last.last_iv != null) ? Number(last.last_iv).toFixed(4) : 'n/a';
    const e20 = (last.ema20   != null) ? Number(last.ema20).toFixed(4)   : 'n/a';
    const e100= (last.ema100  != null) ? Number(last.ema100).toFixed(4)  : 'n/a';
    const size= (last.size_hint!= null) ? String(last.size_hint)         : 'n/a';

    const body = `[CVI] ${sym}: ${last.recommendation} (${Math.round((last.strength||0)*100)}%) — IV:${lv} 20:${e20} 100:${e100} size:${size} @ ${new Date(last.ts).toLocaleString()}`;
    messages.push({ sym, ts: last.ts, body });
  }

  // Send
  for (const m of messages) {
    const mailOptions = {
      from: EMAIL_USER,
      to: TO_EMAIL,
      subject: `[CVI Alert] ${m.sym} - ${new Date(m.ts).toLocaleString()}`,
      text: m.body,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Sent email to ${TO_EMAIL}: ${m.body}`);
    } catch (e) {
      console.error(`Email error (${m.sym}):`, e?.message || e);
    }

    state[m.sym] = { last_ts: m.ts };
  }

  // Persist dedupe state
  try { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); } catch {}

  console.log(`Alerts sent: ${messages.length}`);
})();
