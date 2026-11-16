import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import dns from 'node:dns/promises';
import net from 'node:net';
import { removeAds } from './adfilter.js';

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
    if (!res.ok) throw new Error(`取得失敗: HTTP ${res.status}`);
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
 * HTML → 広告除去 → 本文抽出 → Markdown
 * @param {string} html
 * @param {string} url ベースURL（相対リンクの絶対化に使用）
 * @param {{ adSlots?: number }} opts adSlots>0 なら N段落ごとに広告挿入用マーカーを入れる
 */
export function htmlToMarkdown(html, url, opts = {}) {
  const virtualConsole = new VirtualConsole(); // CSSパースエラー等のノイズを抑止
  const dom = new JSDOM(html, { url, virtualConsole }); // スクリプトは実行しない
  const doc = dom.window.document;

  // canonical / meta は除去前に拾っておく
  const meta = (sel) => doc.querySelector(sel)?.getAttribute('content') || undefined;
  const canonical = doc.querySelector('link[rel="canonical"]')?.href || url;
  const published =
    meta('meta[property="article:published_time"]') || meta('meta[name="pubdate"]') ||
    doc.querySelector('time[datetime]')?.getAttribute('datetime');
  const lang = doc.documentElement.getAttribute('lang') || undefined;

  const adStats = removeAds(doc);

  const article = new Readability(doc, { charThreshold: 200, keepClasses: false }).parse();
  if (!article || !article.content) throw new Error('本文を抽出できませんでした');

  // タイトルから「 | サイト名」等の接尾辞を除去
  const title = cleanTitle(article.title, article.siteName);

  let body = makeTurndown().turndown(article.content);
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  // 本文先頭の見出しがタイトルと同じなら重複させない
  const firstHeading = /^#{1,3} (.+)\n/.exec(body);
  const hasTitleHeading = firstHeading && title && firstHeading[1].trim() === title;
  if (hasTitleHeading) body = body.replace(/^#{1,3} .+\n+/, '');

  if (opts.adSlots > 0) body = insertAdSlotMarkers(body, opts.adSlots);

  const fm = frontMatter({
    title,
    source: canonical,
    site: article.siteName,
    byline: article.byline,
    published,
    lang,
    excerpt: article.excerpt,
    fetched_at: new Date().toISOString(),
    removed_ad_elements: adStats.total,
  });

  const heading = title ? `# ${title}\n\n` : '';
  return {
    markdown: fm + heading + body + '\n',
    meta: { title, canonical, adStats, length: article.length },
  };
}

function cleanTitle(t, site) {
  if (!t) return t;
  const parts = t.split(/\s+[|｜\-–—:：]\s+/);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (!site || last.includes(site) || site.includes(last) || last.length < 20) return parts.slice(0, -1).join(' | ');
  }
  return t;
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
    const isPara = b && !/^(#|\||-|\*|>|```|!\[|\d+\.)/.test(b.trim());
    if (isPara && ++paras % every === 0) out.push(`<!-- ad-slot:${++slot} -->`);
  }
  return out.join('\n\n');
}

export async function urlToMarkdown(u, opts = {}) {
  const { html, finalUrl } = await fetchHtml(u);
  return htmlToMarkdown(html, finalUrl, opts);
}
