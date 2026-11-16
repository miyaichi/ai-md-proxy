// 広告要素の除去ルール
// 方針: (1) 既知の広告タグ/ネットワークのセレクタ (2) 広告配信ドメインを参照する要素
//       (3) class/id のトークン一致 (4) 「広告」「PR」等のラベルだけの小要素
// 誤爆を避けるため class/id は「部分一致」ではなく「トークン一致」で判定する
// (例: "header" や "reader" に含まれる "ad" は対象外)

// 既知の広告タグ・ネイティブ広告ネットワーク（国内含む）
export const AD_SELECTORS = [
  // Google AdSense / GPT (Google Ad Manager)
  'ins.adsbygoogle', '[id^="div-gpt-ad"]', '[data-google-query-id]',
  '[id^="google_ads_iframe"]', '[data-ad-slot]', '[data-ad-client]',
  // 汎用データ属性
  '[data-ad]', '[data-ad-unit]', '[data-adunit]', '[data-ad-type]', '[data-advertisement]',
  // Prebid / Amazon
  '[id^="prebid"]', '.amzn-native-container',
  // レコメンド/ネイティブ広告（海外）
  '[id^="taboola"]', '[class*="taboola"]', '.trc_related_container',
  '.OUTBRAIN', '[data-widget-id][data-src*="outbrain"]', '[class*="outbrain"]',
  '[id^="mgid"]', '[class*="revcontent"]',
  // 国内ネイティブ/アドネットワーク
  '[id^="_popIn"]', '[class*="_popIn"]', '[class*="popin_recommend"]',
  '[id^="logly-lift"]', '[class*="logly-lift"]',
  '[id^="adg_"]', '[class*="adg-"]', // AdGeneration
  '[id^="im-"][data-imp]', '[class*="i-mobile"]', '[id*="microad"]', '[class*="microad"]',
  '[class*="fluct"]', '[id*="fluct"]', '[class*="gmossp"]', '[id*="gmossp"]',
  '[class*="geniee"]', '[id*="geniee"]', '[class*="zucks"]', '[class*="nend"]',
  '[class*="uzou"]', '[id*="uzou"]',
];

// 広告配信・計測ドメイン（iframe/script/img/a の参照先で判定）
export const AD_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.',
  'amazon-adsystem.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'rubiconproject.com',
  'pubmatic.com', 'openx.net', 'casalemedia.com', 'taboola.com', 'outbrain.com',
  'popin.cc', 'logly.co.jp', 'socdm.com', 'microad.jp', 'microad.net', 'i-mobile.co.jp',
  'adingo.jp', 'fluct.jp', 'gmossp-sp.jp', 'genieesspv.jp', 'gssprt.jp', 'zucks.net',
  'nend.net', 'impact-ad.jp', 'yimg.jp/images/listing', 'yads.yahoo.co.jp',
  'ad.yieldmanager.com', 'adform.net', 'smartadserver.com', 'teads.tv', 'moatads.com',
  'adsafeprotected.com', 'scorecardresearch.com',
];

// class/id をトークン分割したときに広告と判断するトークン
const AD_TOKENS = new Set([
  'ad', 'ads', 'adv', 'advert', 'adverts', 'advertisement', 'advertising', 'adsense',
  'adbox', 'adslot', 'adunit', 'adarea', 'adwrap', 'adwrapper', 'adcontainer', 'adblock',
  'banner', 'banners', 'sponsor', 'sponsored', 'sponsors', 'promo', 'promoted', 'pr',
  'dfp', 'gpt', 'affiliate', 'native-ad', 'rectangle', 'billboard', 'skyscraper', 'overlay-ad',
]);
// トークンの先頭/末尾で広告を示すもの（ad-top, top-ad, adArea 等）
const AD_TOKEN_RE = /^(ad|ads|advert|banner|sponsor|promo)(top|bottom|side|area|box|slot|unit|wrap|wrapper|container|block|space|zone|frame)$|^(ad|ads)\d+$|^(top|bottom|side|header|footer|inline|in|article|sidebar|sticky|mid|middle|rect)(ad|ads|banner)$/;

// ラベルだけの要素（この文字列だけを含む小要素は広告ラベルとして消す）
const AD_LABELS = /^\s*(広告|PR|ＰＲ|\[PR\]|【PR】|スポンサーリンク|スポンサード|Sponsored|Advertisement|Ad|Ads|AD|プロモーション|Promoted)\s*$/i;

