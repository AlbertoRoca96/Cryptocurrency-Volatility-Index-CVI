# Cryptocurrency Volatility Index (CVI)

> Tracks and forecasts crypto market volatility (BTC, ETH, more), computes **CVI** and **Expected Risk Index (ERI)**, evaluates **EMA/RSI** signals, and publishes a **real-time dashboard** with alerts, paper trades, and volatility smiles — automated via GitHub Actions on a 15-minute or hourly cadence.

---

## 📊 What this project does

- **Multi-asset coverage:** Bitcoin, Ethereum, and other tracked assets.
- **Data ingestion:** Pulls from multiple APIs (e.g., **Deribit**, **CoinGecko**) for spot prices, options data, implied volatilities (IV), and other derivatives metadata.
- **Volatility metrics:**
  - **CVI (Cryptocurrency Volatility Index):** Blends **implied** and **historical** volatility to express expected price fluctuation.
  - **Historical/realized volatility:** Rolling stats for context and backtests.
- **Risk & sizing:**
  - **ERI (Expected Risk Index):** Per-asset risk score derived from market volatility.
  - **Position size hint:** Uses ERI + configured risk capital to suggest how much to trade.
- **Technical signals:**
  - **EMA crossovers:** Detects short-term vs long-term EMA crosses and emits **Buy/Sell** signals.
  - **RSI checks:** Flags **overbought** (RSI > 70) / **oversold** (RSI < 30) conditions.
- **Event alerts:** Notifies on:
  - Significant **price changes** (threshold configurable)
  - **EMA** crossovers
  - **RSI** overbought/oversold triggers
- **Paper trading:** Generates **paper orders** (buy/sell + size hint) based on current signals and risk.
- **Realtime dashboard:** Visualizes **volatility smiles**, **risk**, **signals**, **orders**, and latest **market sentiment** on the web (GitHub Pages).
- **Automation:** Runs **periodically** (every **15 minutes** or **hourly**) via GitHub Actions to fetch data, recompute indices, refresh the dashboard, and send alerts.

---

## 🗂️ Repository structure

