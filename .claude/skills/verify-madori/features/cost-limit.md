# AI費用の上限

AIの費用が一指示の上限（5米ドル）か、サービス全体の今月の上限（100米ドル、UTCの暦月）に達すると、指示は上限到達（`limited`）で終わる。未確定の変更は採用されず、案は最後に確定したもののまま残る。会話には指示がそのまま残り、上限の種類を伝えるお知らせが続く。待機中の指示があれば待機列は保留になり、利用者が再開か取り消しを選ぶ（[待機列の保留](./queue-hold.md)）。今月の残りが次のAIの一往復に足りなければ、指示は受け付けられ、AIを呼ばずに上限到達で終わる。

## Sub-features

- `limit-monthly`：今月の残りが足りないと、送った指示は `limited` で終わり、案は増えない。
- `limit-notice`：会話の指示の後に、今月の上限に達したことを伝えるお知らせが、その指示の `jobId` で入る。案件画面にも「お知らせ」として出る。
- `limit-hold`：上限到達で終わったときに待機中の指示があれば、state の `queueHold.job.state` が `limited` になる。
- `limit-stop`：上限到達で終わった指示を止めると、`200` と `already_finished`、`job.state` が `limited` で返る。
- `limit-last`：state の `lastFinishedJob.state` が `limited` になる。

## How to get to it (user POV)

- 利用者は、案件画面の指示欄か `POST /api/patterns/<id>/messages` で指示を送る（[指示を送る](./instructions.md)）。上限到達の結果は、`GET /api/patterns/<id>/state` の `lastFinishedJob` と `queueHold`、`GET /api/patterns/<id>/messages` のお知らせ、案件画面の会話で読む。案件画面の状態の欄は、待機中の指示があれば `上限に達して指示を終了したため、待機中の指示（N件）を保留しています。` と `再開する`・`取り消す`、無ければ `最後の指示は上限に達したため終了しました。途中の変更は採用していません。` を出す（[指示の状態と操作](./status.md)）。お知らせは、上限に達した指示の直下に並ぶ。
- 今月の上限は、ローカルの D1 の `ai_attempts` に今月の行を足して埋める。台本のAIは利用量を0で返すので、ローカルのアプリでは、一指示の上限にも、一指示の上限と月額の予約の競合にも届かない。どちらも試験だけが確かめる。

## Driving it with curl

Preconditions:

