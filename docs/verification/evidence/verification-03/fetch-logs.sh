#!/usr/bin/env bash
# Usage: CF_ACCOUNT_ID=... CF_API_TOKEN_FILE=... fetch-logs.sh <from-ms> <to-ms> > events.jsonl
# Needs a token with "Workers Observability Write". Prints one structured log line per row,
# oldest first: the fields of the JSON log line plus "t" (ms) and "service".
# Workers Logs sometimes splits one long line into two rows; those come out as two "message"
# rows that cannot be rejoined reliably.
set -euo pipefail
from=$1
to=$2
limit=2000
body=$(jq -n --argjson from "$from" --argjson to "$to" --argjson limit "$limit" \
  '{queryId: "adhoc", dry: true, view: "events", limit: $limit,
    timeframe: {from: $from, to: $to}, parameters: {}}')
headers=$(mktemp)
trap 'rm -f "$headers"' EXIT
printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$(cat "$CF_API_TOKEN_FILE")" >"$headers"
if ! response=$(curl -sS --fail-with-body -X POST -H @"$headers" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/observability/telemetry/query" \
  -d "$body"); then
  echo "$response" >&2
  exit 1
fi
if [ "$(jq -r '.success' <<<"$response")" != "true" ]; then
  jq -c '.errors' <<<"$response" >&2
  exit 1
fi
count=$(jq '.result.events.events | length' <<<"$response")
if [ "$count" -ge "$limit" ]; then
  echo "hit the $limit-row limit; narrow the time range" >&2
  exit 1
fi
jq -c '.result.events.events[]
  | (.source | if type == "object" then . else {message: .} end)
    + {t: .timestamp, service: .["$metadata"].service}' \
  <<<"$response" | jq -s -c 'sort_by(.t)[]'
