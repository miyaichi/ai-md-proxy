# ai-md-proxy（プロトタイプ）

任意のパブリッシャー記事URLを受け取り、**広告を除去したうえで本文を Markdown で返す**サービスの試作です。
AIクローラー向けに「Markdown版ページ＋Markdown広告」を返す構想の第一段階（取得・除去・変換）にあたります。

## セットアップ

```bash
npm install        # Node.js 20 以上
```

## 使い方

### CLI
```bash
node src/cli.js https://example.com/article --stats
node src/cli.js --file test/fixture.html --base https://news.example.jp/a --slots 3
```

### HTTP サーバー
```bash
npm start          # PORT=8787 がデフォルト
curl "http://localhost:8787/md?url=https://example.com/article"
curl "http://localhost:8787/md?url=https://example.com/article&slots=3"
```
レスポンスは `text/markdown`。ヘッダー `x-removed-ads` に除去した広告要素の数、`x-cache` にキャッシュの当たり外れ（10分TTL）が入ります。

## 処理の流れ

1. **取得**（`extract.js#fetchHtml`）：http/https のみ受け付け、プライベートIP宛は拒否（SSRF対策。リダイレクト先も再チェック）。5MB上限、15秒タイムアウト。Shift_JIS/EUC-JP は Content-Type → meta charset の順で判定します。
2. **広告除去**（`adfilter.js#removeAds`）：判定は4段階
   - 既知の広告タグ：AdSense、GPT、Prebid、Taboola、Outbrain、popIn、logly、AdGeneration、MicroAd、fluct、Geniee、i-mobile、nend、UZOU など
   - 広告配信ドメイン（doubleclick、googlesyndication、amazon-adsystem、socdm ほか）を参照する iframe/img/a
   - class/id のトークン一致（`ad-top`、`sponsored`、`adArea` など）。部分一致は使わないので、`header` や Tailwind の `pr-4` は誤って消しません
   - 「広告」「PR」「スポンサーリンク」などのラベルとそれが付いた小ブロック
   - 安全策：`article`/`main` 要素や、長文で段落の多い要素は消しません
3. **本文抽出**：Mozilla Readability（Firefox のリーダービューと同じエンジン）でナビ・サイドバー・フッターを落とします。
4. **Markdown 変換**：Turndown＋GFM（表に対応）。トラッキングピクセルは削除し、YouTube/Vimeo の埋め込みはリンクに置き換えます。相対URLは絶対URLにします。
5. **出力**：YAML フロントマター（title、source=canonical、site、byline、published、lang、excerpt、fetched_at、removed_ad_elements）＋本文。

## 複数ページの記事

`?page=2` のように複数ページに分かれた記事は、**どのページのURLで呼ばれても、全ページの本文を1つの Markdown に結合して返します**。

- 1ページ目の `<link rel="next">` とページ送りのリンクから他ページを見つけ、並列に取得して順に結合（ページ送りが途中までしか表示されない場合は最後のページの「次へ」をたどる）
- ページ番号として扱うのは `?page=N`（`p`、`pg` 等も可）、`/page/N/`、`xxx_N.html`、`xxx-N.html` だけ。記事IDの数字をページ番号と誤認しない
- 2ページ目以降で繰り返されるタイトル・日付・写真は除き、境界に `<!-- page:N -->` を入れる
- 正規URL（`Link` ヘッダーと `source`）は1ページ目。front matter に `pages: "N"`
- 同じ記事・別ドメイン以外のページはたどらない。最大20ページ、全体40秒まで
- **会員限定・有料の壁**（構造化データの `isAccessibleForFree: false`、「この記事の続きは会員限定」等の案内、401/402/403）を検出したら、そこで止めて `truncated: "true"` を付ける。ペイウォールを回避して取得することはしない
- プロキシのキャッシュも記事単位（`?page=2` と `?page=3` は同じキャッシュ）

テスト：`node test/paged.test.mjs`

## 広告枠マーカー（次の段階への接続点）

`slots=N` を付けると、N段落ごとに `<!-- ad-slot:1 -->` が入ります。後段の処理でこのマーカーを実際の Markdown 広告に置き換える想定です。

## 既知の制約・次にやること

