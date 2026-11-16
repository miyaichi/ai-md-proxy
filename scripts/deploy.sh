#!/usr/bin/env bash
# 既存の GCP プロジェクトを初期設定して Cloud Run にデプロイする（Mac から実行）
#   ./scripts/deploy.sh                 … 認証必須（非公開）
#   ALLOW_PUBLIC=1 ./scripts/deploy.sh  … 未認証アクセスを許可（公開）
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="${PROJECT_ID:-ai-md-proxy}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-ai-md-proxy}"
ALLOW_PUBLIC="${ALLOW_PUBLIC:-0}"

echo "== アカウント: $(gcloud config get-value account 2>/dev/null) / プロジェクト: $PROJECT_ID / $REGION"
gcloud projects describe "$PROJECT_ID" --format='value(projectId)' >/dev/null \
  || { echo "プロジェクト $PROJECT_ID が見つかりません。PROJECT_ID=<実際のID> を指定してください"; exit 1; }

# 請求先アカウント（未設定なら選択）
if [[ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')" != "True" ]]; then
  if [[ -z "${BILLING_ACCOUNT:-}" ]]; then
    gcloud billing accounts list --filter=open=true --format="table(name.basename(),displayName)"
    read -rp "紐付ける請求先アカウントID: " BILLING_ACCOUNT
  fi
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
fi

echo "== API を有効化（初回は数分）"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com compute.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT_ID"

# ソースビルドで使われる既定サービスアカウントへ権限付与
PN=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" \
  --role="roles/run.builder" --condition=None >/dev/null

AUTH_FLAG="--no-allow-unauthenticated"
[[ "$ALLOW_PUBLIC" == "1" ]] && AUTH_FLAG="--allow-unauthenticated"
gcloud run deploy "$SERVICE" --source . \
  --project "$PROJECT_ID" --region "$REGION" \
  --memory 1Gi --cpu 1 --concurrency 20 --timeout 60 \
  --min-instances 0 --max-instances 3 $AUTH_FLAG --quiet

URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')
echo; echo "== デプロイ完了: $URL"
if [[ "$ALLOW_PUBLIC" == "1" ]]; then
  curl -sS "$URL/health"; echo
else
  curl -sS -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/health"; echo
  echo "例: curl -H \"Authorization: Bearer \$(gcloud auth print-identity-token)\" \"$URL/md?url=<記事URL>\""
fi
