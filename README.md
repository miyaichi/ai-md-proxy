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
