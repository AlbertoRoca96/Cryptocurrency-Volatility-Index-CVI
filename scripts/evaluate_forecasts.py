import json, pathlib
import numpy as np
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
DOCS = ROOT / 'docs'

SYMBOLS = ["BTC","ETH","LINK"]

# Load features to get realized next-day returns

def load_features(sym: str):
  p = DATA / f"{sym}_features.csv"
  if not p.exists():
    return None
  try:
    df = pd.read_csv(p)
    if 'date' not in df.columns:
      return None
    # realized next-day return is the target we trained on
    return df[['date','target_next_ret']].copy()
  except Exception:
    return None


def load_forecast_log(sym: str):
  p = DOCS / sym / 'forecast_log.json'
  if not p.exists():
    return []
  try:
    return json.loads(p.read_text())
  except Exception:
    return []


def evaluate_sym(sym: str):
  feats = load_features(sym)
  logs  = load_forecast_log(sym)
  if feats is None or len(logs)==0:
    return { 'symbol': sym, 'status': 'no_data' }

  # index realized returns by date (as string YYYY-MM-DD)
  feats['date'] = pd.to_datetime(feats['date']).dt.strftime('%Y-%m-%d')
  realized = { r['date']: float(r['target_next_ret']) if pd.notna(r['target_next_ret']) else None for r in feats.to_dict('records') }

  rows = []
  for f in logs:
    d = f.get('for_date')
    if not d or d not in realized:
      continue
    y = realized[d]
    if y is None:
      continue
    yhat = float(f.get('predicted_return') or f.get('next_day_return_pred') or 0.0)
    pup = f.get('prob_up', None)
    rows.append({ 'date': d, 'y': y, 'yhat': yhat, 'prob_up': float(pup) if pup is not None else None })

  if not rows:
    return { 'symbol': sym, 'status': 'no_overlap' }

  df = pd.DataFrame(rows).sort_values('date')
  err = df['yhat'] - df['y']
  mae = float(np.mean(np.abs(err)))
  rmse = float(np.sqrt(np.mean(err*err)))
  bias = float(np.mean(err))
  hit = float(np.mean(np.sign(df['yhat']) == np.sign(df['y'])))

  brier = None
  if df['prob_up'].notna().any():
    # convert y to class label: 1 if next-day return > 0
    y_cls = (df['y'] > 0).astype(int)
    p = df['prob_up'].fillna(0.5)
    brier = float(np.mean((p - y_cls)**2))

  out = {
    'symbol': sym,
    'n': int(len(df)),
    'mae': mae,
    'rmse': rmse,
    'bias': bias,
    'hit_rate': hit,
    'brier': brier,
    'last_eval_date': df['date'].iloc[-1]
  }

  # write per-asset metrics
  (DOCS / sym).mkdir(parents=True, exist_ok=True)
  (DOCS / sym / 'forecast_metrics.json').write_text(json.dumps(out, indent=2))
  return out


def main():
  metrics = []
  for sym in SYMBOLS:
    m = evaluate_sym(sym)
    metrics.append(m)

  (DOCS / 'forecast_metrics.json').write_text(json.dumps(metrics, indent=2))
  print('Wrote evaluation metrics for', len(metrics), 'asset(s).')

if __name__ == '__main__':
  main()
