const fs = require('fs');
const path = require('path');

function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p,{recursive:true}); }
function readJSON(p, fallback){ try{ return JSON.parse(fs.readFileSync(p,'utf8')); }catch{ return fallback; } }

// Write atomically to avoid partial JSON on interruption
function writeJSONAtomic(filePath, data){
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

module.exports = { ensureDir, readJSON, writeJSONAtomic };
