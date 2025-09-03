# scripts/train.py
import json, pathlib, math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from sklearn.model_selection import TimeSeriesSplit
from sklearn.ensemble import HistGradientBoostingRegressor, HistGradientBoostingClassifier

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
DATA = ROOT / "data"
DOCS.mkdir(exist_ok=True)

SYMBOLS = ["BTC", "ETH", "LINK"]

FEATURES = ["iv","rv7","rv30","mom7","mom30","rsi14","iv_minus_rv30"]
TARGET = "target_next_ret"

def load_dataset(sym: str):
    p = DATA / f"{sym}_features.csv"
    if not p.exists():
        return None
    df = pd.read_csv(p)
    # Ensure expected columns exist
    for c in ["date","close","spot_last", *FEATURES, TARGET]:
        if c not in df.columns:
            df[c] = np.nan
    return df

def train_models(df: pd.DataFrame):
    # training rows (we drop rows where target is NaN)
    train = df.dropna(subset=[TARGET]).copy()
    if len(train) < 120:  # need at least ~4 months
        return None

    X = train[FEATURES].astype(float).fillna(0.0)
    y_reg = train[TARGET].astype(float)
    y_cls = (y_reg > 0).astype(int)

    # simple, robust models
    reg = HistGradientBoostingRegressor(max_depth=3, max_iter=150, learning_rate=0.05)
    cls = HistGradientBoostingClassifier(max_depth=3, max_iter=150, learning_rate=0.05)

    reg.fit(X, y_reg)
    cls.fit(X, y_cls)

    return {"reg": reg, "cls": cls}

def predict_next(df: pd.DataFrame, models):
    # Use the last row (target is usually NaN) as “today’s” features
    x_pred = df.iloc[[-1]][FEATURES].astype(float).fillna(0.0)
    if models is None:
        # Baseline: no model — return neutral prediction
        return {"pred_next_ret": 0.0, "prob_up": 0.5, "mode": "baseline"}
    y_hat = float(models["reg"].predict(x_pred)[0])
    proba = float(models["cls"].predict_proba(x_pred)[0,1])
    return {"pred_next_ret": y_hat, "prob_up": proba, "mode": "model"}

def main():
    out = {"generated_at": datetime.now(timezone.utc).isoformat(), "assets": []}

    for sym in SYMBOLS:
        df = load_dataset(sym)
        if df is None or len(df) == 0:
            out["assets"].append({"symbol": sym, "status": "no_data"})
            continue

        models = train_models(df)
        pred = predict_next(df, models)
        out["assets"].append({
            "symbol": sym,
            "n_rows_total": int(len(df)),
            "n_rows_train": int(len(df.dropna(subset=[TARGET]))),
            **pred
        })

    # Always write the file so the UI never 404s
    (DOCS / "predictions.json").write_text(json.dumps(out, indent=2))
    print("Wrote docs/predictions.json")

if __name__ == "__main__":
    main()
