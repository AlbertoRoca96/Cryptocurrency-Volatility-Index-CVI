import os, json, pathlib, time
from typing import Dict, List, Tuple
from datetime import datetime, timezone

import requests
import pandas as pd
import numpy as np

# ---------------- Config ----------------
SYMBOLS = ["BTC", "ETH", "LINK"]
COINGECKO_IDS = {"BTC": "bitcoin", "ETH": "ethereum", "LINK": "chainlink"}

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

API_KEY = (os.environ.get("COINGECKO_API_KEY") or "").strip()
PLAN    = (os.environ.get("COINGECKO_PLAN") or "demo").lower()  # 'demo' or 'pro'

# Binance REST bases (spot). We'll try global first, then US.
BINANCE_BASES = ["https://api.binance.com/api/v3", "https://api.binance.us/api/v3"]
BINANCE_SYMBOLS = {"BTC": "BTCUSDT", "ETH": "ETHUSDT", "LINK": "LINKUSDT"}

# CoinGecko bases/headers used only as a fallback
if PLAN == "pro":
    CG_BASE = "https://pro-api.coingecko.com/api/v3"
    CG_HEADERS = {"accept": "application/json", **({"x-cg-pro-api-key": API_KEY} if API_KEY else {})}
else:
    CG_BASE = "https://api.coingecko.com/api/v3"
    CG_HEADERS = {"accept": "application/json", **({"x-cg-demo-api-key": API_KEY} if API_KEY else {})}

# -------------- Helpers --------------
def _req(url: str, params: dict = None, headers: dict = None, timeout: int = 30):
    return requests.get(url, params=params, headers=headers or {}, timeout=timeout)

def binance_klines_daily(symbol_ccy: str, lookback_days: int = 365) -> pd.DataFrame:
    """
    Fetch ~lookback_days of daily closes from Binance Klines.
    Uses /api/v3/klines (max 1000 bars per call)."""
    end = int(time.time() * 1000)
    start = end - lookback_days * 86400000
    params = {"symbol": symbol_ccy, "interval": "1d", "startTime": start, "endTime": end, "limit": 1000}
    last_err = None
    for base in BINANCE_BASES:
        try:
            r = _req(f"{base}/klines", params=params)
            r.raise_for_status()
            rows = r.json()
            if not rows:
                continue
            df = pd.DataFrame(rows, columns=[
                "openTime","open","high","low","close","volume",
                "closeTime","qav","trades","takerBase","takerQuote","ignore"
            ])
            df["date"]  = pd.to_datetime(df["closeTime"], unit="ms", utc=True).dt.date
            df["close"] = df["close"].astype(float)
            return df[["date","close"]].groupby("date", as_index=False)["close"].last()
        except Exception as e:
            last_err = e
            continue
    raise last_err or RuntimeError("Binance klines fetch failed")

def coingecko_market_chart_daily(coin_id: str, plan: str) -> pd.DataFrame:
    """Fallback: CoinGecko daily closes (365-day cap on the public plan)."""
    params = {"vs_currency": "usd", "interval": "daily", "days": ("max" if plan == "pro" else "365")}
    r = _req(f"{CG_BASE}/coins/{coin_id}/market_chart", params=params, headers=CG_HEADERS)
    if r.status_code == 401 and plan != "pro" and API_KEY:
        params["x_cg_demo_api_key"] = API_KEY  # retry via query param if header stripped
        r = _req(f"{CG_BASE}/coins/{coin_id}/market_chart", params=params)
    r.raise_for_status()
    rows = r.json().get("prices", [])
    if not rows:
        return pd.DataFrame(columns=["date","close"])
    df = pd.DataFrame(rows, columns=["ts_ms","close"])
    df["date"] = pd.to_datetime(df["ts_ms"], unit="ms", utc=True).dt.date
    return df[["date","close"]].groupby("date", as_index=False)["close"].last()

def read_iv_series(symbol: str) -> pd.DataFrame:
    """Collapse intraday JSON into daily last observation for IV + spot (from docs/*/cvi_timeseries.json)."""
    p = DOCS / symbol / "cvi_timeseries.json"
    if not p.exists():
        return pd.DataFrame(columns=["date","spot_last","iv_atm","iv_vega"])
    try:
        js = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        js = []
    if not isinstance(js, list) or not js:
        return pd.DataFrame(columns=["date","spot_last","iv_atm","iv_vega"])
    df = pd.DataFrame(js)
    for col in ["t","spot","atm_iv","vega_weighted_iv"]:
        if col not in df.columns: df[col] = np.nan
    df["date"] = pd.to_datetime(df["t"], utc=True, errors="coerce").dt.date
    agg = (df.sort_values("t")
             .groupby("date", as_index=False)
             .agg(spot_last=("spot","last"),
                  iv_atm=("atm_iv","last"),
                  iv_vega=("vega_weighted_iv","last")))
    return agg

def rsi(series: pd.Series, n: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    roll_up  = gain.ewm(alpha=1/n, adjust=False).mean()
    roll_down= loss.ewm(alpha=1/n, adjust=False).mean()
    rs = roll_up / (roll_down.replace(0, np.nan))
    return 100 - (100 / (1 + rs))

def build_features(df_price: pd.DataFrame, df_iv: pd.DataFrame) -> pd.DataFrame:
    df = pd.merge(df_price, df_iv, on="date", how="left").sort_values("date").reset_index(drop=True)

    # returns / realized vols
    df["ret"]  = np.log(df["close"] / df["close"].shift(1))
    df["rv7"]  = df["ret"].rolling(7).std()  * np.sqrt(365)
    df["rv30"] = df["ret"].rolling(30).std() * np.sqrt(365)

    # momentum / RSI
    df["mom7"]  = df["close"] / df["close"].shift(7)  - 1.0
    df["mom30"] = df["close"] / df["close"].shift(30) - 1.0
    df["rsi14"] = rsi(df["close"], 14)

    # IV features — NOTE: columns here are iv_vega / iv_atm after the merge
    iv_pref = df["iv_vega"].fillna(df["iv_atm"])
    df["iv"] = iv_pref.fillna(df["rv30"])        # fallback to realized
    df["iv_minus_rv30"] = df["iv"] - df["rv30"]

    # target: next-day simple return
    df["target_next_ret"] = df["close"].pct_change().shift(-1)

    cols = ["date","close","spot_last","iv","rv7","rv30","mom7","mom30","rsi14","iv_minus_rv30","target_next_ret"]
    return df[cols]   # keep last row even if target is NaN (trainer handles it)

def main():
    for sym in SYMBOLS:
        print(f"[{sym}] building daily dataset... (primary=Binance klines)")
        # --- daily closes ---
        try:
            price = binance_klines_daily(BINANCE_SYMBOLS[sym], lookback_days=365)
        except Exception as e:
            print(f"[{sym}] Binance error: {e}. Falling back to CoinGecko.")
            price = coingecko_market_chart_daily(COINGECKO_IDS[sym], PLAN)
        print(f"[{sym}] loaded {len(price)} daily price rows.")

        # --- IV (from our intraday JSON) ---
        iv = read_iv_series(sym)
        print(f"[{sym}] merged with {len(iv)} IV rows from docs/{sym}/cvi_timeseries.json")

        # --- features ---
        feat = build_features(price, iv)

        # write CSV (all rows, last row may have NaN target)
        out_csv = DATA / f"{sym}_features.csv"
        feat.to_csv(out_csv, index=False)
        print(f"[{sym}] wrote features -> {out_csv}  (rows={len(feat)})")

if __name__ == "__main__":
    main()