- Container は不要。上限到達の指示はAIを呼ばずに終わる。
- SKILL.md の「起動」の `pnpm dev` を、`MADORI_DEV_CONTAINERS=0` と `MADORI_DEV_JOB_TEST_HOLD=first_answer:60` を付けて起動している。種の指示を60秒待たせ、その後ろに指示を並べるためである。起動し直し方は[指示を止める](./stop.md)の Preconditions にある。
- [案件](./projects.md)の「作る」を済ませ、`PAT=$(jq -r .pattern.id "$EVIDENCE/projects/create.json")` を設定している。案の無い新しいパターンを使う。
- `. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`J='content-type: application/json'` と `D="$EVIDENCE/cost-limit"` を設定し、`$D` がある。
- [指示を止める](./stop.md)の `send`・`stop`・`state` を、出力先を `$D` にして定義している。
- D1 を読み書きする関数 `d1() { (cd apps/worker || exit 1; mise exec -- pnpm exec wrangler d1 execute DB --local --json --command "${1}") | jq -c '.[0].results'; }` を定義している。
- 動いている指示が無くなるまで待つ関数 `idle() { for i in $(seq 1 90); do state "${1}"; [ "$(jq -r .runningJob "$D/${1}.json")" = null ] && return 0; sleep 1; done; return 1; }` を定義している。
- 一連の手順は、種の指示の60秒の待ちの内に「止めて保留にする」まで進める。bash のスクリプトに書いて一度に流すと間に合う。

- **種の指示を送って待たせる。** `send seed 台所を広くしたい` で `202`。`S=$(jq -r .job.jobId "$D/seed.json")` を設定する。`state seed-1` の `runningJob.jobId` が `$S` になるまで1秒ずつ読み直す。`grep "\"jobId\":\"$S\"" "$EVIDENCE/dev.log" | grep '"step":"round 1 ai"'` の行が `"outcome":"hold"` になるまで待つ。`d1 "SELECT count(*) AS n, sum(charged) AS charged FROM ai_attempts WHERE job_id = '$S'"` は `n` が `1` で、`charged` が `0`（台本のAIの往復は利用量0で精算される）。
- **今月を埋める。** `d1 "INSERT INTO ai_attempts (id, job_id, generation, reserved, estimated_input_tokens, estimated_output_tokens, reserved_at) VALUES ('verify-month-fill', '$S', 1, 99999999, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"`。`d1 "SELECT sum(counted) AS month FROM ai_attempts WHERE month = strftime('%Y-%m', 'now')"` が `99999999` 以上。
- **後ろに二つ並べる。** `R0=$(curl -sS "$API/patterns/$PAT/revisions" | jq '.revisions | length')` を設定し、`send accept-a 窓を大きくしたい` と `send accept-b 収納を増やしたい`。どちらも `202`。`A=$(jq -r .job.jobId "$D/accept-a.json")` と `B=$(jq -r .job.jobId "$D/accept-b.json")` を設定する。`state queued-1` の `runningJob.jobId` が `$S`、`queuedJobs` が A、B の順。
- **止めて保留にする。** `stop stop-s "$S" "$(uuidgen)"` で `200`、`outcome` が `stopped`。`state held-s` の `queueHold.job.jobId` が `$S` で `state` が `cancelled`。
- **再開して上限に当てる。** `curl -sS -o "$D/resume-s.json" -w '%{http_code}\n' -X POST "$API/patterns/$PAT/queue/resume" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"heldBy\":\"$S\"}"` で `200`。`idle limited-1` が成功する。`$D/limited-1.json` の `lastFinishedJob.jobId` が `$A` で `lastFinishedJob.state` が `limited`、`queueHold.job.jobId` が `$A` で `queueHold.job.state` が `limited`、`queuedJobs[0].jobId` が `$B`。案の件数は `R0` のまま。`d1 "SELECT count(*) AS n FROM ai_attempts WHERE job_id = '$A'"` が `0`（AIを呼んでいない）。`grep "\"jobId\":\"$A\"" "$EVIDENCE/dev.log" | grep '"event":"job.finished"'` の行に `"outcome":"limited"` と `"limit":"monthly"` が出て、`"level":"info"` である。
- **会話のお知らせを読む。** `curl -sS "$API/patterns/$PAT/messages" >| "$D/messages.json"`。新しい順の先頭が `kind` が `notice`、`jobId` が `$A` で、`body` に `今月のサービス全体のAI費用が上限の100米ドルに達したため` を含む。
- **画面で読む。** T3 のプレビューで案件画面（`/projects/<案件 ID>`）を開く。会話の `窓を大きくしたい` の直下に「お知らせ」として同じ本文が出て、`保留中` の `収納を増やしたい` はその下に来る。`[role="status"]` に `上限に達して指示を終了したため、待機中の指示（1件）を保留しています。` が出る。スクリーンショットを残す。
- **上限到達の指示を止める。** `stop stop-a "$A" "$(uuidgen)"`。`200` で、`outcome` が `already_finished`、`job.state` が `limited`。
- **再開しても上限に当たる。** `curl -sS -o "$D/resume-a.json" -w '%{http_code}\n' -X POST "$API/patterns/$PAT/queue/resume" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"heldBy\":\"$A\"}"` で `200`。`idle resumed-1` が成功し、`lastFinishedJob.jobId` が `$B` で `state` が `limited`、`queueHold` が `null`（B の後に待機中の指示が無い）。案の件数は `R0` のまま。
- **埋めた行を消す。** `d1 "DELETE FROM ai_attempts WHERE id = 'verify-month-fill'"`。続けて `send after 和室を足したい` で送った指示は、上限到達で終わらない。`idle after-1`（60秒の待ちを含む）の後、`lastFinishedJob.jobId` がその指示で、`state` が `limited` 以外（Container を無効にしていれば `failed`）。

## Gotchas

- 埋めた行を消し忘れると、この worktree のローカルの D1 では、その月が終わるまですべての指示が上限到達で終わり、ほかの機能の手順が進まない。片付けの前に必ず「埋めた行を消す」を行う。
- 上限到達の指示は、実行権を取ってから数十ミリ秒で終わる。種の指示を待たせずに A と B を続けて送ると、B を受け付ける前に A が終わり、保留にならない。種の指示の待ちの間に並べる。
- 「止めて保留にする」が60秒の待ちに間に合わず、種の指示が先に失敗で終わっていたら、`queueHold.job.state` が `failed` になる。その保留を再開すれば、続きの手順はそのまま進む。
- `ai_attempts.job_id` は既存のジョブを指す外部キーなので、埋める行には種の指示の `jobId` を使う。`reserved_at` は `strftime('%Y-%m-%dT%H:%M:%fZ', ...)` の形でないと CHECK 制約で拒まれる。
- 月は UTC で数える。日本時間の月初の午前9時より前は、UTC ではまだ前の月である。`strftime('%Y-%m', 'now')` で今の月を確かめる。
