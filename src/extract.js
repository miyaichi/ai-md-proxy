import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import dns from 'node:dns/promises';
import net from 'node:net';
import { removeAds } from './adfilter.js';
import { paginationInfo, dropRepeatedHead, removePaywallNotices } from './paginate.js';
import { findContentRoot, removeBoilerplate, contentParagraphs, textLen, cleanTitle } from './scope.js';

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const TIMEOUT_MS = 15000;
const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 ai-md-proxy/0.1';

// ---- SSRF 対策：プライベート/ループバック宛は拒否 ----
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
    v.startsWith('::ffff:') && isPrivateIp(v.slice(7));
}

async function assertPublicUrl(u) {
  const url = new URL(u);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('http/https のURLのみ対応です');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateIp)) throw new Error('プライベートアドレス宛のURLは取得できません');
  return url;
}

// 文字コード判定（Content-Type → <meta charset> → UTF-8）
function decode(buf, contentType) {
  let charset = /charset=([^;]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  charset = (charset || 'utf-8').trim().toLowerCase();
  if (['shift_jis', 'sjis', 'x-sjis', 'windows-31j', 'ms932'].includes(charset)) charset = 'shift_jis';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export async function fetchHtml(u) {
  const url = await assertPublicUrl(u);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': FETCH_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ja,en;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`取得失敗: HTTP ${res.status}`), { status: res.status });
    const ct = res.headers.get('content-type') || '';
    if (!/html|xml/.test(ct)) throw new Error(`HTMLではありません: ${ct}`);
    // リダイレクト先も再チェック
    await assertPublicUrl(res.url);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error('ページが大きすぎます (>5MB)');
      chunks.push(value);
    }
    return { html: decode(Buffer.concat(chunks), ct), finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

function makeTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  td.use(gfm);
  // 1px画像・トラッキングピクセル・alt無しの装飾画像は落とす
  td.addRule('dropTinyImages', {
    filter: (node) =>
      node.nodeName === 'IMG' &&
      (/^(1|0)$/.test(node.getAttribute('width') || '') ||
        /^(1|0)$/.test(node.getAttribute('height') || '') ||
        !(node.getAttribute('src') || '').startsWith('http')),
    replacement: () => '',
  });
  td.remove(['button', 'form', 'input', 'select', 'textarea', 'svg', 'canvas']);
  return td;
}

function frontMatter(meta) {
  const esc = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: "${esc(v)}"`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

/**
 * 1ページ分の HTML から本文とメタデータを取り出す
 */
export function extractPage(html, url) {
  const virtualConsole = new VirtualConsole(); // CSSパースエラー等のノイズを抑止
  const dom = new JSDOM(html, { url, virtualConsole }); // スクリプトは実行しない
  const doc = dom.window.document;

  // canonical / meta / ページ送りは除去前に拾っておく
  const meta = (sel) => doc.querySelector(sel)?.getAttribute('content') || undefined;
  const canonical = pickCanonical(doc, url);
  const pageInfo = paginationInfo(doc, url);
  const timeEl = doc.querySelector('article time, time[datetime]');
  const published =
    meta('meta[property="article:published_time"]') || meta('meta[name="pubdate"]') ||
    timeEl?.getAttribute('datetime') || timeEl?.textContent.replace(/[\[\]\s]/g, '') || undefined;
  const lang = doc.documentElement.getAttribute('lang') || undefined;
  const ogTitle = meta('meta[property="og:title"]');
  const ogSite = meta('meta[property="og:site_name"]');
  const description = meta('meta[name="description"]');

  const adStats = removeAds(doc);
  removePaywallNotices(doc);

  // 1) 本文の範囲を特定し、その範囲だけで処理する
  let contentHtml;
  let article;
  let mode = 'readability';
  const root = findContentRoot(doc);
  if (root) {
    const scoped = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url, virtualConsole }).window.document;
    scoped.head.innerHTML = doc.head.innerHTML;
    scoped.body.appendChild(scoped.importNode(root, true));
    removeBoilerplate(scoped.body);
    const expected = contentParagraphs(scoped.body).reduce((s, p) => s + textLen(p), 0) || textLen(scoped.body) * 0.5;
    const direct = scoped.body.innerHTML;
    article = new Readability(scoped, { charThreshold: 100, keepClasses: false }).parse();
    const got = article ? textLen(new JSDOM(article.content).window.document.body) : 0;
    // Readability が本文の大半を残せていればその結果、落としていれば範囲をそのまま使う
    if (article && got >= expected * 0.7) { contentHtml = article.content; mode = 'scoped+readability'; }
    else { contentHtml = direct; mode = 'scoped'; }
  }
  // 2) 範囲が特定できなければ従来どおりページ全体を Readability に渡す
  if (!contentHtml) {
    article = new Readability(doc, { charThreshold: 200, keepClasses: false }).parse();
    if (!article || !article.content) throw new Error('本文を抽出できませんでした');
    contentHtml = article.content;
  }

  const site = article?.siteName || ogSite;
  const title = cleanTitle(ogTitle || article?.title || doc.title, site);

  let body = makeTurndown().turndown(contentHtml);
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  // 本文先頭の見出しがタイトルと同じなら重複させない
  const norm = (s) => s.replace(/[\s　]/g, '');
  body = body.replace(/^#{1,3} (.+)\n+/, (m, h) => (title && norm(h) === norm(title) ? '' : m));

  return {
    url, canonical, pageInfo, title, site, byline: article?.byline, published, lang,
    excerpt: article?.excerpt || description, body, adStats, mode,
  };
}

/**
 * 1ページ以上の抽出結果を1つの Markdown にまとめる
 */
function compose(pages, opts = {}, { truncated = false } = {}) {
  const first = pages[0];
  let body = first.body;
  for (const p of pages.slice(1)) {
    const rest = dropRepeatedHead(p.body, first.body, first.title);
    if (rest) body += `\n\n<!-- page:${p.pageInfo.n} -->\n\n${rest}`;
  }
  if (opts.adSlots > 0) body = insertAdSlotMarkers(body, opts.adSlots);

  const removed = pages.reduce((s, p) => s + p.adStats.total, 0);
  // 複数ページを結合したときは記事全体を表すので、正規URLは1ページ目（ページ指定なし）
  const canonical = pages.length > 1 ? (first.pageInfo.n === 1 ? first.canonical : first.pageInfo.key) : first.canonical;
  const fm = frontMatter({
    title: first.title,
    source: canonical,
    site: first.site,
    byline: first.byline,
    published: first.published,
    lang: first.lang,
    excerpt: first.excerpt,
    pages: pages.length > 1 ? pages.length : undefined,
    truncated: truncated ? 'true' : undefined,
    fetched_at: new Date().toISOString(),
    removed_ad_elements: removed,
  });
  const heading = first.title ? `# ${first.title}\n\n` : '';
  const note = truncated ? '\n\n> この記事の続きは元のページ（会員限定・有料部分を含む）でお読みください。\n' : '';
  return {
    markdown: fm + heading + body + note + '\n',
    meta: {
      title: first.title, canonical, mode: first.mode, pages: pages.length, truncated,
      adStats: { total: removed }, length: body.length,
    },
  };
}

/**
 * HTML → 広告除去 → 本文抽出 → Markdown（1ページのみ。CLI の --file 用）
 * @param {{ adSlots?: number }} opts adSlots>0 なら N段落ごとに広告挿入用マーカーを入れる
 */
export function htmlToMarkdown(html, url, opts = {}) {
  const p = extractPage(html, url);
  return compose([p], opts, { truncated: p.pageInfo.paywalled });
}

// 正規URLの決定: <link rel=canonical> → og:url → 取得URL
// http(s) の絶対URLだけを採用し、URL オブジェクトで正規化（ヘッダーに載せても安全な形にする）
function pickCanonical(doc, fallback) {
  const cands = [
    doc.querySelector('link[rel~="canonical"]')?.getAttribute('href'),
    doc.querySelector('meta[property="og:url"]')?.getAttribute('content'),
  ];
  for (const c of cands) {
    if (!c) continue;
    try {
      const u = new URL(c.trim(), fallback);
      if (u.protocol === 'http:' || u.protocol === 'https:') { u.hash = ''; return u.href; }
    } catch { /* 不正なURLは無視 */ }
  }
  return fallback;
}

// 将来の「Markdown広告挿入」用：段落の区切りにマーカーを挿入
// 例: <!-- ad-slot:1 --> を後段で実際の広告Markdownに置換する
function insertAdSlotMarkers(md, every) {
  const blocks = md.split(/\n\n/);
  const out = [];
  let paras = 0;
  let slot = 0;
  for (const b of blocks) {
    out.push(b);
    const isPara = b && !/^(#|\||-|\*|>|<|```|!\[|\d+\.)/.test(b.trim());
    if (isPara && ++paras % every === 0) out.push(`<!-- ad-slot:${++slot} -->`);
  }
  return out.join('\n\n');
}

const MAX_PAGES = 20;
const DEADLINE_MS = 40000; // Cloud Run のタイムアウト(60秒)より十分短く

/**
 * URL → Markdown。複数ページの記事は全ページを結合して返す
 * どのページのURLで呼ばれても、1ページ目から結合した同じ結果になる
 * @param {{ adSlots?: number, fetcher?: (url:string)=>Promise<{html:string, finalUrl:string}> }} opts
 */
export async function urlToMarkdown(u, opts = {}) {
  const fetcher = opts.fetcher || fetchHtml;
  const started = Date.now();
  let r = await fetcher(u);
  let first = extractPage(r.html, r.finalUrl);

  // 2ページ目以降のURLで呼ばれたら1ページ目から取り直す
  if (first.pageInfo.n > 1) {
    r = await fetcher(first.pageInfo.pages.get(1));
    first = extractPage(r.html, r.finalUrl);
  }

  const pages = [first];
  let truncated = first.pageInfo.paywalled;
  const seen = new Set([first.pageInfo.n]);

  // 有料・会員限定のエラー（401/402/403）は「続きあり」として扱い、それ以外のエラーはそこで終了
  const stopOn = (e) => { if ([401, 402, 403].includes(e?.status)) truncated = true; };
  const add = (res) => {
    const p = extractPage(res.html, res.finalUrl);
    if (p.pageInfo.key !== first.pageInfo.key || seen.has(p.pageInfo.n)) return false; // 別記事へのリダイレクト等
    seen.add(p.pageInfo.n);
    pages.push(p);
    if (p.pageInfo.paywalled) { truncated = true; return false; }
    return true;
  };

  // (a) 1ページ目に載っているページ番号は並列に取得
  if (!truncated) {
    const known = [...first.pageInfo.pages.entries()]
      .filter(([n]) => n > 1).sort((a, b) => a[0] - b[0]).slice(0, MAX_PAGES - 1);
    const results = await Promise.allSettled(known.map(([, url]) => fetcher(url)));
    for (const res of results) {
      if (res.status === 'rejected') { stopOn(res.reason); break; }
      if (!add(res.value)) break;
    }
  }
  // (b) ページ送りが途中までしか表示されない場合に備え、最後のページの「次へ」をたどる
  while (!truncated && pages.length < MAX_PAGES && Date.now() - started < DEADLINE_MS) {
    const next = pages[pages.length - 1].pageInfo.next;
    if (!next) break;
    let res;
    try { res = await fetcher(next); } catch (e) { stopOn(e); break; }
    if (!add(res)) break;
  }

  return compose(pages, opts, { truncated });
}
