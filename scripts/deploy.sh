#!/usr/bin/env bash
# GCP プロジェクトを初期設定して Cloud Run にデプロイする（Mac から実行）
# アクセス制御は APIキー（Secret Manager に保存）。Cloud Run 自体の IAM 認証は外す
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="${PROJECT_ID:-ai-md-proxy}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-ai-md-proxy}"
SECRET="${SECRET:-ai-md-proxy-api-keys}"

echo "== アカウント: $(gcloud config get-value account 2>/dev/null) / プロジェクト: $PROJECT_ID / $REGION"
gcloud projects describe "$PROJECT_ID" --format='value(projectId)' >/dev/null \
  || { echo "プロジェクト $PROJECT_ID が見つかりません。PROJECT_ID=<実際のID> を指定してください"; exit 1; }

if [[ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')" != "True" ]]; then
  if [[ -z "${BILLING_ACCOUNT:-}" ]]; then
    gcloud billing accounts list --filter=open=true --format="table(name.basename(),displayName)"
    read -rp "紐付ける請求先アカウントID: " BILLING_ACCOUNT
  fi
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
fi

echo "== API を有効化（初回は数分）"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com compute.googleapis.com secretmanager.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT_ID"

PN=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
RUNTIME_SA="${PN}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" --role="roles/run.builder" --condition=None >/dev/null

# APIキー用シークレット（無ければ作成し、管理者用キーを1つ発行）
if ! gcloud secrets describe "$SECRET" --project "$PROJECT_ID" >/dev/null 2>&1; then
  OWNER_KEY="amp_$(openssl rand -hex 24)"
  gcloud secrets create "$SECRET" --project "$PROJECT_ID" --replication-policy=automatic
  printf '# 名前:キー（1行1件）\nowner:%s\n' "$OWNER_KEY" \
    | gcloud secrets versions add "$SECRET" --project "$PROJECT_ID" --data-file=- >/dev/null
  echo "== 管理者用APIキーを発行しました（この表示限り。scripts/manage-keys.sh show owner でも確認可）"
  echo "   owner: $OWNER_KEY"
fi
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" --role=roles/secretmanager.secretAccessor >/dev/null

gcloud run deploy "$SERVICE" --source . \
  --project "$PROJECT_ID" --region "$REGION" \
  --memory 1Gi --cpu 1 --concurrency 20 --timeout 60 \
  --min-instances 0 --max-instances 3 \
  --set-secrets "API_KEYS=${SECRET}:latest" \
  --no-invoker-iam-check --quiet

URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')
echo; echo "== デプロイ完了: $URL"
curl -sS "$URL/health"; echo
echo "例: curl -H \"x-api-key: <キー>\" \"$URL/md?url=<記事URL>\""
echo "社外チーム用のキー発行: ./scripts/manage-keys.sh add <チーム名>"
