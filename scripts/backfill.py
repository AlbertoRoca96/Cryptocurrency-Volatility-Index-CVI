# scripts/backfill.py
import os, json, math, time, csv
import pathlib
from datetime import datetime, timezone
import requests

import pandas as pd
import numpy as np

# ---- Config ----
SYMBOLS = ["BTC", "ETH", "LINK"]
COINGECKO_IDS = {"BTC":"bitcoin", "ETH":"ethereum", "LINK":"chainlink"}

API_KEY = (os.environ.get("COINGECKO_API_KEY") or "").strip()
PLAN    = (os.environ.get("COINGECKO_PLAN") or "demo").lower()  # 'demo' (default) or 'pro'

# Use the correct base + header per plan (free/demo uses public base + demo header)
# Ref: CoinGecko Public API docs – use api.coingecko.com and x-cg-demo-api-key for demo keys.
# https://docs.coingecko.com/ ... Authentication (Public/Demo)
if PLAN == "pro":
    CG_BASE = "https://pro-api.coingecko.com/api/v3"
    CG_HEADERS = {"accept":"application/json", **({"x-cg-pro-api-key": API_KEY} if API_KEY else {})}
else:
    CG_BASE = "https://api.coingecko.com/api/v3"
    CG_HEADERS = {"accept":"application/json", **({"x-cg-demo-api-key": API_KEY} if API_KEY else {})}

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

def safe_request_json(url: str, params: dict) -> tuple[dict, bool]:
    """
    Make a GET with proper headers. If we get a 401 on the public (demo) plan,
    retry once by putting the key in the query string (x_cg_demo_api_key).
    Returns (payload, used_query_key)
    """
    try:
        r = requests.get(url, params=params, headers=CG_HEADERS, timeout=30)
        if r.status_code == 401 and PLAN != "pro" and API_KEY:
            # fallback: some proxies/CDNs may drop custom headers
            p2 = dict(params)
            p2["x_cg_demo_api_key"] = API_KEY
            r2 = requests.get(url, params=p2, timeout=30)
            r2.raise_for_status()
            return r2.json(), True
        r.raise_for_status()
        return r.json(), False
    except requests.HTTPError:
        # Surface the body to logs to help debugging
        try:
            print("HTTP error response:", getattr(r, "text", "")[:500])
        except Exception:
            pass
        raise

def cg_market_chart_daily(coin_id: str) -> pd.DataFrame:
    """Daily closes for entire history (days=max)."""
    url = f"{CG_BASE}/coins/{coin_id}/market_chart"
    params = {"vs_currency":"usd", "days":"max", "interval":"daily"}
    payload, used_query_key = safe_request_json(url, params)
    rows = payload.get("prices", [])  # [[ms, price], ...]
    if not rows:
        return pd.DataFrame(columns=["date","close"])
    df = pd.DataFrame(rows, columns=["ts_ms","close"])
    df["date"] = pd.to_datetime(df["ts_ms"], unit="ms", utc=True).dt.date
    out = df.groupby("date", as_index=False)["close"].last()
    return out

def read_iv_series(symbol: str) -> pd.DataFrame:
    """Collapse intraday JSON into daily last observation for IV + spot."""
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
    roll_up = gain.ewm(alpha=1/n, adjust=False).mean()
    roll_down = loss.ewm(alpha=1/n, adjust=False).mean()
    rs = roll_up / (roll_down.replace(0, np.nan))
    rsi = 100 - (100 / (1 + rs))
    return rsi

def build_features(df_price: pd.DataFrame, df_iv: pd.DataFrame) -> pd.DataFrame:
    df = pd.merge(df_price, df_iv, on="date", how="left")
    df = df.sort_values("date").reset_index(drop=True)
    df["ret"] = np.log(df["close"] / df["close"].shift(1))
    df["rv7"]  = df["ret"].rolling(7).std()  * np.sqrt(365)
    df["rv30"] = df["ret"].rolling(30).std() * np.sqrt(365)
    df["mom7"]  = df["close"] / df["close"].shift(7)  - 1.0
    df["mom30"] = df["close"] / df["close"].shift(30) - 1.0
    df["rsi14"] = rsi(df["close"], 14)
    df["iv"] = df["iv_vega"].fillna(df["iv_atm"])
    df["iv_minus_rv30"] = df["iv"] - df["rv30"]
    df["target_next_ret"] = df["close"].pct_change().shift(-1)
    keep = ["date","close","spot_last","iv","rv7","rv30","mom7","mom30",
            "rsi14","iv_minus_rv30","target_next_ret"]
    df = df[keep].dropna().reset_index(drop=True)
    return df

def main():
    for sym in SYMBOLS:
        coin_id = COINGECKO_IDS[sym]
        print(f"[{sym}] fetching CoinGecko daily... (plan={PLAN}, base={CG_BASE})")
        price = cg_market_chart_daily(coin_id)
        print(f"[{sym}] loaded {len(price)} daily price rows.")
        iv = read_iv_series(sym)
        print(f"[{sym}] merged with {len(iv)} IV rows from docs/{sym}/cvi_timeseries.json")
        feat = build_features(price, iv)
        out_csv = DATA / f"{sym}_features.csv"
        feat.to_csv(out_csv, index=False)
        print(f"[{sym}] wrote features -> {out_csv}  (rows={len(feat)})")

if __name__ == "__main__":
    main()
