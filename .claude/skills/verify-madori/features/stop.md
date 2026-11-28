# 指示を止める

利用者は、待機中の指示も実行中の指示も、同じ操作で止められる。止めた指示から案は増えず、今の案はそのまま残る。仕事が先に終わっていたら、停止はその完了と確定した案を返し、案は残る。同じ停止を送り直すと、同じ答えが返る。実行中の指示を止めたときに待機中の指示があれば、待機列は保留になり、利用者が再開か取り消しを選ぶまで次の指示は動かない（[待機列の保留](./queue-hold.md)）。待機中の指示を止めても保留にはならない。

## Sub-features

- `stop-queued`：待機中の指示を止めると、`200` と `outcome: stopped` が返り、その指示は動かない。
- `stop-running`：待たせている実行中の指示を止めると `stopped` が返り、案は増えない。
- `stop-finished`：終わった指示を止めると `already_finished` が返る。完了していれば確定した案も返る。
- `stop-replay`：同じ `requestId` で送り直すと、同じ本文が返る。
- `stop-missing`：存在しない仕事は `404` になる。

## How to get to it (user POV)

- 案件画面では、状態の欄の `止める` で実行中の指示を止める（[指示の状態と操作](./status.md)）。待機中の指示を一件ずつ止める操作は、画面にはまだ無い（#243）。API では、停止は `POST /api/jobs/<jobId>/stop` に `{"requestId":"<uuid>"}` を送る。`jobId` は受付の応答の `job.jobId`。結果は停止の応答で読む。実行中に止めた指示は、`GET /api/patterns/<id>/state` の `lastFinishedJob` にも出る。待機中に止めた指示は実行していないので、`lastFinishedJob` に出ない。

## Driving it with curl

Preconditions:

- 「終わった後に止める」には Container が必要。ほかの手順は、案の無いパターンなら Container を無効にしても確かめられる。Container を無効にして起動したら、[案件](./projects.md)の「作る」をもう一度行い、`PAT` を案の無い新しいパターンにする。案のあるパターンの仕事は、開始の段階で Container に案の要約を求めるので、Container が無いと待ちに入る前に失敗し、「実行中を止める」時間が無い（[指示を送る](./instructions.md)の Gotchas）。
- SKILL.md の「起動」の `pnpm dev` を、`MADORI_DEV_JOB_TEST_HOLD=first_answer:30` を付けて起動している。仕事は実行権を取り、台本のAIの最初の応答を受け取った後、住宅を変える前に30秒待つ。待ちを付けずに動いていたら、片付けてから、SKILL.md の「起動」の三行を、`perl` の行の先頭に `MADORI_DEV_JOB_TEST_HOLD=first_answer:30 ` を足して実行し直す。`dev.pgid` を書く行も実行する。抜くと、片付けが前のプロセスグループを指したままになる。
- [案件](./projects.md)の「作る」を済ませ、`PAT=$(jq -r .pattern.id "$EVIDENCE/projects/create.json")` を設定している。
- `. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`J='content-type: application/json'` と `D="$EVIDENCE/stop"` を設定し、`$D` がある。
- 送る関数 `send() { curl -sS -o "$D/${1}.json" -w '%{http_code}\n' -X POST "$API/patterns/$PAT/messages" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"body\":\"${2}\"}"; }`、止める関数 `stop() { curl -sS -o "$D/${1}.json" -w '%{http_code}\n' -X POST "$API/jobs/${2}/stop" -H "$J" -H "$O" -d "{\"requestId\":\"${3}\"}"; }`、状態を読む関数 `state() { curl -sS -o "$D/${1}.json" "$API/patterns/$PAT/state"; }` を定義している。
- [指示を送る](./instructions.md)の `settle` を、出力先を `$D` にして定義している。

- **二つ送る。** `send accept-a 台所を広くしたい` と `send accept-b 窓を大きくしたい`。どちらも `202`。`A=$(jq -r .job.jobId "$D/accept-a.json")` と `B=$(jq -r .job.jobId "$D/accept-b.json")` を設定する。`state state-0` の `runningJob.jobId` が `$A`、`queuedJobs[0].jobId` が `$B`。A がまだ待機中なら、1秒おいて読み直す。
- **待機中を止める。** `RB=$(uuidgen)` で `stop stop-b "$B" "$RB"`。`200` で、`outcome` が `stopped`、`job.state` が `cancelled`。`state state-1` の `queuedJobs` が `[]`、`lastFinishedJob` が `state-0` と同じ（実行していない B を指さない）、`runningJob.jobId` は `$A` のまま、`queueHold` が `null`。
- **送り直す。** `stop stop-b-replay "$B" "$RB"`。`200` で、`cmp "$D/stop-b.json" "$D/stop-b-replay.json"` が何も出さない。
- **実行中を止める。** A の30秒の待ちの内に `stop stop-a "$A" "$(uuidgen)"`。`200` で、`outcome` が `stopped`、`job.state` が `cancelled`。`state state-2` の `runningJob` が `null`、`currentRevision` が `state-0` と同じ。`lastFinishedJob.jobId` が `$A` で `lastFinishedJob.state` が `cancelled`。番号の大きい `$B` は実行していないので指さない。待機中の指示が無いので、`queueHold` は `null`。`stop stop-a-again "$A" "$(uuidgen)"` は `200` で、`outcome` が `already_finished`、`job.state` が `cancelled`。待ちが終わった後、`$EVIDENCE/dev.log` の A の `job.finished` に `"outcome":"cancelled"` が出る。`GET /api/patterns/$PAT/revisions` の件数は送る前と同じ。
- **終わった後に止める。** `send accept-c 収納を増やしたい` で `C=$(jq -r .job.jobId "$D/accept-c.json")` を設定し、`settle state-3` で終わるまで待つ（30秒の待ちを含む）。`stop stop-c "$C" "$(uuidgen)"`。`200` で、`outcome` が `already_finished`、`job.state` が `completed`、`job.revision.id` が `state-3` の `currentRevision.id`。案の一覧は送る前より一件多いまま。
- **存在しない仕事。** `stop missing 00000000-0000-4000-8000-000000000000 "$(uuidgen)"`。`404` で、本文が `{"error":"not_found"}`。

## Gotchas

- 待ちを付けずに起動すると、台本のAIの仕事は数秒で終わる。実行中の停止は確定と競い、`already_finished` と `completed` が返ることがある。誤りではなく、確定が先だったという答えである。
- 待ちは手元のすべての仕事に掛かる。止めていない仕事も、最初の応答の後に30秒待つ。
- 止めた仕事の Workflow は、待ちが終わるまで残る。その間にも、保留していない待機列の次の指示や、再開した指示は動き出す。止めた仕事の `job.finished` は、待ちが終わってから出る。
- 保留にならなかった場合は待機列が進むので、次の仕事が実行されて終わると `lastFinishedJob` はその仕事に置き換わる。停止の直後に state を読む。
- `lastFinishedJob` は、実行した仕事のうち、終わったもので受付の番号が最も大きいものを指す。待機中に止めた B は実行していないので、A より番号が大きくても指さない。
- 別の利用者の仕事は `404` になる。確かめるには、SKILL.md のとおり片付けてから `MADORI_DEV_EMAIL=other@example.com` を付けて起動し直す。
