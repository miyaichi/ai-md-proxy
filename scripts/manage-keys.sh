#!/usr/bin/env bash
# APIキーの管理（Secret Manager）。変更後は Cloud Run の新リビジョンを作って反映する
#   ./scripts/manage-keys.sh list               … 発行済みの名前一覧
#   ./scripts/manage-keys.sh add <名前>         … 新しいキーを発行して表示
#   ./scripts/manage-keys.sh show <名前>        … キーを表示
#   ./scripts/manage-keys.sh rotate <名前>      … キーを作り直す（旧キーは無効）
#   ./scripts/manage-keys.sh revoke <名前>      … キーを無効化
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-ai-md-proxy}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-ai-md-proxy}"
SECRET="${SECRET:-ai-md-proxy-api-keys}"

CMD="${1:-list}"; NAME="${2:-}"
current() { gcloud secrets versions access latest --secret "$SECRET" --project "$PROJECT_ID"; }
entries() { current | grep -v '^\s*#' | grep ':' || true; }
need_name() {
  [[ -n "$NAME" ]] || { echo "名前を指定してください"; exit 1; }
  [[ "$NAME" =~ ^[a-z0-9][a-z0-9_-]{1,40}$ ]] || { echo "名前は英小文字・数字・-・_ で指定してください"; exit 1; }
}
has() { entries | cut -d: -f1 | grep -qx "$NAME"; }

save_and_apply() { # 引数: 新しい内容
  local OLD; OLD=$(gcloud secrets versions list "$SECRET" --project "$PROJECT_ID" --filter=state=enabled --format='value(name)')
  { echo '# 名前:キー（1行1件）'; printf '%s\n' "$1" | grep ':' || true; } \
    | gcloud secrets versions add "$SECRET" --project "$PROJECT_ID" --data-file=- >/dev/null
  echo "== Cloud Run に反映中（新リビジョン作成）"
  gcloud run services update "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
    --update-env-vars "KEYS_UPDATED_AT=$(date +%s)" --quiet >/dev/null
  # 旧バージョン（無効化・削除したキーを含む）を無効化
  for v in $OLD; do gcloud secrets versions disable "$v" --secret "$SECRET" --project "$PROJECT_ID" --quiet >/dev/null; done
  echo "== 反映しました"
}

case "$CMD" in
  list)
    entries | awk -F: '{k=$2; printf "%-24s %s…%s\n", $1, substr(k,1,8), substr(k,length(k)-3)}' ;;
  show)
    need_name; entries | awk -F: -v n="$NAME" '$1==n{print $2}' ;;
  add)
    need_name; has && { echo "$NAME は既にあります（作り直すなら rotate）"; exit 1; }
    KEY="amp_$(openssl rand -hex 24)"
    save_and_apply "$(entries)"$'\n'"$NAME:$KEY"
    echo "$NAME のキー: $KEY" ;;
  rotate)
    need_name; has || { echo "$NAME はありません"; exit 1; }
    KEY="amp_$(openssl rand -hex 24)"
    save_and_apply "$(entries | awk -F: -v n="$NAME" '$1!=n')"$'\n'"$NAME:$KEY"
    echo "$NAME の新しいキー: $KEY" ;;
  revoke)
    need_name; has || { echo "$NAME はありません"; exit 1; }
    save_and_apply "$(entries | awk -F: -v n="$NAME" '$1!=n')"
    echo "$NAME のキーを無効にしました" ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
