# 案件名とパターン名を変える

案件画面の見出しは案件名で、その下に `パターン「<名前>」` が出る。利用者はそれぞれの `案件名を変える`・`パターン名を変える` を押し、欄に新しい名前を入れて `保存` を押す。名前は保存した後も、再読込しても残る。名前の変更は住宅の編集と別の操作で、指示の実行中でもできる。画面を開いた後にほかの画面で名前が変わっていると、保存は拒まれ、画面は最新の名前を読み直して知らせる。欄には入れた名前が残り、もう一度 `保存` を押すと、その名前に変わる。

## Sub-features

- `names-project`：`案件名を変える` から案件名を変えると、見出しが新しい名前になり、案件一覧の行も新しい名前になる。
- `names-pattern`：`パターン名を変える` からパターン名を変えると、`パターン「<名前>」` が新しい名前になる。
- `names-reload`：再読込しても、変えた案件名とパターン名が出る。
- `names-conflict`：画面を開いた後にほかで名前が変わっていると、保存すると `ほかの画面で案件名が「<最新の名前>」に変わっていたため、最新を読み直しました。この名前にするなら、もう一度保存してください。` が出て、見出しが最新の名前になる。欄には入れた名前が残り、もう一度保存すると変わる。パターン名も同じで、文の `案件名` が `パターン名` になる。
- `names-invalid`：空白だけの名前と 101 文字以上の名前は、送らずに `名前は1〜100文字で、見える文字を含めてください。` が出る。
- `names-cancel`：`やめる` を押すと欄が閉じ、名前は変わらない。

## How to get to it (user POV)

- 案件画面（`/projects/<案件の ID>`）の見出しの近くにある `案件名を変える` と `パターン名を変える` のボタン。案件画面への入り方は[案件画面で案を見る](./project-view.md)にある。

## Driving it with T3 preview and curl

Preconditions:

- Container は不要。Container の要る地図と同じ回で確かめないなら、[SKILL.md の「起動」](../SKILL.md#起動)の手順で `MADORI_DEV_CONTAINERS=0` を付けて起動する。
- 状態確認が通っている。
- `. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`J='content-type: application/json'` と `D="$EVIDENCE/names"` を設定し、`$D` がある。

- **案件を作って開く。** `preview_open` に `target: { kind: "environment-port", port: <WEB_PORT> }`、`open: false`、`reuseExistingTab: false` を渡し、返った `tabId` を以後のすべての呼び出しに渡す。`preview_act` の `click` で `locator: 'role=button[name="新しい案件を作る"]'` を押す。`preview_wait_for` で `text: "まだ案がありません。"` を待つ。見出しが `新しい案件` で、`パターン「パターン1」` が出る。`preview_evaluate` の `location.pathname` から ID を取り、`PID=<ID>` と `PAT=$(curl -sS "$API/projects/$PID/patterns" | jq -r '.patterns[0].id')` を設定する。
- **案件名を変える。** `click` で `role=button[name="案件名を変える"]` を押す。`type` で `locator: 'role=textbox[name="案件名"]'`、`clear: true` を付けて `北の土地の家` を入れ、`click` で `role=button[name="保存"]` を押す。`preview_wait_for` で `text: "北の土地の家"` を待つ。見出しが `北の土地の家` になり、欄が閉じて `案件名を変える` が戻る。`curl -sS "$API/projects/$PID" | jq -c '.project | {name, version}'` が `{"name":"北の土地の家","version":2}`。
- **パターン名を変える。** `click` で `role=button[name="パターン名を変える"]` を押す。`type` で `role=textbox[name="パターン名"]` に `clear: true` で `南向きの案` を入れて `保存` を押す。`preview_wait_for` で `text: "パターン「南向きの案」"` を待つ。`curl -sS "$API/projects/$PID/patterns" | jq -c '.patterns[0] | {name, version}'` が `{"name":"南向きの案","version":2}`。
- **再読込する。** `preview_evaluate` で `location.reload()` を実行し、`preview_wait_for` で `text: "まだ案がありません。"` を待つ。見出しが `北の土地の家` で、`パターン「南向きの案」` が出る。`案件一覧` のリンクを押すと、先頭の行が `北の土地の家 <日時>` になっている。その行を押して案件画面へ戻る。
- **ほかで変わった後に保存する。** 画面を開いたまま、ほかの画面の変更として `curl -sS -o "$D/other.json" -w '%{http_code}\n' -X PATCH "$API/projects/$PID" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"version\":2,\"name\":\"ほかで変えた名前\"}"` を送る。`200`。画面はまだ `北の土地の家` のまま。`案件名を変える` を押し、`案件名` の欄に `clear: true` で `画面で変えた名前` を入れて `保存` を押す。`preview_wait_for` で `text: "最新を読み直しました"` を待つ。`[role="alert"]` が `ほかの画面で案件名が「ほかで変えた名前」に変わっていたため、最新を読み直しました。この名前にするなら、もう一度保存してください。` で、見出しが `ほかで変えた名前`、欄は `画面で変えた名前` のまま。もう一度 `保存` を押すと、見出しが `画面で変えた名前` になって欄が閉じ、`curl -sS "$API/projects/$PID" | jq -c '.project | {name, version}'` が `{"name":"画面で変えた名前","version":4}`。パターンでも、`"$API/patterns/$PAT"` へ `version` を `2` にして同じように確かめる。
- **送れない名前。** `案件名を変える` を押し、`案件名` の欄に `clear: true` で半角空白を三つ入れて `保存` を押す。`[role="alert"]` が `名前は1〜100文字で、見える文字を含めてください。` で、`curl -sS "$API/projects/$PID" | jq .project.version` は前と同じ。`やめる` を押すと欄が閉じ、見出しは変わらない。

## Gotchas

- 名前の版は、名前を変えたときだけ増える。指示を送っても、案が確定しても増えない。手順の `version` の値は、この地図の手順だけを順に通したときのもの。ずれたら `GET /api/projects/<id>` と `GET /api/projects/<id>/patterns` の `version` を読んで使う。
- 保存の応答だけが失われ、もう一度保存して版が古いと拒まれたときは、最新の名前が入れた名前と同じなので、知らせを出さずに保存済みとして欄を閉じる。この場合を画面から起こす手順は無く、web のテスト（`apps/web/src/project-session.test.ts`）で確かめている。
- 画面の案件名は開いたときに一度読み、パターン名は指示の状態を読み直すたびに新しい版を取り込む。何も動いていないとき、ほかで変えた案件名とパターン名は、保存するか再読込するまで画面に出ない。
