# サンプルの住宅モデルを見る

開発画面を開くと、画面は案件「開発用サンプル」を作り、そのパターンへ指示を一件送る。指示の仕事が終わると、確定した案の表示データを WebGPU で描く。サンプルは床と 3 枚の壁で、奥の壁に開口がある。再読込しても、同じ要求を送り直すだけで、案件も仕事も増えない。利用者はドラッグで回転し、ホイールで拡大・縮小する。仕事が失敗・停止すると、理由と `もう一度送る` のボタンが出る。通信や API が失敗すると、理由と `再試行` のボタンが出る。

## Sub-features

- `view-render`：状態の表示が消え、確定した案が描かれ、`案1「サンプルの形」を表示しています。` が出る。
- `view-reload`：再読込しても、案件・仕事・案の数が変わらず、同じ案が描かれる。
- `view-rotate`：ドラッグでモデルが回る。
- `view-zoom`：ホイールで拡大・縮小する。
- `view-failure`：仕事が失敗すると、警告と `もう一度送る` が出る。再読込しても仕事は増えない。
- `view-stopped`：仕事を止めると、警告と `もう一度送る` が出る。押すと新しい指示が送られ、案が描かれる。

## How to get to it (user POV)

- ブラウザで画面のポート（`pnpm dev` が出す `Web: …` の URL）を開く。
- 見出し `instant-madori` の下に、`サンプルの住宅モデル` という名前の画像の領域がある。
- 画面がどの案件を使うかは、ブラウザの `localStorage` の `instant-madori.dev-sample` に保存した要求で決まる。この値を消すと、次に開いたときに新しい案件と仕事を作る。

## Driving it with T3 preview

Preconditions:

