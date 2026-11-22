# 指示を送る

利用者は、パターンに文章で指示を送る。Worker は指示を受け付けて番号を振り、仕事として待ち行列に入れる。仕事は画面を閉じても進み、受け付けた順に一件ずつ動く。今はAIを使わず、仕事が一件終わるごとに、固定のサンプルの形を表示データに持つ案「サンプルの形」が一件増える。同じ指示を送り直しても、二つ目の仕事はできない。

## Sub-features

- `instruction-accept`：受け付けると `202` と仕事の番号が返る。
- `instruction-replay`：同じ `requestId` と本文を送り直すと、同じ仕事が返る。
- `instruction-run`：仕事が終わると、パターンの状態の `runningJob` と `queuedJobs` が空になり、今の案が「サンプルの形」になり、`lastFinishedJob` がその仕事になる。
- `instruction-view`：できた案を開くと、サンプルの表示データが返る。
- `instruction-chain`：二つ目の指示の案は、一つ目の案を編集元に持つ。仕事一件につき案は一件。
- `instruction-invalid`：空白だけの本文は拒まれる。

## How to get to it (user POV)

- 画面は、開発用の案件に指示を一件送り、確定した案を描く（[サンプルの住宅モデルを見る](./sample-view.md)）。この機能の手順では、`POST /api/patterns/<id>/messages`、`GET /api/patterns/<id>/state`、`GET /api/patterns/<id>/revisions`、`GET /api/revisions/<id>/view` を使う。

## Driving it with curl

Preconditions:

- SKILL.md の手順で、Container を有効にしたまま `pnpm dev` を起動している。
- [案件](./projects.md)の「作る」を済ませ、`PAT=$(jq -r .pattern.id "$EVIDENCE/projects/create.json")` を設定している。
- `. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`J='content-type: application/json'` と `D="$EVIDENCE/instructions"` を設定し、`$D` がある。
- 終わるまで待つ関数を定義している。`settle() { for i in $(seq 1 60); do curl -sS -o "$D/${1}.json" "$API/patterns/$PAT/state"; jq -e '.runningJob == null and (.queuedJobs | length) == 0' "$D/${1}.json" >/dev/null && return 0; sleep 5; done; return 1; }`

- **送る。** `RID=$(uuidgen)` で `curl -sS -o "$D/accept.json" -w '%{http_code}\n' -X POST "$API/patterns/$PAT/messages" -H "$J" -H "$O" -d "{\"requestId\":\"$RID\",\"body\":\"南向きの居間を広くしたい\"}"`。`202` で、`job.number` が `1`。
- **送り直す。** 同じ `RID` と本文で、出力先を `"$D/replay.json"` にして送る。`202` で、`job.jobId` が `accept.json` と同じ。
- **終わるまで待つ。** `settle state-1` が成功する。`$D/state-1.json` の `currentRevision.name` が `サンプルの形`、`currentRevision.baseRevisionId` が `null`、`lastFinishedJob.state` が `completed` で `lastFinishedJob.revision.id` が `currentRevision.id` と同じ。`REV1=$(jq -r .currentRevision.id "$D/state-1.json")` を設定する。
- **案を開く。** `curl -sS -o "$D/view-1.bin" -D "$D/view-1.headers" -w '%{http_code} %{content_type}\n' "$API/revisions/$REV1/view"`。`200 application/vnd.madori.display; version=1` で、`$D/view-1.headers` の `x-revision-id` が `$REV1`。
- **二つ目を送る。** 新しい `requestId` と本文 `窓を大きくしたい` で、出力先を `"$D/accept-2.json"` にして送る。`202` で、`job.number` が `2`。`settle state-2` が成功し、`$D/state-2.json` の `currentRevision.number` が `2`、`currentRevision.baseRevisionId` が `$REV1`。
- **案の一覧。** `curl -sS -o "$D/revisions.json" -w '%{http_code}\n' "$API/patterns/$PAT/revisions"`。`200` で、`revisions` が二件。番号は `2`、`1` の順で、どちらの `name` も `サンプルの形`。`nextCursor` が `null`。
- **空白だけの本文。** 新しい `requestId` で `"body":"   "` を送り、出力先を `"$D/blank.json"` にする。`400` で、本文が `{"error":"invalid_request"}`。

## Gotchas

- 新しいパターンの最初の仕事は、そのパターン用の Container を冷えた状態から起こす。手元ではイメージがビルド済みなら数秒で終わるが、新しいイメージの最初の起動は1分近くかかることがあるので、`settle` は5分まで待つ。二つ目からは、休止時間（10分）の内なら同じ Container を使う。
- `MADORI_DEV_CONTAINERS=0 pnpm dev` で起動すると、仕事は再試行せずに失敗する。案は増えず、`currentRevision` は前のまま。`$EVIDENCE/dev.log` の `job.finished` の行に `"reason":"containers_disabled"` が出る。失敗したときに待機中の指示があれば、待機列は保留になり、後の指示は動かない（[待機列の保留](./queue-hold.md)）。
- 仕事の状態は `state` の `runningJob`・`queuedJobs`・`lastFinishedJob` が見せる。`lastFinishedJob` は、終わった仕事のうち番号が最も大きいもので、次の仕事が終わると置き換わる。受付の応答の `job` は受付の記録で、仕事が終わった後に送り直しても変わらない。
- 仕事を止める手順は[指示を止める](./stop.md)にある。
- 本文は UTF-8 で 16384 バイトまで。
