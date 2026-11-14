#!/usr/bin/env bash
# Usage: CF_ACCOUNT_ID=... CF_API_TOKEN_FILE=... force-cold.sh <instance-type>   (run from apps/worker)
# Sets env.staging GEOMETRY_INSTANCE_TYPE, redeploys, and waits until Workers Logs shows that
# the last started container has exited, so the next request starts one cold. `wrangler
# containers list` is not used: it reported no live instance while a container still served.
# Exits are not tied to an instance in the logs, so this assumes one container at a time.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
type=$1
python3 - "$type" <<'PY'
import re, sys
path = "wrangler.jsonc"
text = open(path).read()
head, tail = text.split('"staging"', 1)
tail, n = re.subn(r'"GEOMETRY_INSTANCE_TYPE": "[^"]+"', f'"GEOMETRY_INSTANCE_TYPE": "{sys.argv[1]}"', tail, count=1)
assert n == 1
open(path, "w").write(head + '"staging"' + tail)
PY
if ! deploy_log=$(pnpm exec wrangler deploy --env staging 2>&1); then
  echo "$deploy_log" >&2
  exit 1
fi
grep -E "GEOMETRY_INSTANCE_TYPE|Version ID" <<<"$deploy_log" || true
for _ in $(seq 1 120); do
  now=$(($(date +%s) * 1000))
  last=$("$here/fetch-logs.sh" $((now - 3 * 3600000)) "$now" \
    | jq -r 'select(.event == "container.started" or ((.message // "") | tostring | startswith("Container exited"))) | .event // "exited"' \
    | tail -1)
  if [ "$last" = "exited" ]; then
    echo "last container exited; checked at $(date -u +%H:%M:%S)"
    exit 0
  fi
  sleep 15
done
echo "container did not exit within 30 minutes" >&2
exit 1
