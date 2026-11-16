import http from 'node:http';
import { urlToMarkdown } from './extract.js';

const PORT = Number(process.env.PORT || 8787);
const cache = new Map(); // 簡易キャッシュ（URL → {at, body}）
const TTL_MS = 10 * 60 * 1000;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (u.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }

  // GET /md?url=https://example.com/article[&slots=3]
  if (u.pathname === '/md' && req.method === 'GET') {
    const target = u.searchParams.get('url');
    const slots = Number(u.searchParams.get('slots') || 0);
    if (!target) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('url パラメータが必要です');
      return;
    }
    const key = `${target}|${slots}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'x-cache': 'HIT' }).end(hit.body);
      return;
    }
    const t0 = Date.now();
    try {
      const { markdown, meta } = await urlToMarkdown(target, { adSlots: slots });
      cache.set(key, { at: Date.now(), body: markdown });
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'x-cache': 'MISS',
        'x-removed-ads': String(meta.adStats.total),
        'x-elapsed-ms': String(Date.now() - t0),
      }).end(markdown);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`エラー: ${e.message}`);
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    .end('使い方: GET /md?url=<記事URL>[&slots=<N段落ごとの広告枠>]');
});

server.listen(PORT, () => console.log(`ai-md-proxy listening on http://localhost:${PORT}`));

// Cloud Run はインスタンス停止時に SIGTERM を送る
process.on('SIGTERM', () => server.close(() => process.exit(0)));
