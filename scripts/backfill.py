# scripts/backfill.py
import os, json, pathlib
from datetime import datetime, timezone
import requests
import pandas as pd
import numpy as np

# ---- Config ----
SYMBOLS = ["BTC", "ETH", "LINK"]
COINGECKO_IDS = {"BTC": "bitcoin", "ETH": "ethereum", "LINK": "chainlink"}

API_KEY = (os.environ.get("COINGECKO_API_KEY") or "").strip()
PLAN    = (os.environ.get("COINGECKO_PLAN") or "demo").lower()  # 'demo' or 'pro'

# Base + headers per plan.
# Demo (free/public) must use api.coingecko.com and can auth by header x-cg-demo-api-key
# or query param x_cg_demo_api_key. Pro uses pro-api.coingecko.com and x-cg-pro-api-key.
# Docs: free plan 365-day historical limit; demo key usage examples. 
# (See workflow note for setting COINGECKO_PLAN.)
if PLAN == "pro":
    CG_BASE = "https://pro-api.coingecko.com/api/v3"
    CG_HEADERS = {"accept": "application/json"}
    if API_KEY:
        CG_HEADERS["x-cg-pro-api-key"] = API_KEY
else:
    CG_BASE = "https://api.coingecko.com/api/v3"
    CG_HEADERS = {"accept": "application/json"}
    if API_KEY:
        CG_HEADERS["x-cg-demo-api-key"] = API_KEY  # header form

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

def request_json(url: str, params: dict) -> dict:
    """
    Demo: try header first; if 401, retry with query param x_cg_demo_api_key.
    Pro: just use header.
    """
    r = requests.get(url, params=params, headers=CG_HEADERS, timeout=30)
    if r.status_code == 401 and PLAN != "pro" and API_KEY:
        alt = dict(params)
        alt["x_cg_demo_api_key"] = API_KEY  # query form endorsed by CoinGecko support guide
        r = requests.get(url, params=alt, timeout=30)
    r.raise_for_status()
    return r.json()

def cg_market_chart_daily(coin_id: str) -> pd.DataFrame:
    """
    Daily closes. On demo (free) plan, only last 365 days are available.
    On pro, you can pull full history with days=max.
    """
    url = f"{CG_BASE}/coins/{coin_id}/market_chart"
    days = "max" if PLAN == "pro" else "365"   # respect free plan cap
    params = {"vs_currency": "usd", "days": days, "interval": "daily"}
    payload = request_json(url, params)
    rows = payload.get("prices", [])
    if not rows:
        return pd.DataFrame(columns=["date", "close"])
    df = pd.DataFrame(rows, columns=["ts_ms", "close"])
    df["date"] = pd.to_datetime(df["ts_ms"], unit="ms", utc=True).dt.date
    out = df.groupby("date", as_index=False)["close"].last()
    return out

def read_iv_series(symbol: str) -> pd.DataFrame:
    """
    Collapse intraday JSON into daily last observation for IV + spot.
    """
    p = DOCS / symbol / "cvi_timeseries.json"
    if not p.exists():
        return pd.DataFrame(columns=["date", "spot_last", "iv_atm", "iv_vega"])
    try:
        js = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        js = []
    if not isinstance(js, list) or not js:
        return pd.DataFrame(columns=["date", "spot_last", "iv_atm", "iv_vega"])
    df = pd.DataFrame(js)
    for col in ["t", "spot", "atm_iv", "vega_weighted_iv"]:
        if col not in df.columns:
            df[col] = np.nan
    df["date"] = pd.to_datetime(df["t"], utc=True, errors="coerce").dt.date
    agg = (
        df.sort_values("t")
          .groupby("date", as_index=False)
          .agg(spot_last=("spot","last"),
               iv_atm=("atm_iv","last"),
               iv_vega=("vega_weighted_iv","last"))
    )
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
    df = pd.merge(df_price, df_iv, on="date", how="left").sort_values("date").reset_index(drop=True)
    df["ret"] = np.log(df["close"] / df["close"].shift(1))
    df["rv7"]  = df["ret"].rolling(7).std()  * np.sqrt(365)
    df["rv30"] = df["ret"].rolling(30).std() * np.sqrt(365)
    df["mom7"]  = df["close"] / df["close"].shift(7)  - 1.0
    df["mom30"] = df["close"] / df["close"].shift(30) - 1.0
    df["rsi14"] = rsi(df["close"], 14)
    df["iv"] = df["iv_vega"].fillna(df["iv_atm"])
    df["iv_minus_rv30"] = df["iv"] - df["rv30"]
    df["target_next_ret"] = df["close"].pct_change().shift(-1)
    cols = ["date","close","spot_last","iv","rv7","rv30","mom7","mom30","rsi14","iv_minus_rv30","target_next_ret"]
    return df[cols].dropna().reset_index(drop=True)

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
