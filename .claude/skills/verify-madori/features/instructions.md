# 指示を送る

利用者は、パターンに文章で指示を送る。Worker は指示を受け付けて番号を振り、仕事として待ち行列に入れる。同じ指示を送り直しても、二つ目の仕事はできない。

## Sub-features

- `instruction-accept`：受け付けると `202` と仕事の番号が返る。
- `instruction-replay`：同じ `requestId` と本文を送り直すと、同じ仕事が返る。
- `instruction-queue`：パターンの状態の `queuedJobs` に、仕事が並ぶ。
- `instruction-invalid`：空白だけの本文は拒まれる。
- `instruction-revisions`：パターンの案の一覧を読む。

## How to get to it (user POV)

- 画面はまだ無い。`POST /api/patterns/<id>/messages`、`GET /api/patterns/<id>/state`、`GET /api/patterns/<id>/revisions` を使う。

## Driving it with curl

Preconditions:

- [案件](./projects.md)の「作る」を済ませ、`PAT=$(jq -r .pattern.id "$EVIDENCE/projects/create.json")` を設定している。
- `J='content-type: application/json'` と `O='origin: http://127.0.0.1:5173'` を設定している。
- `API=http://127.0.0.1:5173/api` と `D="$EVIDENCE/instructions"` を設定し、`$D` がある。

- **送る。** `RID=$(uuidgen)` で `curl -sS -o "$D/accept.json" -w '%{http_code}\n' -X POST "$API/patterns/$PAT/messages" -H "$J" -H "$O" -d "{\"requestId\":\"$RID\",\"body\":\"南向きの居間を広くしたい\"}"`。`202` で、`job.number` が `1`。
- **送り直す。** 同じ `RID` と本文で、出力先を `"$D/replay.json"` にして送る。`202` で、`job.jobId` が `accept.json` と同じ。
- **待ち行列。** `curl -sS -o "$D/state.json" -w '%{http_code}\n' "$API/patterns/$PAT/state"`。`200` で、`queuedJobs[0].jobId` が送った仕事、`currentRevision` が `null`。
- **空白だけの本文。** 新しい `requestId` で `"body":"   "` を送り、出力先を `"$D/blank.json"` にする。`400` で、本文が `{"error":"invalid_request"}`。
- **案の一覧。** `curl -sS -o "$D/revisions.json" -w '%{http_code}\n' "$API/patterns/$PAT/revisions"`。`200` で、本文が `{"revisions":[],"nextCursor":null}`。

## Gotchas

- 受け付けた仕事を実行して案を作る処理は、まだ要求の経路につながっていない。仕事は待ち行列に残り、案の一覧は空のまま。案を開く `GET /api/revisions/<id>/view` は、今は利用者の経路から届かない。
- 本文は UTF-8 で 16384 バイトまで。
