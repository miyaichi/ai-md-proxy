import crypto from 'node:crypto';

// API_KEYS の書式: 1行(またはカンマ区切り)に「名前:キー」。# で始まる行は無視
//   partner-a:amp_xxxxxxxx
//   partner-b:amp_yyyyyyyy
// Cloud Run では Secret Manager の値を環境変数 API_KEYS として受け取る
export function loadKeys(raw = process.env.API_KEYS || '') {
  const map = new Map(); // key -> name
  for (const line of raw.split(/[\n,]/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf(':');
    if (i <= 0) continue;
    map.set(s.slice(i + 1).trim(), s.slice(0, i).trim());
  }
  return map;
}

const hash = (s) => crypto.createHash('sha256').update(s).digest();

// キーを照合して名前を返す（一致しなければ null）。比較はタイミング攻撃対策で定数時間
export function identify(keys, presented) {
  if (!presented) return null;
  const h = hash(presented);
  let found = null;
  for (const [k, name] of keys) {
    if (crypto.timingSafeEqual(hash(k), h)) found = name;
  }
  return found;
}

// キーごとの簡易レート制限（インスタンス内・1分窓）
export function makeRateLimiter(perMin) {
  const hits = new Map();
  return (name) => {
    const now = Date.now();
    const w = hits.get(name);
    if (!w || now - w.start >= 60_000) {
      hits.set(name, { start: now, n: 1 });
      return true;
    }
    return ++w.n <= perMin;
  };
}
