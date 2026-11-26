# 会話を読み直す

パターンを開き直すと、会話を新しい順に取得できる。会話には、利用者の指示と、仕事が案を確定したときの AI の説明が並ぶ。指示には受け付けたジョブと、そのジョブが確定した案と、添えた画像の資産 ID が付く。説明には、それを書いたジョブと、そのジョブが確定した案が付く。

## Sub-features

- `conversation-read`：新しいものから順に、指示と説明の本文、種類、対応するジョブと案、添付の資産 ID（無ければ `[]`）を読める。番号は新しい順に減るが、指示と説明が同じ番号の並びを使うので、連続するとは限らない。添付のある指示は[指示を送る](./instructions.md)の `instruction-attach` で確かめる。
- `conversation-errors`：存在しないパターンと不正なカーソルを区別できる。

## How to get to it (user POV)

- 案件画面の会話の欄が、最新の 50 行を番号の順に出す（[案件画面で指示を送り、会話を読む](./project-chat.md)）。それより古い行は、画面からはまだ読めない（#218）。
- API の入口は `GET /api/patterns/<id>/messages`。続きがあれば、応答の `nextCursor` を次の要求の `cursor` に渡す。

## Driving it with curl

Preconditions:

- Container が必要。
- 検証マップの前提を満たしている。

新しい案件を作り、そのパターンに指示を二つ送る。案件は201、各指示は202を返す。

```sh
. "$EVIDENCE/dev.env"
J='content-type: application/json'
D="$EVIDENCE/conversation"
mkdir -p "$D"
curl -sS -o "$D/project.json" -w '%{http_code}\n' "$API/projects" -H "$O" -H "$J" -d "{\"requestId\":\"$(uuidgen)\"}"
PAT=$(jq -er '.pattern.id' "$D/project.json")
for i in 1 2; do
  curl -sS -o "$D/accept-$i.json" -w '%{http_code}\n' "$API/patterns/$PAT/messages" -H "$O" -H "$J" -d "{\"requestId\":\"$(uuidgen)\",\"body\":\"指示$i\"}"
done
```

二つ目の案が確定するまで待つ。会話を読み直すと200が返り、二つの指示と二つの説明が並ぶ。指示には受付時と同じ番号とジョブIDと対応する案が付き、説明にはそれを書いたジョブと案が付く。説明の番号は、仕事が確定したときに決まる。二つ目の指示を一つ目の確定より後に受け付けると、一つ目の説明が二つの指示の間に入るので、番号の並び方は決め打ちしない。

```sh
for i in $(seq 1 60); do
  curl -fsS "$API/patterns/$PAT/state" -o "$D/state.json"
  jq -e '.runningJob == null and .queuedJobs == [] and .currentRevision.number == 2' "$D/state.json" >/dev/null && break
  sleep 5
done
curl -sS -o "$D/messages.json" -w '%{http_code}\n' "$API/patterns/$PAT/messages"
jq -e --slurpfile first "$D/accept-1.json" --slurpfile second "$D/accept-2.json" '
  ([.messages[] | select(.kind == "instruction")]) as $inputs
  | ([.messages[] | select(.kind == "explanation")]) as $explanations
  | [.messages[].number] as $numbers
  | .nextCursor == null and (.messages | length) == 4
  and $numbers == ($numbers | sort | reverse) and ($numbers | unique | length) == 4
  and [$inputs[].body] == ["指示2","指示1"]
  and [$inputs[].number] == [$second[0].job.number, $first[0].job.number]
  and [$inputs[].jobId] == [$second[0].job.jobId,$first[0].job.jobId]
  and [$inputs[].revision.number] == [2,1]
  and [$explanations[].jobId] == [$second[0].job.jobId,$first[0].job.jobId]
  and [$explanations[].revision.number] == [2,1]
  and [.messages[].attachmentIds] == [[],[],[],[]]' "$D/messages.json"
```

存在しないパターンは404と `not_found`、不正なカーソルは400と `invalid_request` を返す。

```sh
curl -sS -o "$D/missing.json" -w '%{http_code}\n' "$API/patterns/$(uuidgen)/messages"
jq -e '.error == "not_found"' "$D/missing.json"
curl -sS -o "$D/cursor.json" -w '%{http_code}\n' "$API/patterns/$PAT/messages?cursor=garbage"
jq -e '.error == "invalid_request"' "$D/cursor.json"
```

## Gotchas

Containerを無効にすると指示の受付後に案の確定が失敗する。検証のたびに新しい案件を作り、以前の会話が混ざるのを避ける。
