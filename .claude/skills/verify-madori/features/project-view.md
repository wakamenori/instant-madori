# 案件画面で案を見る

案件画面（`/projects/<案件の ID>`）は、案件の最初のパターンを開き、現在の案の表示データを WebGPU で描く。見出しはパターン名で、その下にパターンを作った日時（`<日時> 作成`）、表示中の案、指示の状態が並ぶ。指示が実行中か待機中なら、状態を 1 秒ごとに読み直し、確定した案に描き替える。何も動いていないときと、待機列が保留のときは読み直さない。案件は URL で開くので、再読込しても、`pnpm dev` を起動し直して画面のポートが変わっても、同じパスで同じ案件が開く。画面からはまだ指示を送れない。利用者はドラッグで回転し、右ドラッグか、Shift か Ctrl を押したままのドラッグで視点を平行に動かし、ホイールで拡大・縮小する。ビューアの右上の `視点を戻す` を押すと、案の全体が入る最初の視点に戻る。ビューアの下に、この操作の案内が一行出る。案の表示データの応答には、その案の平面図がある階の一覧が付く。画面はまだ平面図を出さない（#115）。

## Sub-features

- `view-open`：案件を開くと、パターン名、`<日時> 作成`、`まだ案がありません。` か `案N「名前」を表示しています。` が出て、案があれば描かれる。
- `view-progress`：指示が実行中なら `指示を実行しています…`、後ろに待機中の指示があれば続けて `待機中の指示がN件あります。`、実行中が無く待機中だけなら `順番を待っています（N件）…` が出る。仕事が確定すると、再読込しなくても新しい案に描き替わり、状態の行が消える。
- `view-held`：待機列が保留になると `待機中の指示（N件）が保留されています。` が出て、状態の読み直しが止まる。
- `view-reopen`：再読込しても、起動し直した後に同じパスを開いても、同じ案件、同じ案、同じ状態が出る。
- `view-rotate`：ドラッグでモデルが回る。
- `view-zoom`：ホイールで拡大・縮小する。
- `view-pan`：右ドラッグ、Shift＋ドラッグ、Ctrl＋ドラッグで、モデルが回らずにカーソルについて平行に動く。動かしてから拡大すると、部屋の中を近くから見られる。中ボタンのドラッグでは何も動かない。キャンバスの上では右クリックのメニューが出ない。
- `view-reset`：`視点を戻す` を押すと、回転・移動・拡大のどの後でも、案を開いたときと同じ視点に戻る。案が無いあいだ、ボタンは押せない。
- `view-floor-plan`：仕事が作る案は平面図を持つので、表示データの応答の `x-floor-plan-storeys` に一つの階の ID が付き、その階の平面図が `image/svg+xml` で返る。平面図の応答は `content-security-policy` と `x-content-type-options: nosniff` を持つ。案に無い階を求めると `404` で `not_found`、`storey` を付けずに求めると `400` で `invalid_request` が返る。
- `view-not-found`：存在しない案件と他人の案件は `この案件は見つかりません。`、それ以外の知らないパスは `このページはありません。` と出る。

## How to get to it (user POV)

- 案件一覧（`/`）の行を押す。`新しい案件を作る` を押すと、作った案件の画面へ移る（[案件](./projects.md)）。
- ブラウザで `/projects/<案件の ID>` を直接開く。Access のログインの後は、この URL へ戻る。
- 画面の上の `案件一覧` のリンクで一覧へ戻る。ブラウザの戻る・進むも使える。
- 指示は、画面からはまだ送れない。`POST /api/patterns/<id>/messages` で送り、画面を開いておくか開き直す。
- 平面図は、画面からはまだ見られない。`GET /api/revisions/<案の ID>/view` の応答の見出しで階の一覧を、`GET /api/revisions/<案の ID>/floor-plan?storey=<階の ID>` で平面図を読む。

## Driving it with T3 preview

Preconditions:

