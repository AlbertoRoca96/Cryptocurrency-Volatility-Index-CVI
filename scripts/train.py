# scripts/train.py
import json, pathlib, math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from sklearn.model_selection import TimeSeriesSplit
from sklearn.ensemble import HistGradientBoostingRegressor, HistGradientBoostingClassifier
from sklearn.metrics import mean_squared_error, roc_auc_score

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DOCS = ROOT / "docs"

SYMBOLS = ["BTC","ETH","LINK"]

FEATURES = ["iv","rv7","rv30","iv_minus_rv30","mom7","mom30","rsi14"]
TARGET = "target_next_ret"

def safe_auc(y_true, y_score):
    try:
        # need both classes present
        if len(np.unique(y_true)) < 2:
            return None
        return float(roc_auc_score(y_true, y_score))
    except Exception:
        return None

def train_and_forecast(sym: str):
    df = pd.read_csv(DATA / f"{sym}_features.csv")
    if len(df) < 200:
        print(f"[{sym}] not enough rows to train ({len(df)})")
        return None

    X = df[FEATURES].values
    y = df[TARGET].values
    y_cls = (y > 0).astype(int)

    tscv = TimeSeriesSplit(n_splits=5)
    rmse_list = []
    auc_list = []

    for train_idx, test_idx in tscv.split(X):
        Xtr, Xte = X[train_idx], X[test_idx]
        ytr, yte = y[train_idx], y[test_idx]
        ytrc, ytec = y_cls[train_idx], y_cls[test_idx]

        r = HistGradientBoostingRegressor(
            max_depth=None, learning_rate=0.05, max_iter=500, random_state=42
        ).fit(Xtr, ytr)
        yhat = r.predict(Xte)
        rmse_list.append(math.sqrt(mean_squared_error(yte, yhat)))

        c = HistGradientBoostingClassifier(
            max_depth=None, learning_rate=0.05, max_iter=500, random_state=42
        ).fit(Xtr, ytrc)
        phat = c.predict_proba(Xte)[:,1]
        auc_list.append(safe_auc(ytec, phat))

    # fit on all but last row (avoid peeking)
    last_idx = len(df)-1
    r_final = HistGradientBoostingRegressor(
        max_depth=None, learning_rate=0.05, max_iter=500, random_state=42
    ).fit(X[:last_idx], y[:last_idx])
    c_final = HistGradientBoostingClassifier(
        max_depth=None, learning_rate=0.05, max_iter=500, random_state=42
    ).fit(X[:last_idx], y_cls[:last_idx])

    # predict next day using the LAST row's features
    x_last = X[last_idx:last_idx+1]
    pred_ret = float(r_final.predict(x_last)[0])
    prob_up = float(c_final.predict_proba(x_last)[0,1])

    out = {
        "t": datetime.now(timezone.utc).isoformat(),
        "symbol": sym,
        "horizon": "1d",
        "prediction": {
            "next_day_return": pred_ret,   # e.g. 0.012 = +1.2%
            "prob_up": prob_up
        },
        "cv": {
            "rmse_mean": float(np.nanmean(rmse_list)) if rmse_list else None,
            "rmse_std": float(np.nanstd(rmse_list)) if rmse_list else None,
            "auc_mean": float(np.nanmean([a for a in auc_list if a is not None])) if any(a is not None for a in auc_list) else None
        },
        "features_used": FEATURES
    }

    # write to docs/<SYMBOL>/predictions.json
    out_dir = DOCS / sym
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "predictions.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"[{sym}] wrote forecast -> {out_dir / 'predictions.json'}")
    return out

def main():
    for sym in SYMBOLS:
        try:
            train_and_forecast(sym)
        except Exception as e:
            print(f"[{sym}] train error: {e}")

if __name__ == "__main__":
    main()
