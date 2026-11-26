# 指示を送る

利用者は、パターンに文章で指示を送る。Worker は指示を受け付けて番号を振り、仕事として待ち行列に入れる。仕事は画面を閉じても進み、受け付けた順に一件ずつ動く。今はAIを使わず、仕事が一件終わるごとに、固定のサンプルの形を表示データに持つ案「サンプルの形」が一件増える。同じ指示を送り直しても、二つ目の仕事はできない。

## Sub-features

- `instruction-accept`：受け付けると `202` と仕事の番号が返る。
- `instruction-replay`：同じ `requestId` と本文を送り直すと、同じ仕事が返る。
- `instruction-run`：仕事が終わると、パターンの状態の `runningJob` と `queuedJobs` が空になり、今の案が「サンプルの形」になり、`lastFinishedJob` がその仕事になる。
- `instruction-view`：できた案を開くと、サンプルの表示データが返る。
- `instruction-chain`：二つ目の指示の案は、一つ目の案を編集元に持つ。仕事一件につき案は一件。
- `instruction-invalid`：空白だけの本文は拒まれる。
- `instruction-attach`：自分の資産の ID を `attachmentIds` に並べて送ると `202`。会話の行の `attachmentIds` が、送った順に小文字の資産 ID を返す。受付の応答と `state` のジョブは添付を持たない。
- `instruction-attach-replay`：同じ `requestId`・本文・添付で送り直すと同じ仕事が返り、添付の行は増えない。同じ `requestId` で添付の順を変えると `422` で `request_id_reused`。
- `instruction-attach-limit`：4枚の添付と、同じ資産 ID の重複は `400` で `invalid_request`。
- `instruction-attach-unavailable`：他人の資産と存在しない資産は、どちらも `422` で、本文が同じ `{"error":"attachment_unavailable"}`。他人のパターンへ送ると、添付によらず `404` で `not_found`。どの拒否でも、会話・仕事・添付・要求の行は増えない。

## How to get to it (user POV)

- 画面からはまだ指示を送れず、画像も添えられない。送った指示の進み具合と確定した案は、案件画面に出る（[案件画面で案を見る](./project-view.md)）。この機能の手順では、`POST /api/patterns/<id>/messages`、`GET /api/patterns/<id>/state`、`GET /api/patterns/<id>/revisions`、`GET /api/revisions/<id>/view` を使う。

## Driving it with curl

Preconditions:

- Container が必要。
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

添付を確かめる手順は、上の手順と同じ回のパターン `$PAT` を使い、Bash の呼び出しごとに次の三つを定義する。

- 画像を登録する関数。`up() { curl -sS -o "$D/${1}.json" -w '%{http_code}\n' -X POST "$API/assets?requestId=$(uuidgen)" -H "$O" -H 'content-type: image/png' -H 'Expect:' --data-binary @"$D/sample.png"; }`
- 添えて送る関数。`attach() { curl -sS -o "$D/${1}.json" -w '%{http_code}\n' -X POST "$API/patterns/${4:-$PAT}/messages" -H "$J" -H "$O" -d "{\"requestId\":\"${2}\",\"body\":\"この写真のような居間にしたい\",\"attachmentIds\":${3}}"; }`
- 行の数を読む関数。`rows() { (cd apps/worker || exit 1; mise exec -- pnpm exec wrangler d1 execute DB --local --json --command "SELECT (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM jobs) AS jobs, (SELECT count(*) FROM message_attachments) AS attachments, (SELECT count(*) FROM requests) AS requests") | jq -c '.[0].results[0]'; }`