- Container が必要。実行中・待機中・保留の表示を確かめるときは、[SKILL.md の「起動」](../SKILL.md#起動)の手順で `MADORI_DEV_JOB_TEST_HOLD=first_answer:60` を付けて起動する。仕事は台本の AI の最初の応答の後に 60 秒待つので、状態の行を確かめる時間がある。
- 状態確認が通っている。
- `$EVIDENCE/project-view/` がある。`. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`D="$EVIDENCE/project-view"` と `J='content-type: application/json'` を設定している。
- 状態を読む関数を定義している。`st() { curl -sS "$API/patterns/$PAT/state" | jq -c '{running: .runningJob.number, queued: [.queuedJobs[].number], hold: .queueHold.job.number, revision: .currentRevision.number}'; }`

- **案件を作って開く。** `preview_open` に `target: { kind: "environment-port", port: <WEB_PORT> }`、`open: false`、`reuseExistingTab: false` を渡し、返った `tabId` を以後のすべての呼び出しに渡す。`preview_act` の `click` で `locator: 'role=button[name="新しい案件を作る"]'` を押す。`preview_wait_for` で `text: "まだ案がありません。"` と `urlIncludes: "/projects/"` を待つ。見出しが `パターン1` で、`<日時> 作成` の日時が一覧のその行と同じ。`preview_evaluate` の `location.pathname` から ID を取り、`PID=<ID>` と `PAT=$(curl -sS "$API/projects/$PID/patterns" | jq -r '.patterns[0].id')` を設定する。
- **指示を送り、開き直す。** `curl -sS -o "$D/accept-1.json" -w '%{http_code}\n' -X POST "$API/patterns/$PAT/messages" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"body\":\"小さな平屋を作ってください。\"}"`。`202`。`st` の `running` が `1`。`preview_navigate` で同じタブを `target: { kind: "environment-port", port: <WEB_PORT>, path: "/projects/<PID>" }` に開き直し、`preview_wait_for` で `text: "指示を実行しています…"` を待つ。`preview_snapshot` に `save: true` を付けて撮り、`screenshotPath` を `$D/running.png` に写す。
- **確定を待つ。** 再読込せずに、`preview_wait_for` で `text: "案1「台本の案」を表示しています。"` を `timeoutMs: 60000` で待つ。届かなければ、もう一度待つ。状態の行が消え、モデルが描かれる。撮って `$D/drawn.png` に写し、Read で開いて、一部屋の 4 枚の壁と、床まで届くドアの開口と、窓の開口が見えることを確かめる。台本が色を塗るのは部屋の側の面なので、最初の視点からは見えないことがある。`preview_evaluate` で `performance.getEntriesByType('resource').filter((e) => e.name.includes('/state')).length` を 5 秒おいて二度読む。二つは同じで、読み直しが止まっている。
- **平面図の階を読む。** 確定を待った後に、`REV=$(curl -sS "$API/patterns/$PAT/state" | jq -r .currentRevision.id)` を設定する。`curl -sS -o "$D/view.bin" -D "$D/view.headers" -w '%{http_code} %{content_type}\n' "$API/revisions/$REV/view"`。`200 application/vnd.madori.display; version=1`。`STOREY=$(tr -d '\r' < "$D/view.headers" | sed -nE 's/^x-floor-plan-storeys: *//Ip')` が空でない一つの階の ID になり、`tr -d '\r' < "$D/view.headers" | grep -i '^x-revision-id:'` が `$REV` を出す。`curl -sS -o "$D/floor-plan.svg" -D "$D/floor-plan.headers" -w '%{http_code} %{content_type}\n' "$API/revisions/$REV/floor-plan?storey=$STOREY"`。`200 image/svg+xml` で、見出しに `x-revision-id: $REV`、`content-security-policy: default-src 'none'; frame-ancestors 'self'`、`x-content-type-options: nosniff` がある。`storey=s1` に変え、出力先を `"$D/floor-plan-other.json"` にして送ると、`404` で本文が `{"error":"not_found"}`。`storey` を外し、出力先を `"$D/floor-plan-no-storey.json"` にして送ると、`400` で本文が `{"error":"invalid_request"}`。
- **保留を見る。** 二つ送る。上の「指示を送り、開き直す」の `curl` を、本文を `保留の確認1` と `保留の確認2`、出力先を `"$D/accept-a.json"` と `"$D/accept-b.json"` にして続けて送る。どちらも `202`。`st` が `running` に一件、`queued` に一件を返すまで待つ。開き直して、`preview_wait_for` で `text: "待機中の指示が1件あります。"` を待つ。`A=$(jq -r .job.jobId "$D/accept-a.json")` で `curl -sS -o "$D/stop-a.json" -w '%{http_code}\n' -X POST "$API/jobs/$A/stop" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\"}"`。`200` で、`outcome` が `stopped`。再読込せずに、`preview_wait_for` で `text: "待機中の指示（1件）が保留されています。"` を待ち、撮って `$D/held.png` に写す。開き直しても同じ行が出て、`/state` の読み出しは 4 秒おいても 1 回のまま。
- **保留を解く。** `curl -sS -o "$D/cancel.json" -w '%{http_code}\n' -X POST "$API/patterns/$PAT/queue/cancel" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\",\"heldBy\":\"$A\"}"`。`200`。`st` の `running` が `null`、`queued` が `[]`、`hold` が `null`。片付けの前に、必ずこの状態にする。
- **起動し直して開く。** 片付けてから起動し直し、起動の確認で新しい `WEB_PORT` を得る。`preview_navigate` で同じタブを `target: { kind: "environment-port", port: <新しい WEB_PORT>, path: "/projects/<PID>" }` に開く。前と同じパターン名、日時、案が出る。`preview_evaluate` で `Object.keys(localStorage)` が `[]` で、画面がブラウザに保存した値を使っていないことも確かめる。
- **戻る・進む。** `preview_act` の `click` で `locator: 'role=link[name="案件一覧"]'` を押すと、見出しが `案件一覧` になる。`preview_evaluate` で `history.back()` と `history.forward()` を順に実行し、それぞれ見出しが `パターン1` と `案件一覧` に戻ることを確かめる。
- **回す。** 案が描かれている状態で、`preview_snapshot` に `save: true` を付けて撮り、`$D/before-rotate.png` に写す。`preview_act` の `drag` で、`source` に `role=img[name="住宅モデル"]`、`target` に `role=heading[name="パターン1"]` を渡す。撮り直して `$D/rotated.png` に写す。`shasum -a 256` が `before-rotate.png` と違い、絵の中でモデルの向きが変わっている。
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
- 何も動いていない画面は、状態を読み直さない。画面を開いたまま curl で指示を送っても、開き直すまで表示は変わらない。送ってから開くか、送った後に開き直す。
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
