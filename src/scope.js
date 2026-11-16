// 本文コンテナの特定とボイラープレート（パンくず・SNS・スキップリンク・写真UI等）の除去
// Readability は本文が短いと周囲の「最新ニュース」等まで含めた大きな要素を選んだり、
// 逆に本文を落としたりするため、先に本文の範囲を特定してから変換する。
// DOM API だけを使う（ブラウザでも jsdom でも動く）

const BOILER_ANCESTOR =
  'nav, aside, footer, form, [role="navigation"], [role="complementary"], [role="contentinfo"], [aria-hidden="true"]';

// 本文の明示的なマーカー
const BODY_SELECTORS = [
  '[itemprop="articleBody"]', '#articleBody', '.article-body', '.articleBody', '.article_body',
  '#article-body', '.entry-content', '.post-content', '.article-content', '.story-body', '.main-text',
];

export const textLen = (el) => (el?.textContent || '').replace(/\s+/g, '').length;

function linkTextLen(el) {
  let n = 0;
  el.querySelectorAll('a').forEach((a) => { n += textLen(a); });
  return n;
}

// 本文らしい段落: 30字以上・リンク内でない・リンク密度が低い・ナビ/サイド/フッター外
export function contentParagraphs(root) {
  return [...root.querySelectorAll('p')].filter((p) => {
    const n = textLen(p);
    if (n < 30) return false;
    if (p.closest('a') || p.closest(BOILER_ANCESTOR)) return false;
    return linkTextLen(p) / n < 0.5;
  });
}

const depthOf = (el) => { let d = 0; for (let e = el; e; e = e.parentElement) d++; return d; };

/**
 * 本文を含む要素を返す（見つからなければ null）
 */
export function findContentRoot(doc) {
  const paras = contentParagraphs(doc.body);
  const total = paras.reduce((s, p) => s + textLen(p), 0);
  const share = (el) => paras.reduce((s, p) => s + (el.contains(p) ? textLen(p) : 0), 0) / (total || 1);

  let root = null;
  // 1) 明示マーカー。段落が十分あるときは本文段落の60%以上を含むもの、
  //    段落が少ない（リンク集型の記事など）ときは最もテキストの多いもの
  for (const sel of BODY_SELECTORS) {
    const cands = [...doc.querySelectorAll(sel)].filter((el) => !el.closest(BOILER_ANCESTOR));
    if (!cands.length) continue;
    if (total >= 100) {
      const best = cands.map((el) => [el, share(el)]).sort((a, b) => b[1] - a[1])[0];
      if (best[1] >= 0.6) { root = best[0]; break; }
    } else {
      const best = cands.sort((a, b) => textLen(b) - textLen(a))[0];
      if (textLen(best) >= 50) { root = best; break; }
    }
  }

  // 2) 本文段落の80%以上を含む最も深い要素
  if (!root && total >= 100) {
    const score = new Map();
    for (const p of paras) {
      const n = textLen(p);
      for (let e = p.parentElement; e && e !== doc.documentElement; e = e.parentElement) {
        score.set(e, (score.get(e) || 0) + n);
      }
    }
    let best = -1;
    for (const [el, s] of score) {
      if (s / total < 0.8) continue;
      const d = depthOf(el);
      if (d > best) { best = d; root = el; }
    }
  }
  if (!root || root === doc.body) return null;

  // 3) 見出し・日付・写真を含めるため、外側の <article> が大きすぎなければそちらを採用
  const art = root.parentElement?.closest('article');
  if (art && textLen(art) <= textLen(root) * 3 + 500) root = art;
  return root;
}

// 本文範囲内のボイラープレート
const BOILER_SELECTORS = [
  'nav', '[role="navigation"]', 'aside', 'form', 'button', 'input', 'label', 'select', 'textarea',
  '[class*="breadcrumb"]', '[id*="breadcrumb"]', '[class*="topicpath"]', '[class*="pankuzu"]',
  '[itemtype*="BreadcrumbList"]',
  '.skip', '.sr-only', '.visually-hidden', '.screen-reader-text', '.hide', '.hidden', '[hidden]',
  '[aria-hidden="true"]',
  '[class*="share"]', '[id*="share"]', '[class*="social"]', '[id*="social"]', '[class*="sns"]', '[id*="sns"]',
  '[class*="related"]', '[id*="related"]', '[class*="recommend"]', '[id*="recommend"]',
  '[class*="ranking"]', '[id*="ranking"]',
  '[class*="pagination"]', '[class*="pager"]', '[class*="pagenavi"]', '[class*="page-nav"]',
  '[class*="open-box"]', '[class*="btn"]',
];
// それだけが書かれた要素はUI部品とみなして消す
const UI_TEXT =
  /^(メインコンテンツ|本文へ(移動|スキップ)?|ナビゲーションへ|Skip to (main )?content|Main content|RSS|すべての写真を見る.*|閉じる.*|もっと見る|続きを読む|次へ|前へ|次のページ|前のページ|拡大|印刷|通知(ON|OFF)(\s*通知(ON|OFF))?)$/i;

export function removeBoilerplate(root) {
  let n = 0;
  for (const sel of BOILER_SELECTORS) {
    root.querySelectorAll(sel).forEach((el) => {
      // 本文段落を複数含むものは消さない（class 名の誤爆防止）
      if (el.isConnected && contentParagraphs(el).length < 2) { el.remove(); n++; }
    });
  }
  root.querySelectorAll('a, h1, h2, h3, h4, span, p, div, dd, dt, li, small').forEach((el) => {
    if (el.isConnected && textLen(el) < 40 && UI_TEXT.test((el.textContent || '').trim())) { el.remove(); n++; }
  });
  fixImages(root);
  return n;
}

// 遅延読み込み画像の実URL化、ダミー画像と空リンクの除去
export function fixImages(root) {
  root.querySelectorAll('img').forEach((img) => {
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src');
    const src = img.getAttribute('src') || '';
    if (lazy) img.setAttribute('src', lazy);
    else if (/blank|spacer|1x1|pixel|transparent/i.test(src)) img.remove();
  });
  root.querySelectorAll('a').forEach((a) => {
    if (!a.textContent.trim() && !a.querySelector('img')) a.remove();
  });
}

// タイトル末尾の「 | 芸能 - 日刊スポーツ」のような区切りを繰り返し除去
export function cleanTitle(t, site) {
  if (!t) return t;
  let parts = t.split(/\s*[|｜]\s*|\s+[-–—:：]\s+/);
  while (parts.length > 1) {
    const last = parts[parts.length - 1].trim();
    if ((site && (last.includes(site) || site.includes(last))) || last.length <= 15) parts = parts.slice(0, -1);
    else break;
  }
  return parts.join(' | ').trim();
}