- 状態確認が通っている。
- `$EVIDENCE/sample-view/` がある。`. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`D="$EVIDENCE/sample-view"` と `J='content-type: application/json'` を設定している。
- 数を数える関数を定義している。`counts() { curl -sS "$API/projects" >| "$D/${1}-projects.json"; PID=$(jq -r '[.projects[] | select(.name == "開発用サンプル")] | first | .id' "$D/${1}-projects.json"); PAT=$(curl -sS "$API/projects/$PID/patterns" | jq -r '.patterns[0].id'); curl -sS -o "$D/${1}-state.json" "$API/patterns/$PAT/state"; curl -sS -o "$D/${1}-revisions.json" "$API/patterns/$PAT/revisions"; jq -c '{projects: (.projects | length)}' "$D/${1}-projects.json"; jq -c '{lastJob: .lastFinishedJob.number, revision: .currentRevision.number}' "$D/${1}-state.json"; jq -c '{revisions: (.revisions | length)}' "$D/${1}-revisions.json"; }`

- **開く。** `preview_open` に `target: { kind: "environment-port", port: <WEB_PORT> }`、`open: false`、`reuseExistingTab: false` を渡す。返った `tabId` を、以後のすべての呼び出しに渡す。題が `instant-madori 開発環境` になる。
- **描画を待つ。** `preview_evaluate` で次を実行する。`ready: true` が返れば描かれている。`alert` が返ったら、その文が失敗の理由。`preview_evaluate` は 15 秒で打ち切られるので、一回の待ちは 12 秒で区切る。`ready` も `alert` も返らなければ、もう一度実行する。

  <!-- prettier-ignore -->
  ```js
  new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const alert = document.querySelector('[role="alert"]');
      const busy = document.querySelector('[role="status"]');
      const canvas = document.querySelector('[role="img"][aria-label="サンプルの住宅モデル"] canvas');
      if (alert) resolve({ ready: false, alert: alert.textContent });
      else if (!busy && canvas) resolve({ ready: true, shown: [...document.querySelectorAll("main p")].map((p) => p.textContent), width: canvas.width, height: canvas.height });
      else if (Date.now() - started > 12000) resolve({ ready: false, status: busy?.textContent ?? null });
      else setTimeout(tick, 250);
    };
    tick();
  })
  ```

- **描画を残す。** `shown` に `案1「サンプルの形」を表示しています。` がある。`preview_snapshot` に `save: true` を付けて撮り、`screenshotPath` を `$D/rendered.png` に写す。Read で開き、床と 3 枚の壁と、奥の壁の開口が見えることを確かめる。`counts before` を実行する。`projects` が 1 以上、`lastJob` と `revision` と `revisions` がどれも `1`。
- **再読込する。** `preview_navigate` で同じタブを `target: { kind: "environment-port", port: <WEB_PORT> }` に開き直し、描画を待つ手順をもう一度実行する。`shown` は前と同じ。`counts after` の三行が `counts before` と同じ。`$EVIDENCE/dev.log` には、再読込の間も `acceptance` が `replayed` の受付の行だけが増え、`applied` は増えない。
- **回す。** `save` を付けない `preview_snapshot` で、`img "サンプルの住宅モデル"` と `heading "instant-madori"` の ref を取る。`preview_act` の `drag` で、`source` に `aria-ref=<画像の ref>`、`target` に `aria-ref=<見出しの ref>` を渡す。撮り直して `rotated.png` に写す。`shasum -a 256` が `rendered.png` と違い、絵の中でモデルの向きが変わっている。
- **拡大する。** `preview_evaluate` で、キャンバスの中央に `wheel` を送る。返り値の `defaultPrevented` が `true` なら、ビューアが受け取っている。撮り直して `zoomed.png` に写す。`rotated.png` と比べて、モデルが大きく写っている。

  <!-- prettier-ignore -->
  ```js
  (() => {
    const canvas = document.querySelector('[role="img"][aria-label="サンプルの住宅モデル"] canvas');
    const box = canvas.getBoundingClientRect();
    const accepted = canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, deltaMode: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true, cancelable: true }));
    return { defaultPrevented: !accepted };
  })()
  ```

- **失敗を見る。** 片付けてから `MADORI_DEV_CONTAINERS=0` を付けて起動し直す。プレビューで `preview_evaluate` に `localStorage.removeItem("instant-madori.dev-sample")` を渡してから、ページを開き直して描画を待つ。`alert` が `サンプルの形を作れませんでした。 もう一度送る` になる。警告はキャンバスの下にあり、そのままでは画面の外なので、`preview_evaluate` で `document.querySelector('[role="alert"]').scrollIntoView({ block: "center" })` を実行してから撮り、`failure.png` に写す。`counts failed-1` を実行し、ページを開き直して同じ警告を待ってから `counts failed-2` を実行する。二つは同じで、`lastJob` が `1`、`revision` が `null`、`revisions` が `0`。
- **止めてから送り直す。** 片付けてから `MADORI_DEV_JOB_TEST_HOLD=before_render:60` を付けて起動し直す。`localStorage` の値を消してページを開き直し、`preview_evaluate` で `[role="status"]` が `サンプルの形を作っています…` になるのを待つ。`counts stop` で `PAT` を設定し、`JOB=$(jq -r .runningJob.jobId "$D/stop-state.json")` で `curl -sS -o "$D/stop.json" -w '%{http_code}\n' -X POST "$API/jobs/$JOB/stop" -H "$J" -H "$O" -d "{\"requestId\":\"$(uuidgen)\"}"`。`200` で `outcome` が `stopped`。画面の `alert` が `指示が止められました。 もう一度送る` になる。`save` を付けない `preview_snapshot` で `button "もう一度送る"` の ref を取り、`preview_act` で押す。待ちの間は `until curl -sS "$API/patterns/$PAT/state" | jq -e '.currentRevision != null' >/dev/null; do sleep 2; done` で確定を待ち、描画を待つ手順を実行する。`shown` に `案1「サンプルの形」を表示しています。` が出る。`counts resent` の `lastJob` が `2`、`revision` と `revisions` が `1`。

## Gotchas

- 画面は開くたびに、保存した二つの要求（案件の作成と指示）を送り直す。サーバーは同じ request ID の要求を記録した結果で返すので、何も増えない。`dev.log` に毎回 `POST /api/projects` と `POST /api/patterns/.../messages` が出るのは正常。
- 開発中の React の StrictMode は、最初の実行を中断してやり直す。そのため、一回の表示で `POST /api/projects` が同じ request ID で二回届き、ブラウザのネットワーク記録では一回目が `net::ERR_ABORTED` になる。案件は一つのまま。
- `pnpm dev` を起動し直すと、開いたままのタブを Vite が読み込み直し、保存した要求を送り直す。受付は `replayed` で、何も増えない。
- プレビューは画面を `http://localhost:<WEB_PORT>` で開く。`localStorage` はオリジンごとで、`pnpm dev` を起動し直すとポートが変わるので、起動し直した後に開いた画面は保存した要求を持たず、新しい案件と仕事を作る。
- `preview_act` の `scroll` は、キャンバスに `wheel` を送らない。拡大は `preview_evaluate` で合成した `WheelEvent` で確かめ、報告にもそう書く。実際のホイールやトラックパッドの操作感は確かめていない。
- 見出しまでのドラッグは大きく回り、床を下から見た向きになる。向きが変わったことの証拠としては足りる。
- ビューポート（1280×800）の外にある要素を `target` にすると、ページがスクロールしてからドラッグする。その後のスクリーンショットは、位置がずれる。
- Worker のポートで配る画面には、認証のトークンが付かない。案件の作成が 401 になり、`サンプルの取得に失敗しました。` と出る。画面は画面のポート（`WEB_PORT`）で開く。
- 新しいイメージの最初の仕事は、Container を冷えた状態から起こすので 1 分近くかかることがある。その間は `順番を待っています（前に0件）…` か `サンプルの形を作っています…` のまま。描画を待つ手順を、`ready` か `alert` が返るまで繰り返す。
- WebGPU の無いブラウザでは `WebGPUを利用できるブラウザで開いてください。` と出る。T3 のプレビューの Chromium は WebGPU を使える。
- `ドラッグで回転、スクロールで拡大・縮小できます。` は常に出ている案内で、状態の表示ではない。
- Rust や Wasm を変えたら、起動し直すまで画面に反映されない。
