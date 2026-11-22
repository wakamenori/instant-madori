# 待機列の保留

実行中の指示が停止や失敗で終わったときに待機中の指示があれば、パターンの待機列は保留になる。保留中は待機中の指示も、保留中に送った指示も動かない。利用者は、保留の原因の指示を添えて再開か取り消しを選ぶ。再開すると待機中の指示が受付順に動き、取り消すと待機中の指示がすべて止まって保留が解ける。待機中の指示が無ければ保留にならず、次に送った指示はすぐに動く。

## Sub-features

- `hold-stop`：実行中の指示を止めたときに待機中の指示があると、state の `queueHold` が止めた指示を示し、待機中の指示は動かない。
- `hold-while-held`：保留中に送った指示は受け付けられ、待機列の最後で待つ。
- `hold-resume`：`heldBy` を添えて再開すると、`200` と待機中の指示が返り、指示が受付順に動いて案が増える。
- `hold-cancel`：取り消すと、保留中に送った指示も含めて待機中の指示がすべて `cancelled` になり、保留が解ける。
- `hold-replay`：同じ `requestId` で送り直すと、同じ本文が返る。
- `hold-stale`：今の保留の原因ではない `heldBy` は `409` になる。
- `hold-release`：保留中に最後の待機中の指示を止めると、保留が解ける。
- `hold-missing`：存在しないパターンは `404` になる。

## How to get to it (user POV)

- 画面には再開と取り消しの操作がまだ無い。案件画面は、保留を `待機中の指示（N件）が保留されています。` と表示する（[案件画面で案を見る](./project-view.md)）。保留は `GET /api/patterns/<id>/state` の `queueHold`（`{ job: { jobId, messageId, number, state } }` か `null`）で読む。再開は `POST /api/patterns/<id>/queue/resume`、取り消しは `POST /api/patterns/<id>/queue/cancel` に、`{"requestId":"<uuid>","heldBy":"<queueHold.job.jobId>"}` を送る。

## Driving it with curl

Preconditions:

