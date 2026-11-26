# 止まった指示の復帰

利用者が送った指示は、途中で Worker や Workflow が止まっても、待機中や実行中のまま永久に残らない。実行中の指示があるパターンは、約30秒ごとにその指示の Workflow を確かめ、異常終了した Workflow の指示を失敗にする。起こす通知が届かなかったパターンは、5分ごとの定期実行が見つけて動かす。ローカルの `wrangler dev` は例外で、実行中に Worker を再読込・再起動すると、その指示の Workflow は再開しない。そのときは指示を止めて抜ける（[指示を止める](./stop.md)）。Worker の停止からの復帰は、SKILL.md の「マージの後に staging を確かめる」で staging の再デプロイをまたいで確かめる。

## Sub-features

- `recover-watch`：実行中の指示があるあいだ、Worker のログに約30秒ごとに `pattern.advanced` の `running` が出る。
- `recover-sweep`：定期実行を手で起こすと `ok` が返る。5分以上進んでいない指示があれば、そのパターンを起こしたことがログに出る。
- `recover-reload`：実行中に Worker を再読込すると、ローカルではその指示が `running` のまま残る。止めると `cancelled` で終わり、確かめる繰り返しも止まる。

## How to get to it (user POV)

- 画面の操作は無い。利用者から見えるのは、[指示を送る](./instructions.md)の state で、指示が最後に完了か失敗になること。確かめの繰り返しと定期実行は、`$EVIDENCE/dev.log` の Worker のログで読む。
- 定期実行は、ローカルでは自動で動かない。Worker のポートの `GET /cdn-cgi/local/scheduled` で一回動かす。画面のポート（Vite）は `/api` だけを中継するので、この経路は Worker のポート（`WORKER_PORT`）へ送る。

## Driving it with curl

Preconditions:

- 仕事は待ちの間に住宅を変えないので、Container は不要。Container の要る地図と同じ回で確かめないなら、[SKILL.md の「起動」](../SKILL.md#起動)の手順で `MADORI_DEV_CONTAINERS=0` を付けて起動する。
- SKILL.md の「起動」の `pnpm dev` を、`MADORI_DEV_JOB_TEST_HOLD=first_answer:420` を付けて起動している。仕事は実行権を取り、台本のAIの最初の応答を受け取った後、住宅を変える前に7分待つ。待ちを付けずに動いていたら、片付けてから、SKILL.md の「起動」の三行を、`perl` の行の先頭に `MADORI_DEV_JOB_TEST_HOLD=first_answer:420 ` を足して実行し直す。`dev.pgid` を書く行も実行する。
- 起動の確認は一つ目（`/api/me`）だけを行う。二つ目は指示を最後まで流すので、7分の待ちで時間切れになる。
- [案件](./projects.md)の「作る」を済ませ、`PAT=$(jq -r .pattern.id "$EVIDENCE/projects/create.json")` を設定している。
- [指示を止める](./stop.md)の `J`・`O`・`API`・`send`・`stop`・`state` を、`D="$EVIDENCE/recovery"` にして定義し、`$D` がある。
- `state pre` の `runningJob` が `null` で、`queuedJobs` が `[]`。ほかの機能の手順で残った指示があると、A はその後ろで待機中のままになり、どの手順も進まない。残っていたら、[指示を止める](./stop.md)の `stop` で止める。

- **送って、確かめの繰り返しを読む。** `send accept-a 台所を広くしたい`。`202`。`A=$(jq -r .job.jobId "$D/accept-a.json")` を設定する。70秒おいて `grep '"event":"pattern.advanced"' "$EVIDENCE/dev.log" | grep "$A" >| "$D/watch.log"`。`"outcome":"claimed"` の行が一つと、`"outcome":"running"` で `"instanceStatus"` を持つ行が二つ以上ある。`running` の行の間隔は約30秒。
- **5分より前の定期実行。** 送ってから5分たつ前に `curl -sS -o "$D/sweep-early.txt" -w '%{http_code}\n' "http://127.0.0.1:$WORKER_PORT/cdn-cgi/local/scheduled"`。`200` で、本文が `ok`。`grep -c '"event":"jobs.swept"' "$EVIDENCE/dev.log"` は、送る前と同じ数のまま。
- **5分を過ぎた定期実行。** 送ってから5分を過ぎて、同じ要求を出力先 `"$D/sweep-late.txt"` で送る。`200` で `ok`。`grep '"event":"jobs.swept"' "$EVIDENCE/dev.log" | tail -1` に `"found":1` と `"woken":1` が出て、その直後に `$A` の `pattern.advanced` の `running` が一行増える。`state state-1` の `runningJob.jobId` は `$A` のまま。
- **再読込で止まることを読む。** `n=$(grep -c 'Local server updated and ready' "$EVIDENCE/dev.log")` を設定し、`printf '\n// reload\n' >> apps/worker/src/runtime.ts` で中身に一行足す。`$EVIDENCE/dev.log` の `Local server updated and ready` が `n` より増えたら、`git checkout -- apps/worker/src/runtime.ts` で戻す。戻した変更でも、もう一度再読込する。`git status --short apps/worker` が何も出さない。7分の待ちが明けた後も、`state state-2` の `runningJob.jobId` は `$A` のままで、`$A` の `job.finished` は出ない。`pattern.advanced` の `running` は約30秒ごとに出続ける。
- **止めて抜ける。** `stop stop-a "$A" "$(uuidgen)"`。`200` で、`outcome` が `stopped`、`job.state` が `cancelled`。`state state-3` の `runningJob` が `null`、`lastFinishedJob.state` が `cancelled`。直後の `pattern.advanced` に `"outcome":"idle"` が出て、その後 `$A` の `running` の行は増えない。

## Gotchas

- 待ちを付けずに起動すると、台本のAIの仕事は数秒で終わり、確かめの繰り返しも定期実行の対象も残らない。
- 待ちは手元のすべての仕事に掛かる。ほかの手順を続けるなら、片付けて待ちなしで起動し直す。
- 定期実行は、5分以上前に取った実行権か、5分以上前に受け付けた待機中の指示があるパターンだけを起こす。待機列が保留中で実行中の指示が無いパターンは起こさない。`found` が `0` の回はログに出ない。
- 再読込すると、その時点の Workflow は再開しない。これはローカルの `wrangler dev` の制約で、本番の Workflow はデプロイを越えて続く。再読込の確認の後は、止めずに放っておくと、そのパターンの後の指示はすべて待機中のまま残る。
- `touch` で日付だけを変えても、再読込は起きないことがある。中身を変えて戻す。足した行を戻し忘れると、`git status` に差分が残る。