// 分割後のサブトークンとしては判定しないもの（Tailwind の pr-4 = padding-right 等の誤爆防止）
const WHOLE_ONLY = new Set(['pr', 'promo', 'banner', 'rectangle', 'gpt', 'affiliate']);

function isAdByTokens(el) {
  const raw = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
  if (!raw.trim()) return false;
  // (a) class/id そのもの: "ad-top", "pr", "sponsored"
  const whole = raw.toLowerCase().split(/\s+/).filter(Boolean);
  if (whole.some((x) => AD_TOKENS.has(x) || AD_TOKEN_RE.test(x.replace(/[-_]/g, '')))) return true;
  // (b) -,_ と camelCase で分割したサブトークン: "article-ad" -> ad, "adArea" -> ad
  const sub = raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\-]+/)
    .filter(Boolean);
  return sub.some((x) => AD_TOKENS.has(x) && !WHOLE_ONLY.has(x));
}

function refersToAdDomain(el) {
  const v = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('data-src') || '';
  return v && AD_DOMAINS.some((d) => v.includes(d));
}

// 本文コンテナを誤って消さないための安全弁：大量のテキストを含む要素は消さない
function looksLikeMainContent(el) {
  const tag = el.tagName.toLowerCase();
  if (['article', 'main', 'body', 'html'].includes(tag)) return true;
  const text = (el.textContent || '').replace(/\s+/g, '');
  const pCount = el.querySelectorAll('p').length;
  return text.length > 1500 && pCount >= 5;
}

/**
 * document から広告を除去する。戻り値は除去件数の内訳。
 */
export function removeAds(document) {
  const stats = { selector: 0, domain: 0, token: 0, label: 0, script: 0 };
  const remove = (el, key) => {
    if (!el.isConnected) return;
    if (looksLikeMainContent(el)) return;
    el.remove();
    stats[key]++;
  };

  // 0) スクリプト・noscript・style 等は Markdown に不要
  document.querySelectorAll('script, noscript, style, template, object, embed').forEach((el) => {
    el.remove();
    stats.script++;
  });

  // 1) 既知セレクタ
  for (const sel of AD_SELECTORS) {
    try {
      document.querySelectorAll(sel).forEach((el) => remove(el, 'selector'));
    } catch { /* 不正セレクタは無視 */ }
  }

  // 2) 広告ドメインを参照する iframe / img / a
  document.querySelectorAll('iframe, img, a, source').forEach((el) => {
    if (!refersToAdDomain(el)) return;
    // 広告リンク・画像は、それを包む小さな親（figure/div 等）ごと消す
    const parent = el.parentElement;
    const target =
      parent && parent.children.length === 1 && (parent.textContent || '').trim().length < 80
        ? parent
        : el;
    remove(target, 'domain');
  });
  // 残った iframe は埋め込み動画等以外不要なので除去（YouTube等はリンクに置換）
  document.querySelectorAll('iframe').forEach((el) => {
    const src = el.getAttribute('src') || '';
    if (/youtube\.com|youtu\.be|vimeo\.com/.test(src)) {
      const a = document.createElement('a');
      a.setAttribute('href', src);
      a.textContent = `動画: ${src}`;
      el.replaceWith(a);
    } else {
      remove(el, 'domain');
    }
  });

  // 3) class/id のトークン一致
  document.querySelectorAll('[class], [id]').forEach((el) => {
    if (el.isConnected && isAdByTokens(el)) remove(el, 'token');
  });

  // 4) 「広告」「PR」等のラベルだけの小要素（直後の兄弟が広告本体のことが多い）
  document.querySelectorAll('span, div, p, small, em, strong, h2, h3, h4, li').forEach((el) => {
    if (!el.isConnected || el.children.length > 0) return;
    if (AD_LABELS.test(el.textContent || '')) {
      const parent = el.parentElement;
      // ラベル＋広告本体だけの小さなブロックなら親ごと除去
      if (parent && (parent.textContent || '').replace(/\s+/g, '').length < 200 && parent.querySelector('a, img')) {
        remove(parent, 'label');
      } else {
        remove(el, 'label');
      }
    }
  });

  stats.total = stats.selector + stats.domain + stats.token + stats.label;
  return stats;
}