- 再開した指示や待機中の指示が完了することを確かめるには Container が必要。
- SKILL.md の「起動」の `pnpm dev` を、`MADORI_DEV_JOB_TEST_HOLD=before_render:30` を付けて起動している。起動し直し方は[指示を止める](./stop.md)の Preconditions にある。
- [案件](./projects.md)の「作る」を済ませ、`PAT=$(jq -r .pattern.id "$EVIDENCE/projects/create.json")` を設定している。
- `. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`J='content-type: application/json'` と `D="$EVIDENCE/queue-hold"` を設定し、`$D` がある。
- [指示を止める](./stop.md)の `send`・`stop`・`state` を、出力先を `$D` にして定義している。
- 再開と取り消しの関数 `release() { curl -sS -o "$D/${1}.json" -w '%{http_code}\n' -X POST "$API/patterns/$PAT/queue/${2}" -H "$J" -H "$O" -d "{\"requestId\":\"${3}\",\"heldBy\":\"${4}\"}"; }` を定義している。`${2}` は `resume` か `cancel`。
- [指示を送る](./instructions.md)の `settle` を、出力先を `$D` にして定義している。
- 案の件数を数える関数 `revisions() { curl -sS "$API/patterns/$PAT/revisions" | jq '.revisions | length'; }` を定義している。

- **二つ送る。** `R0=$(revisions)` を設定する。`send accept-a 台所を広くしたい` と `send accept-b 窓を大きくしたい`。どちらも `202`。`A=$(jq -r .job.jobId "$D/accept-a.json")` と `B=$(jq -r .job.jobId "$D/accept-b.json")` を設定する。`state state-0` の `runningJob.jobId` が `$A`、`queuedJobs[0].jobId` が `$B`。A がまだ待機中なら、1秒おいて読み直す。
- **実行中を止めて保留にする。** A の30秒の待ちの内に `stop stop-a "$A" "$(uuidgen)"`。`200` で、`outcome` が `stopped`。`state hold-1` の `runningJob` が `null`、`queuedJobs` が B の一件、`queueHold.job.jobId` が `$A` で `queueHold.job.state` が `cancelled`。`grep '"event":"pattern.advanced"' "$EVIDENCE/dev.log" | grep "\"heldBy\":\"$A\""` に `"outcome":"queue_held"` の行が出る。
- **保留中に送る。** `send accept-c 収納を増やしたい` で `202`。`C=$(jq -r .job.jobId "$D/accept-c.json")` を設定する。10秒おいて `state hold-2`。`runningJob` が `null`、`queuedJobs` が B、C の順、`queueHold.job.jobId` が `$A` のまま。`grep "\"jobId\":\"$B\"" "$EVIDENCE/dev.log" | grep '"event":"job.step"'` は何も出さない。
- **古い保留で再開する。** `release resume-stale resume "$(uuidgen)" "$B"`。`409` で、本文が `{"error":"version_conflict"}`。`state hold-3` は `hold-2` と同じ。
- **再開する。** `RR=$(uuidgen)` で `release resume resume "$RR" "$A"`。`200` で、`jobs` が B、C の順に `{ jobId, messageId, number }` で並ぶ。`release resume-replay resume "$RR" "$A"` は `200` で、`cmp "$D/resume.json" "$D/resume-replay.json"` が何も出さない。`release resume-again resume "$(uuidgen)" "$A"` は `409`。`state resumed-1` の `runningJob.jobId` が `$B` で、`queueHold` が `null`。`settle resumed-2` で終わるまで待つ（B と C のそれぞれに30秒の待ちを含む）。`revisions` が `R0 + 2`。`dev.log` の `api.request` の行に、`"queue":"applied"` と `"queue":"replayed"` が一行ずつ出る。
- **取り消す。** `send accept-d 玄関を広くしたい` と `send accept-e 和室を足したい`。`D1=$(jq -r .job.jobId "$D/accept-d.json")` と `E=$(jq -r .job.jobId "$D/accept-e.json")` を設定し、`runningJob.jobId` が `$D1` になるのを待つ。`stop stop-d "$D1" "$(uuidgen)"` の後に `send accept-f 階段を緩くしたい`、`F=$(jq -r .job.jobId "$D/accept-f.json")`。`R1=$(revisions)` を設定する。`RC=$(uuidgen)` で `release cancel cancel "$RC" "$D1"`。`200` で、`jobs` が E、F の順で、どちらも `state` が `cancelled`。`release cancel-replay cancel "$RC" "$D1"` は `200` で、`cmp "$D/cancel.json" "$D/cancel-replay.json"` が何も出さない。`state cancelled-1` の `queuedJobs` が `[]`、`queueHold` が `null`、`runningJob` が `null`。`revisions` が `R1` のまま。
- **取り消しの後に送る。** `send accept-g 窓を減らしたい` で `202`。`state after-cancel` の `runningJob.jobId` が G の `jobId` になる（遅ければ1秒おいて読み直す）。`settle after-cancel-2` で終わるまで待つ。
- **最後の待機中の指示を止めて保留を解く。** `send accept-h 書斎を作りたい` と `send accept-i 物置を作りたい`。`H` と `I` を設定し、`runningJob.jobId` が `$H` になるのを待つ。`stop stop-h "$H" "$(uuidgen)"` の後、`state release-1` の `queueHold.job.jobId` が `$H`。`stop stop-i "$I" "$(uuidgen)"` は `200` で、`state release-2` の `queuedJobs` が `[]`、`queueHold` が `null`。続けて `send accept-j 庭を広くしたい` で送った指示は、すぐ `runningJob` になる。`settle release-3` で終わるまで待つ（30秒の待ちを含む）。動いたまま片付けると、J は起動し直しても `running` のまま残り、このパターンを使うほかの機能の手順が進まない（SKILL.md の「片付け」）。
- **存在しないパターン。** `curl -sS -o "$D/missing.json" -w '%{http_code}\n' -X POST "$API/patterns/00000000-0000-4000-8000-000000000000/queue/resume" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"heldBy\":\"$A\"}"`。`404` で、本文が `{"error":"not_found"}`。

## Gotchas

- 保留は実行中の指示が終わったときだけ決まる。待機中の指示を止めても保留にならない（[指示を止める](./stop.md)の「待機中を止める」）。実行中の指示が止まったときに待機中の指示が無ければ、保留にならない。
- 失敗での保留を見るには、片付けてから [SKILL.md の「起動」](../SKILL.md#起動) の手順で `MADORI_DEV_CONTAINERS=0` と `MADORI_DEV_JOB_TEST_HOLD=before_render:30` を付けて起動し直し、「二つ送る」を行う。A は待ちの後に失敗し、`queueHold.job.state` が `failed` になる。再開した B も失敗し、そのときに待機中の指示が無ければ保留にならない。
- 止めた A の Workflow は、待ちが終わるまで残る。再開した B が A の `job.finished` より先に動き出すのは誤りではない。
- 再開の `409` は、保留が解けたか、別の指示の停止・失敗で保留し直したことを示す。state を読み直し、今の `queueHold.job.jobId` で送り直す。
- 保留中は、待ちを付けた仕事も含めて何も動かない。`settle` は保留中に終わらないので、再開か取り消しの後に使う。
- 別の利用者のパターンは `404` になる。確かめるには、SKILL.md のとおり片付けてから `MADORI_DEV_EMAIL=other@example.com` を付けて起動し直す。
