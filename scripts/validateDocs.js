// Quick validator: ensure required docs/* JSON files exist and are valid JSON
const fs = require('fs');
const path = require('path');

const REQUIRED_ROOT = ['cvi_manifest.json'];
const PER_ASSET_FILES = ['cvi_timeseries.json','cvi.json','signals.json','risk.json','smile_meta.json','orders.json'];

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch (e) { throw new Error(`${p}: ${e.message}`); }
}

(function main(){
  const docsDir = path.join(process.cwd(),'docs');
  if (!fs.existsSync(docsDir)) { console.error('docs/ missing'); process.exit(1); }

  // Root
  for (const f of REQUIRED_ROOT) {
    const p = path.join(docsDir, f);
    if (!fs.existsSync(p)) { console.error('Missing:', f); process.exit(1); }
    try { readJSON(p); } catch (e) { console.error('Invalid JSON:', e.message); process.exit(1); }
  }

  const manifest = readJSON(path.join(docsDir,'cvi_manifest.json'));
  const assets = (manifest.assets || []).map(a=>a.symbol);
  if (!assets.length) { console.warn('No assets in manifest.'); process.exit(0); }

  // Per-asset
  let bad = 0;
  for (const sym of assets) {
    const dir = path.join(docsDir, sym);
    for (const f of PER_ASSET_FILES) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) { console.warn(`[${sym}] missing ${f}`); bad++; continue; }
      try { readJSON(p); } catch (e) { console.warn(`[${sym}] invalid ${f}: ${e.message}`); bad++; }
    }
  }

  if (bad>0) {
    console.warn('Validation finished with issues:', bad);
    process.exit(2);
  } else {
    console.log('docs/ validation OK');
  }
})();