- JavaScriptでレンダリングするサイト（SPA）は本文を取れません → 必要なら Playwright による取得に切り替える
- 有料記事やログインが必要なページは対象外。正式なサービスではパブリッシャーとの契約・オリジン側との連携が前提
- 広告ルールはヒューリスティックです。実サイトで誤検知・見逃しを洗い出してルールを育てる必要があります
- 次の段階：AIクローラーの判定（UA・逆引きDNS・公開IPレンジ）→ Markdown版を返す配信（Cloudflare Workers／CDNエッジ）→ ad-slot への広告差し込みと計測

## Cloud Run へのデプロイ（GCP プロジェクト: ai-md-proxy）

### 1. デプロイ（Mac から）
```bash
./scripts/deploy.sh
```
請求先の紐付け、API有効化、APIキー用シークレットの作成、デプロイまでを行います。初回は管理者用キー（owner）が表示されます。
東京リージョン、1 vCPU／1GiB、0〜3インスタンス。ビルドは Cloud Build が行うので Docker は不要です。

### 2. APIキーの発行（社外チームとの共有）
```bash
./scripts/manage-keys.sh add partner-a     # キーを発行して表示 → 相手に渡す
./scripts/manage-keys.sh list              # 発行済み一覧（キーは一部のみ表示）
./scripts/manage-keys.sh show partner-a    # キーを再表示
./scripts/manage-keys.sh rotate partner-a  # キーを作り直す（旧キーは即無効）
./scripts/manage-keys.sh revoke partner-a  # 無効化
```
キーは Secret Manager（`ai-md-proxy-api-keys`）に保存され、変更すると Cloud Run の新リビジョンで自動的に反映されます（1分程度）。

### 3. 呼び出し方（相手チームに伝える内容）
```bash
curl -H "x-api-key: <キー>" "https://<サービスURL>/md?url=<記事URL>"
```
ブラウザからは `https://<サービスURL>/md?url=<記事URL>&key=<キー>` でも呼べます。
ただし URL に含めたキーはアクセスログに残るので、継続利用はヘッダー方式を推奨します。

- キーごとに 1分あたり60回まで（環境変数 `RATE_LIMIT_PER_MIN` で変更可）。超えると 429
- アクセスログはキーの名前付きで Cloud Logging に出ます（`jsonPayload.client="partner-a"` で絞り込み）
- ローカル実行（`npm start`）で `API_KEYS` を設定しなければ認証なしで動きます

### 4. GitHub Actions による自動デプロイ（一度だけ設定）
```bash
./scripts/setup-github-actions.sh
```
Workload Identity Federation（サービスアカウント鍵を使わない方式）で `miyaichi/ai-md-proxy` からのデプロイだけを許可し、
リポジトリ変数 `GCP_PROJECT_ID` / `GCP_WIF_PROVIDER` / `GCP_DEPLOY_SA` を `gh` で登録します。
以後は main ブランチへの push でテスト → デプロイが動きます（変数が未設定のあいだはテストだけ実行）。

## To-Do：前段 Web サーバー／CDN で AI クローラーだけを振り分ける運用

想定構成：パブリッシャーの Web サーバー（または CDN エッジ）が User-Agent を判定し、AI クローラーのときだけこのプロキシの Markdown を返す。それ以外（一般ユーザー、Googlebot、Bingbot 等）には従来どおり元の HTML を返す。

### 1. キャッシュの分離（`Vary`）
- [ ] 前段の Web サーバーや CDN から AI クローラーへレスポンスを返す際、必ず `Vary: User-Agent` を付与し、一般ユーザー用の HTML キャッシュと混ざらないようにする
- [ ] **HTML 側のレスポンスにも同じ `Vary` を付ける**（片方だけだと、HTML のキャッシュが AI クローラーに、Markdown のキャッシュが人間に返る事故が起きうる）
- [ ] `Vary: User-Agent` は UA 文字列の種類ごとにキャッシュが分かれ、ヒット率が大きく下がる。エッジで UA を「ai／other」に分類した値（例：`X-Client-Class`）をキャッシュキーに含める方式を検討する
- [ ] `Accept: text/markdown` での出し分け（コンテントネゴシエーション）も行う場合は `Vary: Accept` も付ける

### 2. 対象 User-Agent の限定
- [ ] 対象は AI 事業者のクローラーに限定し、通常の `Googlebot` や `Bingbot` には元の HTML を返すようにルーティングする
- [ ] 対象 UA の一覧は設定ファイル化し、コードを変えずに追加・削除できるようにする。初期候補：

