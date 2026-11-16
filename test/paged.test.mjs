// 複数ページ記事のテスト（ネットワークを使わず、偽の fetcher でページを返す）
//   node test/paged.test.mjs
import assert from 'node:assert/strict';
import { urlToMarkdown } from '../src/extract.js';

const BASE = 'https://pub.example.jp/articles/-/123';
const BODY = {
  1: ['港町の小さな書店が、開店から五十年を迎えた。店主の女性は毎朝六時に店を開け、通学前の高校生に声をかけ続けてきた。', '地域の読書会は月に一度開かれ、多いときには三十人以上が集まる。参加者の年齢は十代から八十代までと幅広い。'],
  2: ['書店の経営は決して楽ではなかった。大型店の進出やネット通販の普及で、売り上げは最盛期の半分ほどに落ち込んだ時期もある。', 'それでも店主は品ぞろえを地元の作家や郷土史に絞り込み、ほかでは手に入らない本を求める客を少しずつ増やしていった。'],
  3: ['五十周年の記念イベントには、この店で本を買って育った作家たちも駆けつけた。会場は立ち見が出るほどのにぎわいだった。', '店主は「本を通じて町の人とつながれたことが何よりの財産です」と話し、これからも店を続ける考えを示した。'],
};
const TOTAL = 3;

function page(n, { paywallAt } = {}) {
  const pager = [...Array(TOTAL)].map((_, i) => `<a href="/articles/-/123?page=${i + 1}">${i + 1}</a>`).join(' ');
  const next = n < TOTAL ? `<link rel="next" href="?page=${n + 1}">` : '';
  const prev = n > 1 ? `<link rel="prev" href="?page=${n - 1}">` : '';
  const self = n === 1 ? BASE : `${BASE}?page=${n}`;
  const wall = paywallAt === n ? '<div class="paywall"><p>この記事の続きは有料会員限定です</p><a href="/login">ログイン</a></div>' : '';
  const ps = paywallAt === n ? [BODY[n][0]] : BODY[n];
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>港町の書店が五十周年 | サンプル経済</title>
<meta property="og:title" content="港町の書店が五十周年">
<meta property="og:site_name" content="サンプル経済">
<meta property="og:url" content="${BASE}">
<link rel="canonical" href="${self}">${next}${prev}
</head><body>
<header><nav><a href="/">トップ</a></nav></header>
<main><article>
  <h1>港町の書店が五十周年</h1>
  <p class="date">2026.11.16(月)</p>
  <div class="article-body">${ps.map((t) => `<p>${t}</p>`).join('')}${wall}</div>
  <nav class="pager">${pager}</nav>
  <ul class="toc"><li><a href="?page=2#anchor_2">経営の苦労</a></li><li><a href="?page=3#anchor_3">記念イベント</a></li></ul>
</article></main>
<aside><h2>アクセスランキング</h2><ol><li><a href="/articles/-/999">別の記事</a></li></ol></aside>
</body></html>`;
}

function makeFetcher(opts = {}) {
  const calls = [];
  const fetcher = async (u) => {
    calls.push(u);
    const url = new URL(u);
    const n = Number(url.searchParams.get('page') || 1);
    if (url.pathname !== '/articles/-/123' || n > TOTAL) throw Object.assign(new Error('HTTP 404'), { status: 404 });
    if (opts.forbiddenFrom && n >= opts.forbiddenFrom) throw Object.assign(new Error('HTTP 403'), { status: 403 });
    return { html: page(n, opts), finalUrl: u };
  };
  return { fetcher, calls };
}

const all = (md) => Object.values(BODY).flat().every((t) => md.includes(t));
const count = (md, s) => md.split(s).length - 1;

// 1) 1ページ目から：全ページ結合・正規URLは1ページ目・ページ境界マーカー
{
  const { fetcher, calls } = makeFetcher();
  const { markdown, meta } = await urlToMarkdown(BASE, { fetcher });
  assert.ok(all(markdown), '全ページの本文が含まれる');
  assert.equal(meta.pages, 3);
  assert.equal(meta.canonical, BASE);
  assert.match(markdown, /pages: "3"/);
  assert.match(markdown, /<!-- page:2 -->[\s\S]*<!-- page:3 -->/);
  assert.equal(count(markdown, '港町の書店が五十周年'), 2, 'タイトルは front matter と見出しの2回だけ（2ページ目以降で重複しない）');
  assert.ok(count(markdown, '2026.11.16') <= 1, '日付も重複しない');
  assert.ok(!markdown.includes('アクセスランキング'));
  assert.equal(new Set(calls).size, calls.length, '同じページを二度取得しない');
  assert.ok(markdown.indexOf(BODY[2][0]) < markdown.indexOf(BODY[3][0]), 'ページ順');
  console.log('ok 1: 1ページ目から全ページを結合');
}

// 2) 途中のページから：1ページ目から取り直して同じ結果
{
  const { fetcher } = makeFetcher();
  const { markdown, meta } = await urlToMarkdown(`${BASE}?page=2`, { fetcher });
  assert.ok(all(markdown));
  assert.equal(meta.canonical, BASE);
  assert.ok(markdown.indexOf(BODY[1][0]) < markdown.indexOf(BODY[2][0]));
  console.log('ok 2: 2ページ目のURLでも記事全体を返す');
}

// 3) 3ページ目が会員限定：そこで止めて truncated
{
  const { fetcher } = makeFetcher({ paywallAt: 3 });
  const { markdown, meta } = await urlToMarkdown(BASE, { fetcher });
  assert.equal(meta.truncated, true);
  assert.match(markdown, /truncated: "true"/);
  assert.ok(markdown.includes(BODY[2][1]));
  assert.ok(!markdown.includes(BODY[3][1]), '有料部分は含まない');
  assert.ok(!markdown.includes('この記事の続きは有料会員限定です'), '案内文そのものは本文に残さない');
  console.log('ok 3: 会員限定ページで停止');
}

// 4) 2ページ目以降が 403：1ページ目だけ返して truncated
{
  const { fetcher } = makeFetcher({ forbiddenFrom: 2 });
  const { markdown, meta } = await urlToMarkdown(BASE, { fetcher });
  assert.equal(meta.pages, 1);
  assert.equal(meta.truncated, true);
  assert.ok(markdown.includes(BODY[1][0]));
  console.log('ok 4: 403 で停止');
}

console.log('all passed');
