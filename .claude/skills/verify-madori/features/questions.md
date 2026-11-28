# 質問に答える

AIが案の代わりに質問と選択肢で応答すると、その指示は案を増やさずに質問待ち（`awaiting_answer`）で終わり、パターンの待機列は保留になる。利用者は、その質問に一度だけ答えられる。回答は待機中の指示より先に、最後の確定案から実行される。回答の処理が終わっても、待機中の指示があれば保留は残り、利用者が再開か取り消しを選ぶ。答えたときに待機中の指示がなければ、保留はその場で解ける。

## Sub-features

- `ask-hold`：質問で終わった指示は、state の `queueHold.job` に `state: "awaiting_answer"`、質問の本文と選択肢（`question`）、`answer: null` を持つ。`lastFinishedJob.state` も `awaiting_answer`。案は増えず、待機中の指示は動かない。
- `ask-conversation`：会話の一覧に、選択肢付きの質問（`kind: "question"`、`choices`）が出る。
- `answer-first`：`questionId` を添えた回答は `202` で、待機中の指示より先に動いて案を確定する。
- `answer-held`：回答の処理が終わっても保留は残り、`queueHold.job.answer` が回答のジョブを示す。再開すると待機中の指示が動き、回答で確定した案を編集元にする。
- `answer-closed`：答え済みの質問への回答は `409` `version_conflict`。
- `answer-not-question`：質問でない message の ID を `questionId` に送ると `404`。
- `answer-replay`：同じ `requestId` で送り直すと、同じ本文が返る。
- `ask-stop`：質問待ちの指示を止めると `200` で、`outcome` が `already_finished`、`job.state` が `awaiting_answer`。
- `ask-empty`：待機中の指示が無いときの質問も保留になり、答えると保留が解けて回答だけが動く。

## How to get to it (user POV)

- 案件画面は、質問の保留を `AIが質問しています。選択肢を選ぶか、回答を書いて送ってください。` と表示し、質問の本文、選択肢のボタン、回答欄を状態の欄に出す（[指示の状態と操作](./status.md)）。API では、質問は `GET /api/patterns/<id>/state` の `queueHold.job.question`（`{ messageId, number, body, choices }`）で読む。回答は `POST /api/patterns/<id>/messages` に `{"requestId":"<uuid>","body":"<回答>","questionId":"<question.messageId>"}` を送る。
- 台本のAIは、指示の一行目が `台本:question` なら最初の往復で `和室は必要ですか？`（選択肢 `必要`・`不要`）と質問する。`台本:question-after-edit` は、部屋を置いてから次の往復で同じ質問をする。

## Driving it with curl

Preconditions:

- 回答の仕事が案を確定するので、Container が必要。
- SKILL.md の「起動」の `pnpm dev` を、`MADORI_DEV_JOB_TEST_HOLD=first_answer:30` を付けて起動している。起動し直し方は[指示を止める](./stop.md)の Preconditions にある。
- [案件](./projects.md)の「作る」を済ませ、`PAT=$(jq -r .pattern.id "$EVIDENCE/projects/create.json")` を設定している。案の無い新しいパターンを使う。
- `. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`J='content-type: application/json'` と `D="$EVIDENCE/questions"` を設定し、`$D` がある。
- [指示を止める](./stop.md)の `send`・`stop`・`state` と、[待機列の保留](./queue-hold.md)の `release`・`revisions` を、出力先を `$D` にして定義している。
- 答える関数 `answer() { curl -sS -o "$D/${1}.json" -w '%{http_code}\n' -X POST "$API/patterns/$PAT/messages" -H "$J" -H "$O" -d "{\"requestId\":\"${4}\",\"body\":\"${2}\",\"questionId\":\"${3}\"}"; }` を定義している。
- [指示を送る](./instructions.md)の `settle` を、出力先を `$D` にして定義している。

- **質問させる。** `send ask-a 台本:question` で `202`。`A=$(jq -r .job.jobId "$D/ask-a.json")` を設定する。A の30秒の待ちの内に `send ask-b 窓を大きくしたい` で `202`、`B=$(jq -r .job.jobId "$D/ask-b.json")`。`grep "\"jobId\":\"$A\"" "$EVIDENCE/dev.log" | grep '"event":"job.finished"'` に `"outcome":"asked"` が出るまで待つ。`state held` の `queueHold.job.jobId` が `$A`、`queueHold.job.state` が `awaiting_answer`、`queueHold.job.question.body` が `和室は必要ですか？`、`choices` が `["必要","不要"]`、`answer` が `null`。`lastFinishedJob.state` が `awaiting_answer`、`currentRevision` が `null`、`runningJob` が `null`、`queuedJobs` が B の一件。`Q=$(jq -r .queueHold.job.question.messageId "$D/held.json")` を設定する。
- **会話の質問。** `curl -sS "$API/patterns/$PAT/messages" | jq '.messages[] | select(.kind == "question")'` の `id` が `$Q`、`choices` が `["必要","不要"]`。
- **質問待ちを止める。** `stop ask-stop "$A" "$(uuidgen)"` は `200` で、`outcome` が `already_finished`、`job.state` が `awaiting_answer`。`state held-2` は `held` と同じ。
- **質問でないものに答える。** `answer not-question 必要 "$(jq -r .job.messageId "$D/ask-b.json")" "$(uuidgen)"` は `404` で、本文が `{"error":"not_found"}`。
- **答える。** `RA=$(uuidgen)` で `answer answer 必要 "$Q" "$RA"`。`202` で、`X=$(jq -r .job.jobId "$D/answer.json")` を設定する。`answer answer-replay 必要 "$Q" "$RA"` は `202` で、`cmp "$D/answer.json" "$D/answer-replay.json"` が何も出さない。`answer answer-again 不要 "$Q" "$(uuidgen)"` は `409` で、本文が `{"error":"version_conflict"}`。
- **回答が先に動く。** `state answering` の `runningJob.jobId` が `$X`（まだ待機中なら1秒おいて読み直す）、`queuedJobs` が B の一件。X の `job.finished` に `"outcome":"committed"` が出るまで待つ（30秒の待ちを含む）。`grep "\"jobId\":\"$B\"" "$EVIDENCE/dev.log" | grep '"event":"job.step"'` は何も出さない。
- **保留が残る。** `state answered` の `currentRevision.number` が `1`、`queueHold.job.jobId` が `$A`、`queueHold.job.answer.jobId` が `$X`、`queuedJobs` が B の一件、`lastFinishedJob.jobId` が `$X` で `state` が `completed`。`R1=$(jq -r .currentRevision.id "$D/answered.json")` を設定する。
- **再開する。** `release resume resume "$(uuidgen)" "$A"` は `200` で、`jobs` が B の一件。`settle resumed` で終わるまで待つ（30秒の待ちを含む）。`currentRevision.number` が `2` で、`currentRevision.baseRevisionId` が `$R1`。`queueHold` が `null`。
- **待機中の指示が無いときの質問。** `send ask-c 台本:question` で `202`、`C=$(jq -r .job.jobId "$D/ask-c.json")`。C の `job.finished` に `"outcome":"asked"` が出るまで待つ。`state held-c` の `queueHold.job.jobId` が `$C`、`queuedJobs` が `[]`。`answer answer-c 不要 "$(jq -r .queueHold.job.question.messageId "$D/held-c.json")" "$(uuidgen)"` は `202`。直後の `state answered-c` の `queueHold` が `null`。`settle answered-c-2` で終わるまで待つ。`currentRevision.number` が `3`。

## Gotchas

- 質問の保留は、待機中の指示を止めても解けない。答えるか、再開か取り消しを選ぶか、待機中の指示が無いときに新しい指示を送ると、質問は閉じる。閉じた質問への回答は `409` になる。
- 回答の仕事も待ちの設定で30秒待つ。`settle` は保留中に終わらないので、待機中の指示がある間は再開か取り消しの後に使う。
- Container を止めて起動すると、回答の仕事は部屋を置く段階で失敗する。そのときも保留は質問した指示に残り、待機中の指示は動かない。
- 別の利用者の質問は `404` になる。確かめるには、SKILL.md のとおり片付けてから `MADORI_DEV_EMAIL=other@example.com` を付けて起動し直す。