| 事業者 | User-Agent（HTTP リクエストに現れる名前） | 用途 |
|---|---|---|
| OpenAI | `GPTBot` / `OAI-SearchBot` / `ChatGPT-User` | 学習 / 検索インデックス / ユーザー操作による取得 |
| Anthropic | `ClaudeBot` / `Claude-SearchBot` / `Claude-User` | 学習 / 検索インデックス / ユーザー操作による取得 |
| Perplexity | `PerplexityBot` / `Perplexity-User` | 検索インデックス / ユーザー操作による取得 |

- [ ] **`Google-Extended` は HTTP の User-Agent ではなく robots.txt 専用のトークン**。Google の AI 用途の取得も通常の Googlebot が行うため、UA では振り分けられない（Googlebot には HTML を返す方針のまま、AI 学習への利用可否は robots.txt の `Google-Extended` で制御する）。`Applebot-Extended` も同様に robots.txt 専用
- [ ] 学習用（GPTBot、ClaudeBot）とユーザー操作による取得（ChatGPT-User、Claude-User、Perplexity-User）を区別して記録する。後者は「今まさに人間が質問している」取得なので、広告の価値・扱いが異なる

### 3. UA 偽装への対策（追加提案）
- [ ] UA だけを信用しない。各社が公開している IP レンジ（例：`openai.com/gptbot.json`、`openai.com/searchbot.json`、`openai.com/chatgpt-user.json`）や逆引き DNS で本物か確認し、確認できない場合は HTML を返す
- [ ] CDN の検証済みボット機能（Cloudflare の Verified Bots／Web Bot Auth など）が使える場合はそれを優先する

### 4. 検索エンジンとクローキング（追加提案）
- [ ] Googlebot・Bingbot には必ず HTML を返す（検索順位への影響とクローキング判定を避ける）
- [ ] Markdown 版の本文は HTML 版と同じ内容に保つ（広告・ナビゲーションの除去以外で内容を変えない）
- [ ] Markdown 応答には `Link: <元記事URL>; rel="canonical"` を付け、元記事を正規 URL として伝える（実装済み）

### 5. プロキシとの接続（追加提案）
- [ ] 前段サーバー → プロキシの呼び出しには API キー（`x-api-key`）を使い、パブリッシャーごとに発行する。キーはサーバー設定に置き、外部に出さない
- [ ] **ループ防止**：プロキシが元記事を取得するリクエストが、前段で AI クローラー扱いされて再びプロキシに回らないようにする（プロキシ用の識別ヘッダーや送信元 IP の許可リストで除外）。オリジン側のボット対策（WAF）にプロキシが遮断されないよう許可も設定する
- [ ] **フェイルオープン**：プロキシがタイムアウト（目安 3〜5 秒）やエラーのときは元の HTML を返す
- [ ] 404・410・リダイレクトは元記事のステータスをそのまま返す
- [ ] 前段が既に持っている HTML をプロキシに渡す方式（POST で HTML を受け取る API）を追加し、オリジンへの二重取得をなくす

### 6. キャッシュと性能（追加提案）
- [ ] 記事更新時にプロキシ側と CDN 側の Markdown キャッシュを破棄する仕組み（現状はインスタンス内メモリで10分）
- [ ] 本番では Cloud Run の最小インスタンスを 1 以上にしてコールドスタートを避ける
- [ ] 共有キャッシュ（Memorystore や CDN）への移行

### 7. 広告と計測（追加提案）
- [ ] `<!-- ad-slot:N -->` を実際の Markdown 広告に置き換える処理
- [ ] Markdown 広告には「広告」「PR」の表示を必ず付ける（AI の回答に引用された場合も広告だと分かるように）
- [ ] クローラー種別・記事・広告枠ごとの配信ログと集計（パブリッシャーへのレポート用）
- [ ] パブリッシャーの robots.txt の方針（どの AI クローラーを許可するか）と振り分け設定を一致させる

参考：
[Google の一般的なクローラー一覧](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers) /
[OpenAI のクローラー](https://developers.openai.com/api/docs/bots) /
[Anthropic のクローラー](https://support.claude.com/en/articles/8896518)
