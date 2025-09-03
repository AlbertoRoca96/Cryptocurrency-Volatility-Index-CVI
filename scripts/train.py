import json, pathlib
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from sklearn.ensemble import HistGradientBoostingRegressor, HistGradientBoostingClassifier

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
DATA = ROOT / "data"

SYMBOLS = ["BTC", "ETH", "LINK"]

FEATURE_COLS = ["iv","rv7","rv30","mom7","mom30","rsi14","iv_minus_rv30"]

def load_features(sym: str) -> pd.DataFrame:
    p = DATA / f"{sym}_features.csv"
    if not p.exists():
        return pd.DataFrame(columns=["date", *FEATURE_COLS, "target_next_ret"])
    df = pd.read_csv(p)
    # types
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"])
    for c in FEATURE_COLS + ["target_next_ret"]:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df

def train_and_predict(df: pd.DataFrame):
    """Return (ret_pred, prob_up, model_name, last_feats)"""
    if df.empty:
        return 0.0, 0.5, "naive-empty", {}

    # last row features (forward-fill so it's usable)
    X_full = df[FEATURE_COLS].copy()
    X_full = X_full.fillna(method="ffill").fillna(method="bfill")
    x_last = X_full.iloc[-1].values.reshape(1, -1)

    # training set (drop rows where y is NaN)
    if "target_next_ret" not in df or df["target_next_ret"].dropna().empty or len(df) < 50:
        # Not enough data to train anything meaningful
        return 0.0, 0.5, "naive", dict(zip(FEATURE_COLS, X_full.iloc[-1].tolist()))

    y = pd.to_numeric(df["target_next_ret"], errors="coerce")
    train_mask = y.notna()
    X = X_full[train_mask]
    y = y[train_mask]

    if len(y) < 50:
        return 0.0, 0.5, "naive-small", dict(zip(FEATURE_COLS, X_full.iloc[-1].tolist()))

    # Regressor for next-day return
    regr = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=300, random_state=0)
    regr.fit(X, y)
    ret_pred = float(regr.predict(x_last)[0])

    # Classifier for probability of up day
    y_cls = (y > 0).astype(int)
    clf = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=300, random_state=0)
    clf.fit(X, y_cls)
    prob_up = float(clf.predict_proba(x_last)[0][1])

    return ret_pred, prob_up, "histgb", dict(zip(FEATURE_COLS, X_full.iloc[-1].tolist()))

def write_predictions(sym: str, ret_pred: float, prob_up: float, model: str, last_feats: dict, last_date: pd.Timestamp):
    asset_dir = DOCS / sym
    asset_dir.mkdir(parents=True, exist_ok=True)
    out = {
        "symbol": sym,
        "ts": pd.to_datetime(last_date).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "next_day_return_pred": ret_pred,
        "prob_up": prob_up,
        "model": model,
        "features_snapshot": last_feats
    }
    (asset_dir / "predictions.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    return out

def main():
    aggregate = []
    for sym in SYMBOLS:
        df = load_features(sym)
        if df.empty:
            # still write a neutral file
            ret_pred, prob_up, model, last_feats = 0.0, 0.5, "naive-empty", {}
            last_date = datetime.now(timezone.utc)
        else:
            last_date = df["date"].iloc[-1]
            ret_pred, prob_up, model, last_feats = train_and_predict(df)

        agg = write_predictions(sym, ret_pred, prob_up, model, last_feats, last_date)
        aggregate.append(agg)

    # also write a top-level aggregator for the UI
    (DOCS / "predictions.json").write_text(json.dumps(aggregate, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