- **画像を四枚登録する。** `command cp -f docs/verification/evidence/verification-01/02-customized-3d.png "$D/sample.png"` の後、`for i in 1 2 3 4; do up "asset-$i"; done`。四つとも `201`。`for i in 1 2 3 4; do jq -r .asset.id "$D/asset-$i.json"; done >| "$D/asset-ids.txt"` で ID を控え、以後は `A1=$(sed -n 1p "$D/asset-ids.txt")` のように `A1`〜`A4` を読む。
- **添えて送る。** `ARID=$(uuidgen); echo "$ARID" >| "$D/attach-rid.txt"` と、大文字にした二枚の ID を逆の順に並べた `printf '["%s","%s"]' "$(echo "$A2" | tr a-f A-F)" "$(echo "$A1" | tr a-f A-F)" >| "$D/attach-ids.json"` を控える。以後は `ARID=$(cat "$D/attach-rid.txt")` で読む。`attach attach "$ARID" "$(cat "$D/attach-ids.json")"`。`202`。`settle state-attach` が成功する。`jq -e '[.runningJob, .lastFinishedJob, .queuedJobs[]] | map(select(. != null) | has("attachmentIds")) | any | not' "$D/state-attach.json"` が `true`。
- **会話で読み直す。** `curl -sS -o "$D/attach-messages.json" -w '%{http_code}\n' "$API/patterns/$PAT/messages"`。`200` で、`jq -e --arg id "$(jq -r .job.messageId "$D/attach.json")" --arg a1 "$A1" --arg a2 "$A2" '[.messages[] | select(.id == $id) | .attachmentIds] == [[$a2, $a1]]' "$D/attach-messages.json"` が `true`。添付の無い行の `attachmentIds` は `[]`。
- **送り直す。** `rows >| "$D/rows-before.json"` の後、`attach attach-replay "$ARID" "$(cat "$D/attach-ids.json")"`。`202` で、`cmp "$D/attach.json" "$D/attach-replay.json"` と `rows | cmp - "$D/rows-before.json"` が何も出さない。
- **順を変えて送り直す。** `attach attach-reorder "$ARID" "[\"$A1\",\"$A2\"]"`。`422` で、本文が `{"error":"request_id_reused"}`。
- **四枚と重複。** `attach four "$(uuidgen)" "[\"$A1\",\"$A2\",\"$A3\",\"$A4\"]"` と `attach repeated "$(uuidgen)" "[\"$A1\",\"$A1\"]"`。どちらも `400` で、本文が `{"error":"invalid_request"}`。`rows | cmp - "$D/rows-before.json"` が何も出さない。
- **存在しない資産。** `attach missing-asset "$(uuidgen)" "[\"$(uuidgen | tr A-F a-f)\"]"`。`422` で、本文が `{"error":"attachment_unavailable"}`。`rows | cmp - "$D/rows-before.json"` が何も出さない。
- **他人の資産。** [SKILL.md の「片付け」](../SKILL.md#片付け)で止め、`MADORI_DEV_EMAIL=other@example.com` を付けて起動し直し、起動の確認で `dev.env` を作り直す（[本人確認](./sign-in.md)の「別の利用者」）。この利用者の「起動確認」の案件のパターンを `OPAT=$(curl -fsS "$API/projects/$(curl -fsS "$API/projects" | jq -r '.projects[0].id')/patterns" | jq -r '.patterns[0].id')` で読む。`rows >| "$D/rows-other.json"` の後、前の利用者の資産 `A1` を添えて `attach foreign-asset "$(uuidgen)" "[\"$A1\"]" "$OPAT"` を送る。`422` で、`cmp "$D/missing-asset.json" "$D/foreign-asset.json"` が何も出さない。前の利用者のパターンへ `attach foreign-pattern "$(uuidgen)" "[\"$A1\"]"` を送ると `404` で、本文が `{"error":"not_found"}`。どちらの後も `rows | cmp - "$D/rows-other.json"` が何も出さない。

## Gotchas

- 新しいパターンの最初の仕事は、そのパターン用の Container を冷えた状態から起こす。手元ではイメージがビルド済みなら数秒で終わるが、新しいイメージの最初の起動は1分近くかかることがあるので、`settle` は5分まで待つ。二つ目からは、休止時間（10分）の内なら同じ Container を使う。
- [SKILL.md の「起動」](../SKILL.md#起動) の手順で `MADORI_DEV_CONTAINERS=0` を付けると、仕事は再試行せずに失敗する。案は増えず、`currentRevision` は前のまま。`$EVIDENCE/dev.log` の `job.finished` の行に `"reason":"containers_disabled"` が出る。失敗したときに待機中の指示があれば、待機列は保留になり、後の指示は動かない（[待機列の保留](./queue-hold.md)）。
- 仕事の状態は `state` の `runningJob`・`queuedJobs`・`lastFinishedJob` が見せる。`lastFinishedJob` は、実行した仕事のうち、終わったもので番号が最も大きいもので、次に実行した仕事が終わると置き換わる。待機中に止めた仕事と取り消した仕事は指さない。受付の応答の `job` は受付の記録で、仕事が終わった後に送り直しても変わらない。
- 仕事を止める手順は[指示を止める](./stop.md)にある。
- 本文は UTF-8 で 16384 バイトまで。
- 添付は一つの指示に3枚まで。資産は先に[画像を登録する](./assets.md)の経路で作る。他人の資産は、他人として起動し直さないと作れない。
- 添付の拒否が何も書かないことは、`rows` の数で確かめる。拒否の後も、同じ `requestId` は直した内容で使える。
- `rows` は `pnpm dev` を動かしたまま読める。数える前に `settle` で仕事を終わらせておく。終わる途中の仕事が行を書くと、数がずれる。
