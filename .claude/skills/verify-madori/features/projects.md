# 案件

利用者は案件を作り、一覧で見て、名前を変える。案件を作ると、最初のパターンも一緒にできる。同じ要求を送り直しても二つ目はできず、古い版を元にした変更は拒まれる。

## Sub-features

- `project-create`：作ると、案件と最初のパターンが返る。
- `project-replay`：同じ `requestId` と同じ本文を送り直すと、最初の結果が返る。
- `project-reuse`：同じ `requestId` で本文を変えると拒まれる。
- `project-list`：新しい順に一覧できる。
- `project-rename`：今の版を添えると名前が変わり、版が一つ増える。
- `project-conflict`：古い版を添えると拒まれる。

## How to get to it (user POV)

- 画面はまだ無い。`POST /api/projects`、`GET /api/projects`、`PATCH /api/projects/<id>` を使う。

## Driving it with curl

Preconditions:

- Container は不要。Container の要る地図と同じ回で確かめないなら、[SKILL.md の「起動」](../SKILL.md#起動)の手順で `MADORI_DEV_CONTAINERS=0` を付けて起動する。
- 状態確認が通っている。
- `. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`J='content-type: application/json'` と `D="$EVIDENCE/projects"` を設定し、`$D` がある。

- **作る。** `RID=$(uuidgen)` で `curl -sS -o "$D/create.json" -w '%{http_code}\n' -X POST "$API/projects" -H "$J" -H "$O" -d "{\"requestId\":\"$RID\",\"name\":\"検証の案件\"}"`。`201`。`jq '.project.name, .project.version, .pattern.projectId == .project.id' "$D/create.json"` が `"検証の案件"`、`1`、`true`。
- **送り直す。** 同じ `RID` と本文で、出力先だけ `"$D/replay.json"` にして送る。`201` で、`project.id` が `create.json` と同じ。
- **本文を変えて送り直す。** 同じ `RID` で `name` を `別の名前` にして、出力先を `"$D/reuse.json"` にする。`422` で、本文が `{"error":"request_id_reused"}`。
- **一覧。** `curl -sS -o "$D/list.json" -w '%{http_code}\n' "$API/projects"`。`200` で、`.projects[0].id` が作った案件。
- **名前を変える。** `PID=$(jq -r .project.id "$D/create.json")` と `V=$(jq .project.version "$D/create.json")` を設定し、`curl -sS -o "$D/rename.json" -w '%{http_code}\n' -X PATCH "$API/projects/$PID" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"version\":$V,\"name\":\"名前を変えた案件\"}"`。`200` で、`project.version` が `V + 1`。一覧を読み直すと、新しい名前になっている。
- **古い版で変える。** 同じ PATCH を、新しい `requestId` と元の `V` で送り、出力先を `"$D/conflict.json"` にする。`409` で、本文が `{"error":"version_conflict"}`。

## Gotchas

- 名前は 1〜100 文字。制御文字を含む名前と、見えない文字だけの名前は `400 invalid_request` になる。
- 一覧は新しい順で、続きは `nextCursor` を `?cursor=` に渡して読む。
- 存在しない案件と他人の案件は、どちらも `404 not_found` になる。
