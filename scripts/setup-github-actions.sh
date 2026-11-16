#!/usr/bin/env bash
# GitHub Actions から鍵なし（Workload Identity Federation）で Cloud Run にデプロイできるようにする
# deploy.sh の後に一度だけ実行（Mac から）。gh CLI があればリポジトリ変数も自動設定する
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-ai-md-proxy}"
REPO="${REPO:-miyaichi/ai-md-proxy}"
POOL=github
PROVIDER=github
SA_NAME=github-deployer
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
PN=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

# デプロイ用サービスアカウント
gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT_ID" --display-name="GitHub Actions deployer"
for ROLE in roles/run.admin roles/run.sourceDeveloper roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="$ROLE" --condition=None >/dev/null
done
# Cloud Run の実行サービスアカウント（既定の compute SA）として動かす権限
gcloud iam service-accounts add-iam-policy-binding "${PN}-compute@developer.gserviceaccount.com" \
  --project "$PROJECT_ID" --member="serviceAccount:$SA" --role=roles/iam.serviceAccountUser >/dev/null

# Workload Identity プール／プロバイダ（このリポジトリからのトークンだけを受け入れる）
gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT_ID" --location=global >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT_ID" --location=global --display-name="GitHub"
gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT_ID" --location=global \
  --workload-identity-pool="$POOL" >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project "$PROJECT_ID" \
       --location=global --workload-identity-pool="$POOL" --display-name="GitHub Actions" \
       --issuer-uri="https://token.actions.githubusercontent.com" \
       --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
       --attribute-condition="assertion.repository=='${REPO}'"

gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PN}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" >/dev/null

WIF="projects/${PN}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
echo "GCP_PROJECT_ID = $PROJECT_ID"
echo "GCP_WIF_PROVIDER = $WIF"
echo "GCP_DEPLOY_SA = $SA"

if command -v gh >/dev/null; then
  gh variable set GCP_PROJECT_ID   --repo "$REPO" --body "$PROJECT_ID"
  gh variable set GCP_WIF_PROVIDER --repo "$REPO" --body "$WIF"
  gh variable set GCP_DEPLOY_SA    --repo "$REPO" --body "$SA"
  echo "== GitHub リポジトリ変数を設定しました"
else
  echo "== gh が無いので、上の3つを GitHub の Settings > Secrets and variables > Actions > Variables に登録してください"
fi
