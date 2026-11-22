# 案件

利用者は案件一覧の画面（`/`）で案件を作り、新しい順の一覧で見て、続きを読み込む。一覧の行は案件名と作成日時で、押すとその案件画面へ移る。案件を作ると、最初のパターンも一緒にできる。同じ要求を送り直しても二つ目はできず、古い版を元にした変更は拒まれる。名前の変更は、まだ API だけで行う。

## Sub-features

- `project-ui-create`：一覧の `新しい案件を作る` を押すと、初期名 `新しい案件` の案件ができ、その案件画面へ移る。
- `project-ui-list`：一覧の画面に、案件名と作成日時が新しい順に 50 件まで並ぶ。
- `project-ui-more`：51 件目からは `もっと見る` で続きを読み、重ならずに後ろへ足される。最後まで読むとボタンが消える。
- `project-create`：作ると、案件と最初のパターンが返る。
- `project-replay`：同じ `requestId` と同じ本文を送り直すと、最初の結果が返る。
- `project-reuse`：同じ `requestId` で本文を変えると拒まれる。
- `project-list`：新しい順に一覧できる。
- `project-rename`：今の版を添えると名前が変わり、版が一つ増える。
- `project-conflict`：古い版を添えると拒まれる。

## How to get to it (user POV)

- 画面のポートの `/` が案件一覧。案件画面の上の `案件一覧` のリンクからも戻る。
- API は `POST /api/projects`、`GET /api/projects`、`PATCH /api/projects/<id>` を使う。名前の変更は、画面からはまだできない。

## Driving it with T3 preview and curl

Preconditions:

- Container は不要。Container の要る地図と同じ回で確かめないなら、[SKILL.md の「起動」](../SKILL.md#起動)の手順で `MADORI_DEV_CONTAINERS=0` を付けて起動する。
- 状態確認が通っている。
- `. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`J='content-type: application/json'` と `D="$EVIDENCE/projects"` を設定し、`$D` がある。

- **画面で作る。** `preview_open` に `target: { kind: "environment-port", port: <WEB_PORT> }`、`open: false`、`reuseExistingTab: false` を渡し、返った `tabId` を以後のすべての呼び出しに渡す。見出しが `案件一覧`。`preview_act` の `click` で `locator: 'role=button[name="新しい案件を作る"]'` を押す。`preview_wait_for` で `urlIncludes: "/projects/"` と `text: "まだ案がありません。"` を待つ。`curl -sS -o "$D/ui-list.json" "$API/projects"` の `.projects[0]` が、URL の ID で名前が `新しい案件` の案件で、一覧はほかに増えていない。
- **画面で一覧を見る。** `案件一覧` のリンクを押す。`preview_evaluate` で `[...document.querySelectorAll('.project-list li a')].map((a) => [a.textContent, a.getAttribute('href')])` を読む。先頭が `新しい案件 <日時>` で `/projects/<ID>` を指し、日時は案件画面の `<日時> 作成` と同じ。その行を `locator: 'role=link[name="新しい案件 <日時>"]'` で押すと、同じ案件画面が開く。
- **続きを読む。** 案件が 50 件を超えるまで、`for i in $(seq -w 1 50); do curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$API/projects" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"name\":\"一覧の確認 $i\"}"; done | sort | uniq -c` で作る。すべて `201`。一覧を開き直すと行が 50 件で、`もっと見る` がある。押すと、すべての案件の行が並び、`href` が重ならず、`もっと見る` が消える。
- **作る。** `RID=$(uuidgen)` で `curl -sS -o "$D/create.json" -w '%{http_code}\n' -X POST "$API/projects" -H "$J" -H "$O" -d "{\"requestId\":\"$RID\",\"name\":\"検証の案件\"}"`。`201`。`jq '.project.name, .project.version, .pattern.projectId == .project.id' "$D/create.json"` が `"検証の案件"`、`1`、`true`。
- **送り直す。** 同じ `RID` と本文で、出力先だけ `"$D/replay.json"` にして送る。`201` で、`project.id` が `create.json` と同じ。
- **本文を変えて送り直す。** 同じ `RID` で `name` を `別の名前` にして、出力先を `"$D/reuse.json"` にする。`422` で、本文が `{"error":"request_id_reused"}`。
- **一覧。** `curl -sS -o "$D/list.json" -w '%{http_code}\n' "$API/projects"`。`200` で、`.projects[0].id` が作った案件。
- **名前を変える。** `PID=$(jq -r .project.id "$D/create.json")` と `V=$(jq .project.version "$D/create.json")` を設定し、`curl -sS -o "$D/rename.json" -w '%{http_code}\n' -X PATCH "$API/projects/$PID" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"version\":$V,\"name\":\"名前を変えた案件\"}"`。`200` で、`project.version` が `V + 1`。一覧を読み直すと、新しい名前になっている。
- **古い版で変える。** 同じ PATCH を、新しい `requestId` と元の `V` で送り、出力先を `"$D/conflict.json"` にする。`409` で、本文が `{"error":"version_conflict"}`。

## Gotchas

- 名前は 1〜100 文字。制御文字を含む名前と、見えない文字だけの名前は `400 invalid_request` になる。
- 一覧は新しい順で、続きは `nextCursor` を `?cursor=` に渡して読む。
- 名前を付けずに作った案件は、どれも `新しい案件` になる。行と案件画面は作成日時で見分ける。同じ分に作った案件は、日時も同じになる。
- 画面の作成に失敗すると `再試行` が出る。押すと同じ `requestId` で送り直すので、届いていた作成は二つにならない。失敗を画面から起こす手順は無く、web のテスト（`apps/web/src/project-list.test.ts`）で確かめている。
- 一覧へ戻ると、最初のページから読み直す。`もっと見る` で読んだ行は残らない。
- 存在しない案件と他人の案件は、どちらも `404 not_found` になる。
