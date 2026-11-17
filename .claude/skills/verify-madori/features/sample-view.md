# サンプルの住宅モデルを見る

開発画面を開くと、Worker、Durable Object、形状 Container を通して作ったサンプルが WebGPU で描かれる。サンプルは床と 3 枚の壁で、奥の壁に開口がある。利用者はドラッグで回転し、ホイールで拡大・縮小する。取得や描画に失敗すると、理由と再試行のボタンが出る。

## Sub-features

- `view-render`：読み込み中の表示が消え、モデルが描かれる。
- `view-rotate`：ドラッグでモデルが回る。
- `view-zoom`：ホイールで拡大・縮小する。
- `view-failure`：形状サービスを使えないと、警告と `再試行` が出る。

## How to get to it (user POV)

- ブラウザで `http://127.0.0.1:5173` を開く。
- 見出し `instant-madori` の下に、`サンプルの住宅モデル` という名前の画像の領域がある。

## Driving it with T3 preview

Preconditions:

- 状態確認が通り、`/api/sample/display` が `200 application/vnd.madori.display; version=1` を返している。
- `$EVIDENCE/sample-view/` がある。

- **開く。** `preview_open` に `target: { kind: "environment-port", port: 5173 }`、`open: false`、`reuseExistingTab: false` を渡す。返った `tabId` を、以後のすべての呼び出しに渡す。題が `instant-madori 開発環境` になる。
- **描画を待つ。** `preview_evaluate` で次を実行する。`ready: true` が返れば描かれている。`alert` が返ったら、その文が失敗の理由。

  <!-- prettier-ignore -->
  ```js
  new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const alert = document.querySelector('[role="alert"]');
      const busy = document.querySelector('[role="status"]');
      const canvas = document.querySelector('[role="img"][aria-label="サンプルの住宅モデル"] canvas');
      if (alert) resolve({ ready: false, alert: alert.textContent });
      else if (!busy && canvas) resolve({ ready: true, width: canvas.width, height: canvas.height });
      else if (Date.now() - started > 90000) resolve({ ready: false, status: busy?.textContent ?? null });
      else setTimeout(tick, 250);
    };
    tick();
  })
  ```

- **描画を残す。** `preview_snapshot` に `save: true` を付けて撮り、`screenshotPath` を `$EVIDENCE/sample-view/rendered.png` に写す。Read で開き、床と 3 枚の壁と、奥の壁の開口が見えることを確かめる。
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

- **失敗を見る。** 片付けてから `MADORI_DEV_CONTAINERS=0` を付けて起動し直す。`/api/sample/display` が `503` と `{"error":"service_unavailable"}` を返す。ページを開き、描画を待つ手順を実行すると、`alert` が `形状サービスを利用できません。しばらくしてから再試行してください。 再試行` になる。撮って `failure.png` に写す。

## Gotchas

- `preview_act` の `scroll` は、キャンバスに `wheel` を送らない。拡大は `preview_evaluate` で合成した `WheelEvent` で確かめ、報告にもそう書く。実際のホイールやトラックパッドの操作感は確かめていない。
- 見出しまでのドラッグは大きく回り、床を下から見た向きになる。向きが変わったことの証拠としては足りる。
- ビューポート（1280×800）の外にある要素を `target` にすると、ページがスクロールしてからドラッグする。その後のスクリーンショットは、位置がずれる。
- 8787 番で配る画面には、認証のトークンが付かない。サンプルの取得が 401 になり、`サンプルの取得に失敗しました。` と出る。画面は 5173 番で開く。
- 初回は amd64 イメージのビルドに数分かかる。Container の起動待ちは最大 60 秒で、その間は `サンプルを読み込んでいます…` のまま。
- WebGPU の無いブラウザでは `WebGPUを利用できるブラウザで開いてください。` と出る。T3 のプレビューの Chromium は WebGPU を使える。
- `ドラッグで回転、スクロールで拡大・縮小できます。` は常に出ている案内で、状態の表示ではない。
- Rust や Wasm を変えたら、起動し直すまで画面に反映されない。
