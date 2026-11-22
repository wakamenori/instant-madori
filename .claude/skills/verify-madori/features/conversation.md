# 会話を読み直す

パターンを開き直すと、会話を新しい順に取得できる。指示には受け付けたジョブと、そのジョブが確定した案が付く。

## Sub-features

- `conversation-read`：新しい指示から順に、その本文と対応する案を読める。
- `conversation-errors`：存在しないパターンと不正なカーソルを区別できる。

## How to get to it (user POV)

会話を読む入口は `GET /api/patterns/<id>/messages`。続きがあれば、応答の `nextCursor` を次の要求の `cursor` に渡す。

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

二つ目の案が確定するまで待つ。会話を読み直すと200が返り、二つの指示に受付時と同じジョブIDと対応する案が付く。

```sh
for i in $(seq 1 60); do
  curl -fsS "$API/patterns/$PAT/state" -o "$D/state.json"
  jq -e '.runningJob == null and .queuedJobs == [] and .currentRevision.number == 2' "$D/state.json" >/dev/null && break
  sleep 5
done
curl -sS -o "$D/messages.json" -w '%{http_code}\n' "$API/patterns/$PAT/messages"
jq -e --slurpfile first "$D/accept-1.json" --slurpfile second "$D/accept-2.json" '
  .nextCursor == null and [.messages[].kind] == ["instruction","instruction"]
  and [.messages[].body] == ["指示2","指示1"] and [.messages[].number] == [2,1]
  and [.messages[].jobId] == [$second[0].job.jobId,$first[0].job.jobId]
  and [.messages[].revision.number] == [2,1]' "$D/messages.json"
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
