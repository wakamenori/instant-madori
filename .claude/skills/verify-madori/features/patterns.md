# パターン

案件の中には、間取りの候補をパターンとして並べる。利用者はパターンを足し、一覧で見て、名前を変え、今の状態を読む。

## Sub-features

- `pattern-list`：案件のパターンを、作った順に一覧する。
- `pattern-create`：パターンを足す。
- `pattern-rename`：今の版を添えて名前を変える。
- `pattern-state`：パターンの今の案、動いている仕事と待っている仕事、最後に終わった仕事、待機列の保留を読む。
- `pattern-missing`：存在しない案件のパターンは `404` になる。

## How to get to it (user POV)

- 案件画面は最初のパターンを開き、その名前を変えられる（[案件名とパターン名を変える](./names.md)）。パターンを足す・一覧する画面はまだ無い。API は `GET` と `POST` の `/api/projects/<id>/patterns`、`PATCH /api/patterns/<id>`、`GET /api/patterns/<id>/state` を使う。

## Driving it with curl

Preconditions:

- Container は不要。Container の要る地図と同じ回で確かめないなら、[SKILL.md の「起動」](../SKILL.md#起動)の手順で `MADORI_DEV_CONTAINERS=0` を付けて起動する。
- [案件](./projects.md)の「作る」を済ませ、`PID=$(jq -r .project.id "$EVIDENCE/projects/create.json")` を設定している。
- `. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`J='content-type: application/json'` と `D="$EVIDENCE/patterns"` を設定し、`$D` がある。

- **一覧。** `curl -sS -o "$D/list.json" -w '%{http_code}\n' "$API/projects/$PID/patterns"`。`200` で、案件と一緒にできた最初のパターンが一件ある。
- **足す。** `curl -sS -o "$D/create.json" -w '%{http_code}\n' -X POST "$API/projects/$PID/patterns" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"name\":\"二つ目のパターン\"}"`。`201`。一覧を読み直すと二件になり、二件目が `二つ目のパターン`。
- **名前を変える。** `PAT=$(jq -r .pattern.id "$D/create.json")` と `V=$(jq .pattern.version "$D/create.json")` を設定し、`curl -sS -o "$D/rename.json" -w '%{http_code}\n' -X PATCH "$API/patterns/$PAT" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"version\":$V,\"name\":\"名前を変えたパターン\"}"`。`200` で、`pattern.version` が `V + 1`。
- **状態を読む。** `curl -sS -o "$D/state.json" -w '%{http_code}\n' "$API/patterns/$PAT/state"`。`200` で、`currentRevision` が `null`、`runningJob` が `null`、`queuedJobs` が `[]`、`lastFinishedJob` が `null`、`queueHold` が `null`。
- **無い案件。** `curl -sS -o "$D/missing.json" -w '%{http_code}\n' "$API/projects/00000000-0000-4000-8000-000000000000/patterns"`。`404` で、本文が `{"error":"not_found"}`。

## Gotchas

- 案件を作ると最初のパターンができるので、新しい案件の一覧は最初から一件ある。
- 古い版での名前の変更は、案件と同じく `409 version_conflict` になる。
