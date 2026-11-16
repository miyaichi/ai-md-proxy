import http from 'node:http';
import { urlToMarkdown } from './extract.js';
import { loadKeys, identify, makeRateLimiter } from './auth.js';

const PORT = Number(process.env.PORT || 8787);
const cache = new Map(); // 簡易キャッシュ（URL → {at, body}）
const TTL_MS = 10 * 60 * 1000;

const keys = loadKeys();
const onCloudRun = !!process.env.K_SERVICE;
// ローカル実行で API_KEYS 未設定なら認証なし。Cloud Run 上でキー未設定なら全拒否（誤公開防止）
const authRequired = keys.size > 0 || onCloudRun;
const allow = makeRateLimiter(Number(process.env.RATE_LIMIT_PER_MIN || 60));

const send = (res, status, body, headers = {}) =>
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }).end(body);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (u.pathname === '/health') return send(res, 200, 'ok');

  // GET /md?url=https://example.com/article[&slots=3]
  if (u.pathname === '/md' && req.method === 'GET') {
    // 認証: x-api-key ヘッダー（推奨）または ?key=
    let client = 'local';
    if (authRequired) {
      client = identify(keys, req.headers['x-api-key'] || u.searchParams.get('key'));
      if (!client) return send(res, 401, 'APIキーが無効です（x-api-key ヘッダーか ?key= で指定してください）');
      if (!allow(client)) return send(res, 429, 'リクエストが多すぎます。しばらく待ってから再試行してください', { 'retry-after': '60' });
    }

    const target = u.searchParams.get('url');
    const slots = Number(u.searchParams.get('slots') || 0);
    if (!target) return send(res, 400, 'url パラメータが必要です');

    const t0 = Date.now();
    const log = (status, extra = {}) =>
      console.log(JSON.stringify({ severity: status >= 500 ? 'WARNING' : 'INFO', client, target, status, ms: Date.now() - t0, ...extra }));

    const key = `${target}|${slots}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      log(200, { cache: 'HIT' });
      return send(res, 200, hit.body, { 'content-type': 'text/markdown; charset=utf-8', 'x-cache': 'HIT' });
    }
    try {
      const { markdown, meta } = await urlToMarkdown(target, { adSlots: slots });
      cache.set(key, { at: Date.now(), body: markdown });
      log(200, { cache: 'MISS', removedAds: meta.adStats.total });
      return send(res, 200, markdown, {
        'content-type': 'text/markdown; charset=utf-8',
        'x-cache': 'MISS',
        'x-removed-ads': String(meta.adStats.total),
        'x-elapsed-ms': String(Date.now() - t0),
      });
    } catch (e) {
      log(502, { error: e.message });
      return send(res, 502, `エラー: ${e.message}`);
    }
  }

  send(res, 404, '使い方: GET /md?url=<記事URL>[&slots=<N段落ごとの広告枠>]  (ヘッダー x-api-key: <キー>)');
});

server.listen(PORT, () =>
  console.log(`ai-md-proxy listening on :${PORT} (auth: ${authRequired ? `${keys.size} keys` : 'off'})`));

// Cloud Run はインスタンス停止時に SIGTERM を送る
process.on('SIGTERM', () => server.close(() => process.exit(0)));
