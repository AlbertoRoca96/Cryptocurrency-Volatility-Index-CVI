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

SYMBOLS = ["BTC", "ETH", "LINK"]
FEATURES = ["iv", "rv7", "rv30", "mom7", "mom30", "rsi14", "iv_minus_rv30"]

MIN_TRAIN_ROWS = 120
MAX_SPLITS = 5
SEED = 42

def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def safe_auc(y_true, y_prob):
    try:
        if len(np.unique(y_true)) < 2:
            return None
        return float(roc_auc_score(y_true, y_prob))
    except Exception:
        return None

def ensure_cols(df: pd.DataFrame, cols):
    for c in cols:
        if c not in df.columns:
            df[c] = np.nan
    return df

def train_and_forecast(df: pd.DataFrame):
    # split into training rows (known target) and live row
    train = df.dropna(subset=["target_next_ret"]).copy()
    live  = df.tail(1).copy()

    if len(train) < MIN_TRAIN_ROWS or live.empty:
        return None, {"status": "insufficient_data", "sample_size": int(len(train)), "needed": MIN_TRAIN_ROWS}

    # Fill feature NAs with ffill/bfill to avoid dropping rows
    X_full = df[FEATURES].ffill().bfill().astype(float)
    y_full = df["target_next_ret"].astype(float)

    X_train = X_full.iloc[:-1, :]
    y_train = y_full.iloc[:-1]
    X_live  = X_full.iloc[[-1], :]

    # models
    reg = HistGradientBoostingRegressor(
        learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=20, random_state=SEED
    )
    cls = HistGradientBoostingClassifier(
        learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=20, random_state=SEED
    )

    # time-series CV for quick diagnostics
    n_splits = min(MAX_SPLITS, max(2, len(train)//50))
    reg_rmse = None
    auc = None
    if n_splits >= 2:
        tscv = TimeSeriesSplit(n_splits=n_splits)
        preds, truth = [], []
        probs, truth_c = [], []
        for tr, te in tscv.split(X_train):
            Xtr, Xte = X_train.iloc[tr, :], X_train.iloc[te, :]
            ytr, yte = y_train.iloc[tr], y_train.iloc[te]

            reg.fit(Xtr, ytr)
            yp = reg.predict(Xte)
            preds.append(yp)
            truth.append(yte.values)

            cls.fit(Xtr, (ytr > 0).astype(int))
            p = cls.predict_proba(Xte)[:, 1]
            probs.append(p)
            truth_c.append((yte > 0).astype(int).values)

        preds = np.concatenate(preds) if preds else np.array([])
        truth = np.concatenate(truth) if truth else np.array([])
        if preds.size and truth.size:
            reg_rmse = float(math.sqrt(mean_squared_error(truth, preds)))
        if probs and truth_c:
            auc = safe_auc(np.concatenate(truth_c), np.concatenate(probs))

    # fit on all training rows and forecast the last row
    reg.fit(X_train, y_train)
    cls.fit(X_train, (y_train > 0).astype(int))
    y_live = float(reg.predict(X_live)[0])
    p_up   = float(cls.predict_proba(X_live)[0, 1])

    return {
        "ts": now_iso(),
        "horizon_days": 1,
        "features": FEATURES,
        "sample_size": int(len(train)),
        "predicted_return": y_live,          # UI key
        "next_day_return_pred": y_live,      # compatibility key
        "prob_up": p_up,
        "rmse": reg_rmse,
        "auc": auc,
        "model": "histgb"
    }, None

def main():
    agg = []
    for sym in SYMBOLS:
        csv_path = DATA / f"{sym}_features.csv"
        out_sym  = DOCS / sym / "predictions.json"
        out_sym.parent.mkdir(parents=True, exist_ok=True)

        if not csv_path.exists():
            out = {"symbol": sym, "ts": now_iso(), "status": "no_features_csv"}
            out_sym.write_text(json.dumps(out, indent=2))
            print(f"[{sym}] no features CSV; wrote status=no_features_csv")
            continue

        df = pd.read_csv(csv_path)
        df = ensure_cols(df, FEATURES + ["target_next_ret"])

        forecast, meta = train_and_forecast(df)
        if forecast:
            out = {"symbol": sym, **forecast}
            print(f"[{sym}] forecast: ret≈{forecast['predicted_return']:.5f}, prob_up≈{forecast['prob_up']:.3f}, "
                  f"rmse={forecast['rmse']}, auc={forecast['auc']}, n={forecast['sample_size']}")
        else:
            out = {"symbol": sym, "ts": now_iso(), **meta}
            print(f"[{sym}] skipped: {meta}")

        out_sym.write_text(json.dumps(out, indent=2))
        agg.append(out)

    # also write aggregator for the homepage/network tab you showed
    (DOCS / "predictions.json").write_text(json.dumps(agg, indent=2))

if __name__ == "__main__":
    main()
