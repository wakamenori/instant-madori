# 案件画面で案を見る

案件画面（`/projects/<案件の ID>`）は、案件の最初のパターンを開き、現在の案を間取り図か、WebGPU で描く 3D で見せる。見出しは案件名で、その下にパターン名（`パターン「<名前>」`）、パターンを作った日時（`<日時> 作成`）、表示中の案、指示の状態が並ぶ。案件名とパターン名は画面で変えられる（[案件名とパターン名を変える](./names.md)）。画面の右（幅が 60rem より狭いと下）には会話と指示欄が並ぶ（[案件画面で指示を送り、会話を読む](./project-chat.md)）。指示が実行中か待機中なら、状態を 1 秒ごとに読み直し、確定した案に描き替える。何も動いていないときと、待機列が保留のときは読み直さず、画面から指示を送ると読み直しを始める。読み直しに失敗すると、理由と `再試行` を出したまま、間を空けて自分で読み直す。案件は URL で開くので、再読込しても、`pnpm dev` を起動し直して画面のポートが変わっても、同じパスで同じ案件が開く。案の行の下の `間取り図` と `3D` のボタンで表示を切り替える。案に平面図があれば、利用者が選ぶまで `間取り図` が選ばれ、案が無いあいだは `3D` が選ばれる。案の表示データの応答には、その案の平面図がある階の一覧が付き、画面は最初の階の平面図を同じ案の 3D と一緒に読んで、そろってから両方を一度に描き替える。間取り図には、部屋名、面積、参考畳数、`北（仮）`、建物の外形寸法、壁・窓・ドアが出る。間取り図はドラッグで動き、ホイールか右下の `拡大`・`縮小` で拡大・縮小し、`全体を表示` で全体が入る表示に戻る。部屋か壁を押すと、その要素が色付きになり、その要素の寸法が出る。3D では、利用者はドラッグで回転し、右ドラッグか、Shift か Ctrl を押したままのドラッグで視点を平行に動かし、ホイールで拡大・縮小する。ビューアの右上の `視点を戻す` を押すと、案の全体が入る最初の視点に戻る。どちらの表示も、下に操作の案内が一行出る。

## Sub-features

- `view-open`：案件を開くと、見出しの案件名、`パターン「<名前>」`、`<日時> 作成`、`まだ案がありません。` か `確定済みの案N「名前」を表示しています。` が出て、案があれば描かれる。仕事が動いている間は、案の行の後ろに `AIが編集中です。` が付き、案がまだ無ければ `AIが最初の案を編集中です。` が出る。
- `view-progress`：指示が実行中なら `指示を実行しています…`、後ろに待機中の指示があれば続けて `待機中の指示がN件あります。`、実行中が無く待機中だけなら `順番を待っています（N件）…` が出る。仕事が確定すると、再読込しなくても新しい案に描き替わり、状態の行が消える。
- `view-held`：待機列が保留になると `待機中の指示（N件）が保留されています。` が出て、待機中の指示の行に `保留中` が付き、状態の読み直しが止まる。
- `view-reopen`：再読込しても、起動し直した後に同じパスを開いても、同じ案件、同じ案、同じ状態が出る。
- `view-rotate`：ドラッグでモデルが回る。
- `view-zoom`：ホイールで拡大・縮小する。
- `view-pan`：右ドラッグ、Shift＋ドラッグ、Ctrl＋ドラッグで、モデルが回らずにカーソルについて平行に動く。動かしてから拡大すると、部屋の中を近くから見られる。中ボタンのドラッグでは何も動かない。キャンバスの上では右クリックのメニューが出ない。
- `view-reset`：`視点を戻す` を押すと、回転・移動・拡大のどの後でも、案を開いたときと同じ視点に戻る。案が無いあいだ、ボタンは押せない。
- `view-switch`：`間取り図` と `3D` のボタンで表示を切り替える。選ばれた方のボタンが `aria-pressed="true"` になる。隠れた方も消えずに残り、3D のキャンバスは大きさを保つので、切り替えた直後から同じ大きさで描かれる。
- `view-plan`：間取り図に、部屋名、面積（m²）、参考畳数、`北（仮）`、建物の外形寸法、壁・窓・ドア、畳数の換算の注記が出る。
- `view-plan-zoom`：ホイール、`拡大`、`縮小` で拡大・縮小する。ホイールでは、カーソルの下の点が動かない。`全体を表示` で全体が入る表示に戻る。
- `view-plan-pan`：左ドラッグで、図面がカーソルについて動く。動かしても選択は変わらない。
- `view-plan-select`：部屋か壁を押すと、その要素が色付きになり、その要素の寸法の組だけが出る。窓やドアの上を押すと、その下の壁が選ばれる。何もない所を押すか、図面にフォーカスがあるときに Esc を押すと、選択が消える。次の案に同じ要素があれば、選択は残る。
- `view-floor-plan`：仕事が作る案は平面図を持つので、表示データの応答の `x-floor-plan-storeys` に一つの階の ID が付き、その階の平面図が `image/svg+xml` で返る。平面図の応答は `content-security-policy` と `x-content-type-options: nosniff` を持つ。案に無い階を求めると `404` で `not_found`、`storey` を付けずに求めると `400` で `invalid_request` が返る。
- `view-not-found`：存在しない案件と他人の案件は `この案件は見つかりません。`、それ以外の知らないパスは `このページはありません。` と出る。

