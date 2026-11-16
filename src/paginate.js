// 複数ページ記事の扱い
// - 各ページの URL を「記事キー（ページ指定を除いたURL）」と「ページ番号」に分解する
// - 1ページ目のHTMLから他ページのURLを集め、全ページの本文を1つの Markdown に結合する
// - 有料・会員限定の壁を検出したらそこで止める（ペイウォールの回避はしない）

// ページ番号として扱うクエリパラメータ
const PAGE_PARAMS = ['page', 'p', 'pg', 'pageno', 'pagenum', 'paged'];
// 記事キーから外す追跡用パラメータ
const TRACKING = /^(utm_|fbclid$|gclid$|yclid$|mc_)/;

/**
 * URL を { key, n } に分解する。key はページ指定を除いた記事URL（そのまま1ページ目のURLとして使える）
 * パスの数字を安易にページ番号と見なさないよう、明示的なパターンだけを扱う
 *   ?page=2 / ?p=2 …, /page/2/, xxx_2.html, xxx-2.html
 */
export function pageOf(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  let n = 1;
  for (const p of PAGE_PARAMS) {
    const v = u.searchParams.get(p);
    if (v !== null && /^\d{1,3}$/.test(v)) { n = Number(v); u.searchParams.delete(p); }
  }
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  let m;
  if ((m = u.pathname.match(/^(.*)\/page\/(\d{1,3})\/?$/))) { n = Number(m[2]); u.pathname = `${m[1]}/`; }
  else if ((m = u.pathname.match(/^(.*[^\d])[_-](\d{1,2})\.(html?|php)$/))) { n = Number(m[2]); u.pathname = `${m[1]}.${m[3]}`; }
  u.searchParams.sort();
  return { key: u.href, n: n || 1 };
}

/**
 * ページ内のリンクから、同じ記事の他ページを集める（広告・ナビ除去の前の文書に対して呼ぶ）
 * @returns {{ key, n, pages: Map<number,string>, next?: string, paywalled: boolean }}
 */
export function paginationInfo(doc, url) {
  const self = pageOf(url) || { key: url, n: 1 };
  const pages = new Map([[self.n, url]]);
  const add = (href) => {
    const p = pageOf(href, url);
    if (!p || p.key !== self.key || p.n > 50) return null;
    const abs = new URL(href, url); abs.hash = '';
    if (!pages.has(p.n)) pages.set(p.n, abs.href);
    return { ...p, href: abs.href };
  };
  // rel="next"（<link> と <a>）
  let next;
  for (const el of doc.querySelectorAll('link[rel~="next"][href], a[rel~="next"][href]')) {
    const p = add(el.getAttribute('href'));
    if (p && p.n > self.n) { next = p.href; break; }
  }
  // ページ送りのリンク
  for (const a of doc.querySelectorAll('a[href]')) add(a.getAttribute('href'));
  if (!next && pages.has(self.n + 1)) next = pages.get(self.n + 1);
  if (!pages.has(1)) pages.set(1, self.key);
  return { key: self.key, n: self.n, pages, next, paywalled: isPaywalled(doc) };
}

// 有料・会員限定の検出（構造化データの isAccessibleForFree=false、または典型的な案内文）
const PAYWALL_TEXT = /^(この記事は(有料)?会員限定|この記事の続きは|続きは(有料)?会員|(無料)?会員登録(すると|して)(続き|全文)|ログインして(続き|全文)を読む|有料会員になると)/;
export function isPaywalled(doc) {
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    if (/"isAccessibleForFree"\s*:\s*(false|"false"|"False")/.test(s.textContent || '')) return true;
  }
  for (const el of doc.querySelectorAll('p, div, span, a, h2, h3, strong')) {
    const t = (el.textContent || '').trim();
    if (t.length < 120 && PAYWALL_TEXT.test(t)) return true;
  }
  return false;
}

/**
 * 2ページ目以降の先頭で、1ページ目と同じブロック（タイトル・日付・写真など）を除く
 */
export function dropRepeatedHead(body, firstBody, title) {
  const firstBlocks = new Set(firstBody.split(/\n\n/).slice(0, 10).map((b) => b.trim()));
  const norm = (s) => s.replace(/[\s　#]/g, '');
  const blocks = body.split(/\n\n/);
  while (blocks.length && (firstBlocks.has(blocks[0].trim()) || (title && norm(blocks[0]) === norm(title)))) blocks.shift();
  return blocks.join('\n\n');
}

// 会員登録・ログインの案内ブロックを本文から除く（検出は除去前に済ませておく）
export function removePaywallNotices(doc) {
  doc.querySelectorAll('[class*="paywall"], [id*="paywall"], [class*="regwall"], [class*="subscribe"], [class*="premium-guide"]')
    .forEach((el) => { if ((el.textContent || '').replace(/\s+/g, '').length < 400) el.remove(); });
  doc.querySelectorAll('p, div, span, a, h2, h3, strong').forEach((el) => {
    const t = (el.textContent || '').trim();
    if (el.isConnected && t.length < 120 && PAYWALL_TEXT.test(t)) el.remove();
  });
}
