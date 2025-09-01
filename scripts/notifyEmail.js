const fs = require('fs');
const nodemailer = require('nodemailer');
const path = require('path');

// ---- Email configuration (GitHub secrets) ----
const EMAIL_USER = process.env.EMAIL_USER || '';     // Your email
const EMAIL_PASS = process.env.EMAIL_PASS || '';     // App password
const TO_EMAIL = process.env.TO_EMAIL || '';         // The email to send alerts

// ---- Volatility-based settings ----
const VOLATILITY_THRESHOLD = 0.1;  // 10% price movement (can be adjusted to 20% for larger swings)
const EMA_CROSS_THRESHOLD = 0.05;  // 5% EMA cross threshold for buy/sell signals
const RSI_OVERBOUGHT = 70;         // Overbought RSI threshold
const RSI_OVERSOLD = 30;           // Oversold RSI threshold

// Email transport configuration (using Gmail here)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// Verify email transport connection to ensure credentials are correct
transporter.verify((error, success) => {
  if (error) {
    console.log('Error occurred during email transporter verification:', error);
  } else {
    console.log('Server is ready to send emails.');
  }
});

// Read JSON data for assets, volatility, and signals
const docsDir = path.join(process.cwd(), 'docs');
const statePath = path.join(docsDir, 'notify_state.json');
const assetManifestPath = path.join(docsDir, 'cvi_manifest.json');

// Helper to read JSON safely
function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// Function to send email
function sendEmail(subject, body) {
  const mailOptions = {
    from: EMAIL_USER,
    to: TO_EMAIL,
    subject,
    text: body,
  };

  transporter.sendMail(mailOptions, function (error, info) {
    if (error) {
      console.log('Error sending email:', error);
    } else {
      console.log('Email sent: ' + info.response);
    }
  });
}

(async function main() {
  const manifest = readJSON(assetManifestPath, { assets: [] });
  let state = readJSON(statePath, {});

  for (const asset of manifest.assets || []) {
    const sym = asset.symbol;
    const signalPath = path.join(docsDir, sym, 'signals.json');
    if (!fs.existsSync(signalPath)) continue;

    const signals = readJSON(signalPath, []);
    if (!signals.length) continue;

    const lastSignal = signals[signals.length - 1];
    const lastSentTs = state[sym]?.last_ts ? new Date(state[sym].last_ts) : null;
    const thisTs = new Date(lastSignal.ts);

    // Skip if already notified
    if (lastSentTs && thisTs <= lastSentTs) continue;

    let alertBody = '';
    let alertSubject = '';

    // 1. Check for significant volatility (10% movement)
    const priceChange = Math.abs(lastSignal.price_change_percent) >= VOLATILITY_THRESHOLD * 100;
    if (priceChange) {
      alertSubject = `${sym} Price Alert - ${lastSignal.price_change_percent}% Change`;
      alertBody = `Significant price change detected for ${sym}: ${lastSignal.price_change_percent}%.\nPrice: ${lastSignal.price}\nTime: ${new Date(lastSignal.ts).toLocaleString()}`;
      sendEmail(alertSubject, alertBody);
    }

    // 2. Check for EMA cross (5% threshold for buy/sell signals)
    const emaCross = Math.abs(lastSignal.ema20 - lastSignal.ema100) / lastSignal.ema100 >= EMA_CROSS_THRESHOLD;
    if (emaCross) {
      alertSubject = `${sym} EMA Crossover Alert`;
      alertBody = `EMA crossover detected for ${sym}:\nShort-term (20-period) EMA: ${lastSignal.ema20}\nLong-term (100-period) EMA: ${lastSignal.ema100}\nTime: ${new Date(lastSignal.ts).toLocaleString()}`;
      sendEmail(alertSubject, alertBody);
    }

    // 3. RSI Oversold/Overbought Condition
    if (lastSignal.rsi >= RSI_OVERBOUGHT) {
      alertSubject = `${sym} Overbought RSI Alert`;
      alertBody = `RSI for ${sym} is above 70 (overbought). RSI: ${lastSignal.rsi}\nTime: ${new Date(lastSignal.ts).toLocaleString()}`;
      sendEmail(alertSubject, alertBody);
    } else if (lastSignal.rsi <= RSI_OVERSOLD) {
      alertSubject = `${sym} Oversold RSI Alert`;
      alertBody = `RSI for ${sym} is below 30 (oversold). RSI: ${lastSignal.rsi}\nTime: ${new Date(lastSignal.ts).toLocaleString()}`;
      sendEmail(alertSubject, alertBody);
    }

    // Update the last notification time
    state[sym] = { last_ts: lastSignal.ts };
  }

  // Persist the deduplication state
  try { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); } catch {}
})();