## How to get to it (user POV)

- 案件一覧（`/`）の行を押す。`新しい案件を作る` を押すと、作った案件の画面へ移る（[案件](./projects.md)）。
- ブラウザで `/projects/<案件の ID>` を直接開く。Access のログインの後は、この URL へ戻る。
- 画面の上の `案件一覧` のリンクで一覧へ戻る。ブラウザの戻る・進むも使える。
- 指示は画面の指示欄から送る（[案件画面で指示を送り、会話を読む](./project-chat.md)）。下の手順のように `POST /api/patterns/<id>/messages` で送ったときは、画面を開き直す。
- 間取り図と 3D は、案の行の下の `間取り図` と `3D` のボタンで切り替える。階の一覧は `GET /api/revisions/<案の ID>/view` の応答の見出しで、平面図は `GET /api/revisions/<案の ID>/floor-plan?storey=<階の ID>` で読める。

## Driving it with T3 preview

Preconditions:

- Container が必要。実行中・待機中・保留の表示を確かめるときは、[SKILL.md の「起動」](../SKILL.md#起動)の手順で `MADORI_DEV_JOB_TEST_HOLD=first_answer:60` を付けて起動する。仕事は台本の AI の最初の応答の後に 60 秒待つので、状態の行を確かめる時間がある。
- 状態確認が通っている。
- `$EVIDENCE/project-view/` がある。`. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`D="$EVIDENCE/project-view"` と `J='content-type: application/json'` を設定している。
- 状態を読む関数を定義している。`st() { curl -sS "$API/patterns/$PAT/state" | jq -c '{running: .runningJob.number, queued: [.queuedJobs[].number], hold: .queueHold.job.number, revision: .currentRevision.number}'; }`

- **案件を作って開く。** `preview_open` に `target: { kind: "environment-port", port: <WEB_PORT> }`、`open: false`、`reuseExistingTab: false` を渡し、返った `tabId` を以後のすべての呼び出しに渡す。`preview_act` の `click` で `locator: 'role=button[name="新しい案件を作る"]'` を押す。`preview_wait_for` で `text: "まだ案がありません。"` と `urlIncludes: "/projects/"` を待つ。見出しが `新しい案件` で、その下に `パターン「パターン1」` が出て、`<日時> 作成` の日時が一覧のその行と同じ。`preview_evaluate` の `location.pathname` から ID を取り、`PID=<ID>` と `PAT=$(curl -sS "$API/projects/$PID/patterns" | jq -r '.patterns[0].id')` を設定する。
- **指示を送り、開き直す。** `curl -sS -o "$D/accept-1.json" -w '%{http_code}\n' -X POST "$API/patterns/$PAT/messages" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"body\":\"小さな平屋を作ってください。\"}"`。`202`。`st` の `running` が `1`。`preview_navigate` で同じタブを `target: { kind: "environment-port", port: <WEB_PORT>, path: "/projects/<PID>" }` に開き直し、`preview_wait_for` で `text: "指示を実行しています…"` を待つ。`preview_snapshot` に `save: true` を付けて撮り、`screenshotPath` を `$D/running.png` に写す。
- **確定を待つ。** 再読込せずに、`preview_wait_for` で `text: "確定済みの案1「台本の案」を表示しています。"` を `timeoutMs: 60000` で待つ。届かなければ、もう一度待つ。状態の行が消え、`間取り図` が選ばれた状態で間取り図が描かれる。`preview_act` の `click` で `locator: 'role=button[name="3D"]'` を押し、撮って `$D/drawn.png` に写し、Read で開いて、一部屋の 4 枚の壁と、床まで届くドアの開口と、窓の開口が見えることを確かめる。台本が色を塗るのは部屋の側の面なので、最初の視点からは見えないことがある。`preview_evaluate` で `performance.getEntriesByType('resource').filter((e) => e.name.includes('/state')).length` を 5 秒おいて二度読む。二つは同じで、読み直しが止まっている。
- **平面図の階を読む。** 確定を待った後に、`REV=$(curl -sS "$API/patterns/$PAT/state" | jq -r .currentRevision.id)` を設定する。`curl -sS -o "$D/view.bin" -D "$D/view.headers" -w '%{http_code} %{content_type}\n' "$API/revisions/$REV/view"`。`200 application/vnd.madori.display; version=1`。`STOREY=$(tr -d '\r' < "$D/view.headers" | sed -nE 's/^x-floor-plan-storeys: *//Ip')` が空でない一つの階の ID になり、`tr -d '\r' < "$D/view.headers" | grep -i '^x-revision-id:'` が `$REV` を出す。`curl -sS -o "$D/floor-plan.svg" -D "$D/floor-plan.headers" -w '%{http_code} %{content_type}\n' "$API/revisions/$REV/floor-plan?storey=$STOREY"`。`200 image/svg+xml` で、見出しに `x-revision-id: $REV`、`content-security-policy: default-src 'none'; frame-ancestors 'self'`、`x-content-type-options: nosniff` がある。`storey=s1` に変え、出力先を `"$D/floor-plan-other.json"` にして送ると、`404` で本文が `{"error":"not_found"}`。`storey` を外し、出力先を `"$D/floor-plan-no-storey.json"` にして送ると、`400` で本文が `{"error":"invalid_request"}`。
- **間取り図を見る。** `preview_act` の `click` で `locator: 'role=button[name="間取り図"]'` を押す。下の式を `preview_evaluate` で読む。`pressed` が `[["間取り図","true"],["3D","false"]]`、`panels` が `[["true",false,"visible"],["false",true,"hidden"]]`、`rooms` が `["LDK10.64 m²6.5畳"]`、`outer` が `["4,200","3,200"]`、`north` が `北（仮）`、`openings` が `["door","window"]` で、`canvas` が 0 でない大きさを持つ。`viewBox` を「全体を表示」のために控える。撮って `$D/plan.png` に写し、Read で開いて、部屋名・面積・畳数・`北（仮）`・外形寸法・ドアと窓が見え、右下の `拡大`・`縮小`・`全体を表示` が図面の文字に重ならないことを確かめる。

  <!-- prettier-ignore -->
  ```js
  (() => {
    const frame = document.querySelector('[role="group"][aria-label="間取り図"]');
    frame.scrollIntoView({ block: "center" });
    const svg = frame.querySelector("svg");
    const canvas = document.querySelector('[aria-label="住宅モデル"] canvas').getBoundingClientRect();
    return {
      pressed: [...document.querySelectorAll(".view-switch button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")]),
      panels: [...document.querySelectorAll(".view-panel")].map((p) => [p.dataset.active, p.inert, getComputedStyle(p).visibility]),
      rooms: [...svg.querySelectorAll(".room-label")].map((t) => t.textContent),
      outer: [...svg.querySelectorAll(".outer-dimension")].map((t) => t.textContent),
      north: svg.querySelector(".north").textContent,
      openings: [...svg.querySelectorAll(".opening")].map((o) => o.dataset.kind),
      canvas: [Math.round(canvas.width), Math.round(canvas.height)],
      viewBox: svg.getAttribute("viewBox"),
    };
  })()
  ```

- **部屋を選ぶ。** `preview_evaluate` で `(() => { const r = document.querySelector('.floor-plan .room-floor').getBoundingClientRect(); return { x: Math.round(r.left + r.width * 0.15), y: Math.round(r.top + r.height * 0.15) }; })()` を読み、`preview_act` の `click` にその `x` と `y` を渡す。下の式を読むと、`selected` が `["room selected"]`、`dimensions` が `[["3,800","2,800","3,800","2,800"]]` で、`viewBox` は押す前と同じ。撮って `$D/room-selected.png` に写し、部屋が色付きになり、内法の寸法が出ていることを確かめる。

  <!-- prettier-ignore -->
  ```js
  (() => ({ selected: [...document.querySelectorAll(".floor-plan .selected")].map((e) => e.getAttribute("class")), dimensions: [...document.querySelectorAll(".floor-plan g.dimensions")].filter((g) => getComputedStyle(g).display !== "none").map((g) => [...g.querySelectorAll("text")].map((t) => t.textContent)), viewBox: document.querySelector('[aria-label="間取り図"] svg').getAttribute("viewBox") }))()
  ```

- **窓の上で壁を選ぶ。** `preview_evaluate` で `(() => { const r = document.querySelector('.floor-plan .opening[data-kind="window"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()` を読み、`preview_act` の `click` にその `x` と `y` を渡す。上の式を読むと、`selected` が `["wall selected"]`、`dimensions` が `[["3,000","200"]]`。撮って `$D/wall-selected.png` に写し、窓のある壁が色付きになり、長さと厚さが出ていることを確かめる。
- **選択を消す。** 押した後の図面にはフォーカスがある。`preview_act` の `press` で `key: "Escape"` を送る。上の式の `selected` と `dimensions` が `[]` になる。
- **間取り図を拡大する。** 下の式を `preview_evaluate` で読む。`defaultPrevented` が `true`、`width` が控えた `viewBox` の幅の約 0.3 倍（台本の案なら `2275`）、`drift` が 1 より小さい。カーソルの下の点が動いていない。

  <!-- prettier-ignore -->
  ```js
  (async () => {
    const frame = document.querySelector('[role="group"][aria-label="間取り図"]');
    const svg = frame.querySelector("svg");
    const r = svg.querySelector(".room-floor").getBoundingClientRect();
    const x = Math.round(r.left + r.width * 0.2), y = Math.round(r.top + r.height * 0.2);
    const at = () => { const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse()); return [p.x, p.y]; };
    const before = at();
    const accepted = frame.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const after = at();
    return { defaultPrevented: !accepted, width: Math.round(svg.viewBox.baseVal.width), drift: Math.hypot(after[0] - before[0], after[1] - before[1]) };
  })()
  ```

- **間取り図を動かす。** `preview_act` の `drag` で、`source` に `role=group[name="間取り図"]`、`target` に `role=button[name="3D"]` を渡す。「部屋を選ぶ」の式を読むと、`viewBox` の初めの二つの数が増え、幅と高さは変わらない。`selected` は動かす前のまま。`3D` の上で離しても、`間取り図` が選ばれたまま。撮って `$D/plan-panned.png` に写す。
- **全体を表示する。** `preview_act` の `click` で `locator: 'role=button[name="全体を表示"]'` を押す。`viewBox` が「間取り図を見る」で控えた値に戻る。
- **3D に切り替える。** `preview_act` の `click` で `locator: 'role=button[name="3D"]'` を押す。「間取り図を見る」の式の `panels` が `[["false",true,"hidden"],["true",false,"visible"]]` になり、`canvas` は切り替える前と同じ大きさ。撮って `$D/model.png` に写し、モデルが枠いっぱいの大きさで描かれていることを確かめる。`間取り図` を押して戻す。
- **次の案で描き替わる。** 部屋か壁を選んでから、指示欄に `窓を大きくしてください。` と書いて `送信` を押し、`preview_wait_for` で `text: "確定済みの案2"` を `timeoutMs: 60000` で待つ。`preview_evaluate` で `performance.getEntriesByType('resource').filter((e) => /\/revisions\//.test(e.name)).map((e) => e.name.replace(location.origin, ''))` を読むと、案ごとに `/view` と `/floor-plan?storey=…` が一つずつ、同じ案の ID で並ぶ。台本の案2は同じ部屋と壁を持つので、選んだ要素は選ばれたまま。
- **保留を見る。** 二つ送る。上の「指示を送り、開き直す」の `curl` を、本文を `保留の確認1` と `保留の確認2`、出力先を `"$D/accept-a.json"` と `"$D/accept-b.json"` にして続けて送る。どちらも `202`。`st` が `running` に一件、`queued` に一件を返すまで待つ。開き直して、`preview_wait_for` で `text: "待機中の指示が1件あります。"` を待つ。`A=$(jq -r .job.jobId "$D/accept-a.json")` で `curl -sS -o "$D/stop-a.json" -w '%{http_code}\n' -X POST "$API/jobs/$A/stop" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\"}"`。`200` で、`outcome` が `stopped`。再読込せずに、`preview_wait_for` で `text: "待機中の指示（1件）が保留されています。"` を待つ。会話の欄では、`保留の確認2` の行に `保留中` が付き、`保留の確認1` の行には何も付かない。撮って `$D/held.png` に写す。開き直しても同じ行が出て、`/state` の読み出しの回数は 4 秒おいても増えない。開いたときは会話を読んだ後に state をもう一度読むので、回数は 2 になる。
- **保留を解く。** `curl -sS -o "$D/cancel.json" -w '%{http_code}\n' -X POST "$API/patterns/$PAT/queue/cancel" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"heldBy\":\"$A\"}"`。`200`。`st` の `running` が `null`、`queued` が `[]`、`hold` が `null`。片付けの前に、必ずこの状態にする。
- **起動し直して開く。** 片付けてから起動し直し、起動の確認で新しい `WEB_PORT` を得る。`preview_navigate` で同じタブを `target: { kind: "environment-port", port: <新しい WEB_PORT>, path: "/projects/<PID>" }` に開く。前と同じ案件名、パターン名、日時、案が出る。`preview_evaluate` で `Object.keys(localStorage)` が `[]` で、画面がブラウザに保存した値を使っていないことも確かめる。
- **戻る・進む。** `preview_act` の `click` で `locator: 'role=link[name="案件一覧"]'` を押すと、見出しが `案件一覧` になる。`preview_evaluate` で `history.back()` と `history.forward()` を順に実行し、それぞれ見出しが `新しい案件` と `案件一覧` に戻ることを確かめる。
- **回す。** `preview_act` の `click` で `locator: 'role=button[name="3D"]'` を押す。開き直すと `間取り図` が選ばれているので、3D の手順の前には毎回押す。案が描かれている状態で、`preview_snapshot` に `save: true` を付けて撮り、`$D/before-rotate.png` に写す。`preview_act` の `drag` で、`source` に `role=img[name="住宅モデル"]`、`target` に `role=heading[name="パターン1"]` を渡す。撮り直して `$D/rotated.png` に写す。`shasum -a 256` が `before-rotate.png` と違い、絵の中でモデルの向きが変わっている。
- **拡大する。** `preview_evaluate` で、キャンバスの中央に `wheel` を送る。返り値の `defaultPrevented` が `true` なら、ビューアが受け取っている。撮り直して `$D/zoomed.png` に写す。`rotated.png` と比べて、モデルが大きく写っている。

  <!-- prettier-ignore -->
  ```js
  (() => {
    const canvas = document.querySelector('[role="img"][aria-label="住宅モデル"] canvas');
    const box = canvas.getBoundingClientRect();
    const accepted = canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, deltaMode: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true, cancelable: true }));
    return { defaultPrevented: !accepted };
  })()
  ```

- **戻す。** 回した後か拡大した後に、`preview_act` の `click` で `locator: 'role=button[name="視点を戻す"]'` を押す。撮り直して `$D/reset.png` に写す。モデルが `drawn.png` と同じ向きと大きさに戻る。ページのスクロールが同じなら、何度戻しても `shasum -a 256` が一致する。
- **動かす。** 戻した状態で、`preview_evaluate` で右ボタンのドラッグを送る。返り値の `contextMenuPrevented` が `true` なら、右クリックのメニューを止めている。撮り直して `$D/panned.png` に写す。`reset.png` と比べて、モデルが回らずに左上へ動いている。手前の角ほど大きく動くのは、透視の見え方である。

  <!-- prettier-ignore -->
  ```js
  (async () => {
    const canvas = document.querySelector('[role="img"][aria-label="住宅モデル"] canvas');
    const box = canvas.getBoundingClientRect();
    const x0 = box.left + box.width / 2, y0 = box.top + box.height / 2;
    const fire = (type, x, y, button, buttons, shiftKey = false) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y, button, buttons, shiftKey, bubbles: true, cancelable: true }));
    fire("pointerdown", x0, y0, 2, 2);
    const contextMenuPrevented = !canvas.dispatchEvent(new MouseEvent("contextmenu", { button: 2, clientX: x0, clientY: y0, bubbles: true, cancelable: true }));
    for (let i = 1; i <= 10; i++) { fire("pointermove", x0 - 18 * i, y0 - 6 * i, -1, 2); await new Promise((r) => requestAnimationFrame(r)); }
    fire("pointerup", x0 - 180, y0 - 60, 2, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { contextMenuPrevented };
  })()
  ```

- **Shift で動かして戻る。** 同じ式を、押す位置を `x0 - 180, y0 - 60`、動かす向きを `+18 * i, +6 * i`、`button` を `0`、`buttons` を `1` にし、`contextmenu` の行を除き、`pointerdown` と最初の 4 回の `pointermove` で `shiftKey` を `true`、残りを `false` にして送る。途中で Shift を離しても移動のまま続く。撮り直すと、`reset.png` と同じハッシュになる。
- **部屋の中を見る。** 右ボタンのドラッグで窓のある壁を中央へ寄せ、上の「拡大する」の `wheel` を 4 回送る。窓の開口が画面いっぱいに見える。`視点を戻す` を押すと、`reset.png` と同じハッシュに戻る。
- **案が無いときのボタン。** 新しい案件を作って開き、`まだ案がありません。` が出たら、`preview_evaluate` で `[...document.querySelectorAll("button")].find((e) => e.textContent === "視点を戻す").disabled` を読む。`true` になる。

- **見つからない案件とページ。** `preview_navigate` で `path: "/projects/00000000-0000-4000-8000-000000000000"` を開く。`[role="alert"]` が `この案件は見つかりません。` で、`案件一覧` のリンクがある。`path: "/nope"` を開くと、`[role="alert"]` が `このページはありません。 案件一覧へ` になる。

## Gotchas

- 画面は、どの仕事が最後に終わったか（`lastFinishedJob`）をまだ表示しない。表示は #113 で加える。終わり方は `stop` の応答や state で確かめる。
- 何も動いていない画面は、状態を読み直さない。画面を開いたまま curl で指示を送っても、開き直すまで表示は変わらない。送ってから開くか、送った後に開き直す。画面の指示欄から送れば、その場で読み直しを始める。
- 仕事が速く終わると、開き直したときにはもう確定していて、実行中の行は見えない。実行中の表示を確かめるときは `MADORI_DEV_JOB_TEST_HOLD=first_answer:60` で起動する。
- ビューアは、状態の行の下にあり、高さが画面の 65% ほどある。案の名前と状態の行はビューアの上なので、スクロールせずに読める。
- `preview_act` の `scroll` は、キャンバスに `wheel` を送らない。拡大は `preview_evaluate` で合成した `WheelEvent` で確かめ、報告にもそう書く。実際のホイールやトラックパッドの操作感は確かめていない。
- `preview_act` の `drag` は、`button: "right"` も `modifiers: ["Shift"]` も無視し、いつも左ボタンだけで送る。視点の移動は回転として届く。移動は `preview_evaluate` で合成した `PointerEvent` で確かめ、報告にもそう書く。合成したイベントは既定の動作を起こさないので、実際のマウスでの右クリックのメニューやフォーカスの動きは確かめていない。Windows で右ボタンをキャンバスの外で離したときのメニューも確かめていない。
- 見出しまでのドラッグは大きく回り、床を下から見た向きになる。向きが変わったことの証拠としては足りる。ドラッグの前にページが少しスクロールするので、`before-rotate.png` との差には位置のずれも含まれる。絵を見て確かめる。
- WebGPU のキャンバスは、`drawImage` や `toDataURL` で画素を読み出すと透明になる。描かれたことは、スクリーンショットを Read で見て確かめる。
- Worker のポートで配る画面には、認証のトークンが付かない。一覧も案件も `読み込みに失敗しました。` と出る。画面は画面のポート（`WEB_PORT`）で開く。
- 新しいイメージの最初の仕事は、Container を冷えた状態から起こすので 1 分近くかかることがある。その間は `指示を実行しています…` のまま。
- WebGPU の無いブラウザでは `WebGPUを利用できるブラウザで開いてください。` と出る。T3 のプレビューの Chromium は WebGPU を使える。
- Rust や Wasm を変えたら、起動し直すまで画面に反映されない。
- 平面図を持たない案（版1）の、空の階の一覧と `404` の平面図は、手元の新しい D1 では作れない。`apps/worker/tests/revisions.test.ts` が確かめている。アプリで確かめたと書かない。
- `curl -D` が書く見出しの行末には `\r` が付く。空の値は `tr -d '\r'` を通してから `grep` で確かめる。
- 隠れた側の表示は `inert` なので、`preview_act` は届かない。3D の手順は `3D` を、間取り図の手順は `間取り図` を押してから行う。
- 部屋の多角形を `preview_act` の `click` に `selector` で渡すと、真ん中の部屋名の文字が上にあるため、Playwright は別の要素に遮られたとみなして 15 秒で失敗する。要素の箱から求めた座標で押す。
- `preview_act` の `scroll` は、間取り図にも `wheel` を送らない。間取り図の拡大は合成した `WheelEvent` で確かめ、報告にもそう書く。`clientX` と `clientY` は整数にする。Chrome は合成したマウスのイベントの座標の小数を切り捨てるので、小数を渡すと、切り捨てた分だけカーソルの下の点がずれて見える。
- 間取り図の移動は左ドラッグなので、`preview_act` の `drag` で本物の操作として確かめられる。
