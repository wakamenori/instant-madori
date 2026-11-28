# 案件画面で指示を送り、会話を読む

案件画面（`/projects/<案件の ID>`）は、左に住宅の表示領域、右に会話と指示欄を並べる。画面の幅が 60rem より狭いと、表示領域の下に会話が来る。会話は受け付けた順に上から並び、新しい行が増えると一番下まで送られる。指示欄の `送信` はいつでも押せ、AI が編集している間に送った指示はサーバーの待機列に入る。指示の行には、送信中は `送信中…`、受け付けた直後は `受付済み`、実行中は `実行中`、待機中は `待機中（N番目）`、待機列が保留なら `保留中` が付き、終わると何も付かない。仕事が確定すると、その下に AI の説明が `案N「名前」` を添えて並び、表示領域が新しい案に変わる。送信の結果を受け取れなかった指示は `未送信` と理由と `再送` を出し、送れたとは表示しない。`再送` は最初と同じ request ID と本文を送るので、サーバーが実は受け付けていても仕事は増えない。画面は、指示を一件ずつ、送った順に送る。指示欄には、画像を貼り付け、ドロップ、`画像を添える` のファイル選択で3枚まで添えられる。画面は画像を長辺 2,576 px 以下の JPEG に符号化し直して、添えた時点で登録する。登録が済むまで `送信` は押せず、送った指示は資産 ID を付けて届く。会話の行には添付の縮小画像が出て、押すと大きく表示される。

## Sub-features

- `chat-send`：指示欄に書いて `送信` を押すと、指示欄が空になり、会話の最後に `指示` の行が `送信中…` で出て、受け付けられると `実行中` か `待機中（N番目）` になる。空白だけのあいだ `送信` は押せない。16384 バイトを超えると `指示が長すぎます（16384バイトまで）。` が出て押せない。
- `chat-queue`：一件目の実行中に二件目を送ると、二件目は `待機中（1番目）` になる。一件目が確定すると、一件目の指示の直下に一件目の説明が並び、二件目が `実行中` になり、二件目の指示の下に二件目の説明が並ぶ。AI の説明・質問・お知らせは、それを書いた仕事の指示（質問への回答の仕事なら回答）の直下に並ぶので、二件目を一件目の確定より前に送り、一件目の説明が二件目より後の番号を持っても、一件目の説明は二件目の指示より上に来る。表示する案は `案1` から `案2` へ順に変わる。
- `chat-kinds`：指示と回答は右寄せ、AI の説明・質問・お知らせは左寄せで、行の頭に `指示`・`回答`・`AI`・`AIの質問`・`お知らせ` が出る。質問は選択肢の一覧を、お知らせは `role="note"` を持つ。質問と回答は `台本:question` で（[指示の状態と操作](./status.md)）、お知らせは上限到達で（[AI費用の上限](./cost-limit.md)）画面に出せる。
- `chat-unsent`：送信が通信の失敗で終わると、行が `未送信` と `通信できず送信できませんでした。接続を確認して再送してください。` と `再送` を出す。15 秒答えが無いときも同じになる。`再送` を押すと同じ request ID と本文で送り直し、受け付けられると通常の行に変わる。
- `chat-lost-response`：サーバーが受け付けたのに応答だけが失われると、サーバーの `指示` の行（`実行中` か `待機中`）と `未送信` の行が並ぶ。`再送` を押すと同じ仕事が返り、行は一つになる。会話の指示も仕事も増えない。
- `chat-attach`：画像を貼り付けると、指示欄に縮小画像と `取り消し` が出て、`POST /api/assets` へ JPEG が一度送られる。本文を書いて `送信` を押すと、指示が `attachmentIds` にその資産 ID を付けて送られ、指示の行に `添付画像1` の縮小画像が出る。登録した画像は長辺 2,576 px 以下の JPEG になる。
- `chat-attach-reload`：開き直しても指示の行に縮小画像が出る。画面は欄に見えている添付だけを `GET /api/assets/<ID>` で取得し、同じ資産は開いている間に一度だけ取得する。
- `chat-attach-enlarge`：縮小画像（`添付画像Nを拡大`）を押すと、ダイアログに大きな画像と `閉じる` が出る。Esc か `閉じる` か背景で閉じる。
- `chat-attach-refuse`：4枚目以降は登録せずに `画像は一つの指示に3枚まで添えられます。` を出す。画像でないファイルは `画像ファイルではありません。`、読み込めない画像は `この画像を読み込めませんでした。PNGやJPEGの画像を選んでください。`、縮小しても 7,499,997 バイトを超える画像は `画像を縮小しても大きすぎるため添えられません（7.5MBまで）。` を出し、どれも登録の要求を送らない。
- `chat-attach-retry`：登録が通信の失敗で終わると、その画像に `通信できず画像を登録できませんでした。再試行してください。` と `再試行` が出て、`送信` は押せない。`再試行` は同じ request ID で送り直す。
- `chat-caption`：表示領域の見出しの下に、`確定済みの案N「名前」を表示しています。` が出る。仕事が動いている間は、後ろに `AIが編集中です。` が付く。案が無く仕事が動いているときは `AIが最初の案を編集中です。`、何も無いときは `まだ案がありません。` になる。

## How to get to it (user POV)

- 案件一覧（`/`）で案件を開くか作る。ブラウザで `/projects/<案件の ID>` を開いてもよい（[案件画面で案を見る](./project-view.md)）。
- 指示欄（`role=textbox[name="指示"]`）に書き、`送信` を押す。`未送信` の行の `再送` で送り直す。
- 画像は、指示欄に貼り付けるか、指示欄にドロップするか、`画像を添える` で選ぶ。送る前の画像は `添付画像Nを取り消す` で外す。
- 会話は開いたときに最新の 50 行を読む。それより古い行は画面からはまだ読めない（#218）。

## Driving it with T3 preview

Preconditions:

- Container が必要。[SKILL.md の「起動」](../SKILL.md#起動)の手順で `MADORI_DEV_JOB_TEST_HOLD=first_answer:20` を付けて起動する。仕事は台本の AI の最初の応答の後に 20 秒待つので、二件目が待機中になっている間に画面を撮れる。
- 状態確認が通っている。
- `$EVIDENCE/project-chat/` がある。`. "$EVIDENCE/dev.env"` で `API` を読み込み、`D="$EVIDENCE/project-chat"` を設定している。

- **案件を作って開く。** `preview_open` に `target: { kind: "environment-port", port: <WEB_PORT> }`、`open: false`、`reuseExistingTab: false` を渡し、返った `tabId` を以後のすべての呼び出しに渡す。`preview_resize` に `mode: "freeform"`、`width: 1280`、`height: 800` を渡す。`preview_act` の `click` で `locator: 'role=button[name="新しい案件を作る"]'` を押し、`preview_wait_for` で `text: "まだ案がありません。"` を待つ。`preview_evaluate` の `location.pathname` から ID を取り、`PID=<ID>` と `PAT=$(curl -sS "$API/projects/$PID/patterns" | jq -r '.patterns[0].id')` を設定する。
- **二つ続けて送る。** `preview_act` の `type` で `locator: 'role=textbox[name="指示"]'`、`clear: true` を付けて `小さな平屋を作ってください。` を入れ、`click` で `role=button[name="送信"]` を押す。すぐに同じ `type` で `窓を大きくしてください。` を入れて、もう一度 `送信` を押す。`preview_wait_for` で `text: "待機中（1番目）"` を待つ。一件目の行に `実行中`、二件目の行に `待機中（1番目）` が付き、`[role="status"]` が `指示を実行しています…` で、その下に `待機中の指示が1件あります。止めると、待機中の指示は保留になります。` と `止める` が出て、見出しの下が `AIが最初の案を編集中です。` になる。撮って `$D/queued.png` に写す。
- **順に完了するのを見る。** 再読込せずに、`preview_wait_for` で `text: "確定済みの案1「台本の案」を表示しています。"` を `timeoutMs: 60000` で待つ。届かなければ、もう一度待つ。一件目の指示の直下に `AI` の説明と `案1「台本の案」` が並び、二件目が `実行中` になる。撮って `$D/first-done.png` に写す。続けて `text: "確定済みの案2「台本の案」を表示しています。"` を `timeoutMs: 60000` で待つ。会話が `指示`・`AI`（`案1「台本の案」`）・`指示`・`AI`（`案2「台本の案」`）の順に並び、指示の行に印が無く、`[role="status"]` が無い。撮って `$D/both-done.png` に写す。`curl -sS "$API/patterns/$PAT/messages" | jq -c '[.messages[] | [.number, .kind, .revision.number]] | reverse'` が `[[1,"instruction",1],[2,"instruction",2],[3,"explanation",1],[4,"explanation",2]]` を返す。二件目は一件目の確定より前に受け付けたので、一件目の説明は番号 3 になるが、画面では一件目の指示の直下に並ぶ。
- **未送信にして再送する。** `preview_evaluate` で次の式を実行し、次の一回の送信を通信の失敗にする。送った本文は `window.__posts` に残る。

  <!-- prettier-ignore -->
  ```js
  (() => {
    const real = window.fetch.bind(window);
    window.__posts = [];
    window.__failNext = "offline";
    window.fetch = async (input, init) => {
      if (init?.method === "POST" && String(input).endsWith("/messages")) {
        window.__posts.push(JSON.parse(init.body));
        const mode = window.__failNext;
        window.__failNext = null;
        if (mode === "offline") throw new TypeError("Failed to fetch");
        if (mode === "lost") { await real(input, init); throw new TypeError("Failed to fetch"); }
      }
      return real(input, init);
    };
    return "armed";
  })()
  ```

  同じ `type` で `居間を広くしてください。` を入れて `送信` を押す。`preview_wait_for` で `text: "未送信"` を待つ。行に `通信できず送信できませんでした。接続を確認して再送してください。` と `再送` が出る。欄は最後の行まで送られ、`再送` は手で送らなくても見える。`curl -sS "$API/patterns/$PAT/messages" | jq '[.messages[] | select(.kind == "instruction")] | length'` は `2` のまま。撮って `$D/unsent.png` に写す。`click` で `role=button[name="再送"]` を押し、`preview_wait_for` で `text: "確定済みの案3「台本の案」を表示しています。"` を `timeoutMs: 60000` で待つ。`preview_evaluate` で `window.__posts.map((p) => p.requestId)` を読むと二つの同じ値が返り、`window.__posts[0].body === window.__posts[1].body` が `true`。`curl -sS "$API/patterns/$PAT/messages" | jq '[.messages[] | select(.kind == "instruction")] | length'` が `3` になる。

- **応答だけを失う。** `preview_evaluate` で `window.__posts = []; window.__failNext = "lost"` を実行する。同じ `type` で `玄関を明るくしてください。` を入れて `送信` を押す。`preview_wait_for` で `text: "未送信"` を待つ。サーバーは受け付けているので、その上にサーバーの `指示` の行が `実行中` で並ぶ。撮って `$D/lost.png` に写す。`再送` を押し、`preview_wait_for` で `text: "確定済みの案4「台本の案」を表示しています。"` を `timeoutMs: 60000` で待つ。`未送信` の行は消え、`玄関を明るくしてください。` の行は一つだけ。`window.__posts` の二つの `requestId` は同じで、`curl -sS "$API/patterns/$PAT/messages" | jq '[.messages[] | select(.body == "玄関を明るくしてください。")] | length'` が `1`。
- **画像を用意する。** `command cp -f docs/verification/evidence/verification-01/02-customized-3d.png "$D/a.png"`、`sips -s format jpeg "$D/a.png" --out "$D/b.jpg"`、`sips -z 600 900 "$D/a.png" --out "$D/c.png"`、`sips -s format jpeg -z 500 500 "$D/a.png" --out "$D/d.jpg"`、`echo "not an image" >| "$D/note.txt"`。
- **画像を貼り付ける。** 前の手順の `fetch` の差し替えを消すため、`preview_navigate` で同じ `/projects/$PID` を開き直す。`preview_evaluate` で次の式を実行し、3200×2000 の PNG を指示欄に貼り付ける。合成した `paste` のイベントなので、報告にもそう書く。

  <!-- prettier-ignore -->
  ```js
  (async () => {
    const c = document.createElement("canvas"); c.width = 3200; c.height = 2000;
    const g = c.getContext("2d");
    g.fillStyle = "#a0522d"; g.fillRect(0, 0, 3200, 2000);
    g.fillStyle = "#2d6a4f"; g.fillRect(600, 700, 2000, 700);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer(); dt.items.add(new File([blob], "sofa.png", { type: "image/png" }));
    document.querySelector('textarea[aria-label="指示"]')
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    return blob.size;
  })()
  ```

  `preview_wait_for` で `locator: 'role=button[name="添付画像1を取り消す"]'` を待つ。指示欄に縮小画像が出る。本文が空なので `送信` は押せない。`preview_evaluate` の `performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/assets?")).length` が `1`。撮って `$D/attach-draft.png` に写す。

- **添えて送る。** `type` で `この写真のソファを居間に置いてください。` を入れて `送信` を押し、`preview_wait_for` で次の案の `確定済みの案N「台本の案」を表示しています。` を `timeoutMs: 60000` で待つ。指示の行に縮小画像が出る。`curl -sS "$API/patterns/$PAT/messages" | jq -r '.messages[] | select(.body == "この写真のソファを居間に置いてください。") | .attachmentIds[]'` が ID を一つ出す。その ID を `AID` にし、`curl -sS -o "$D/attach.jpg" -w '%{http_code}\n' "$API/assets/$AID"` が `200`、`sips -g pixelWidth -g pixelHeight "$D/attach.jpg"` が 2576×1610 で、`file "$D/attach.jpg"` が JPEG。
- **開き直す。** `preview_navigate` で同じ `/projects/$PID` を開き、`preview_wait_for` で `locator: 'role=button[name="添付画像1を拡大"]'` を待つ。撮って `$D/attach-reloaded.png` に写す。`preview_evaluate` の `performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/assets/")).map((e) => e.name)` が、見えている添付の ID を一つずつ出す。
- **大きく表示する。** `click` で `role=button[name="添付画像1を拡大"]` を押す。ダイアログに大きな画像と `閉じる` が出る。撮って `$D/attach-enlarged.png` に写し、`press` の `Escape` で閉じる。
- **枚数の上限。** `preview_act` の `upload` で `locator: "input[type=file]"`、`paths` に `$D/a.png`・`$D/b.jpg`・`$D/c.png`・`$D/d.jpg` の絶対パスを渡す。`preview_wait_for` で `text: "画像は一つの指示に3枚まで添えられます。"` を待つ。`取り消し` が三つ並び、開き直した後の `/api/assets?` の要求は `3`。撮って `$D/attach-limit.png` に写す。
- **画像でないファイル。** `click` で `role=button[name="添付画像3を取り消す"]` を押してから、同じ `upload` で `$D/note.txt` を渡す。`画像ファイルではありません。` が出て、`取り消し` は二つ、`/api/assets?` の要求は増えない。
- **登録の失敗と再試行。** `preview_evaluate` で次の式を実行し、次の一回の登録を通信の失敗にする。

  <!-- prettier-ignore -->
  ```js
  (() => {
    const real = window.fetch.bind(window);
    window.__uploads = []; window.__failUpload = true;
    window.fetch = async (input, init) => {
      if (init?.method === "POST" && String(input).startsWith("/api/assets?")) {
        window.__uploads.push(String(input));
        if (window.__failUpload) { window.__failUpload = false; throw new TypeError("Failed to fetch"); }
      }
      return real(input, init);
    };
    return "armed";
  })()
  ```

  同じ `upload` で `$D/d.jpg` を渡す。`preview_wait_for` で `text: "通信できず画像を登録できませんでした。再試行してください。"` を待つ。`送信` は押せない。`click` で `role=button[name="再試行"]` を押すと、メッセージが消える。`window.__uploads` の二つの URL は同じ `requestId` を持つ。`type` で `この3枚の写真の雰囲気に近づけてください。` を入れて `送信` を押し、次の案が確定するのを待つ。指示の行に縮小画像が三つ並ぶ。

- **狭い画面。** `preview_resize` に `mode: "freeform"`、`width: 800`、`height: 1400` を渡すと、会話が表示領域の下に来る。撮って `$D/narrow.png` に写す。

## Gotchas

- 画像の貼り付けは、`preview_evaluate` で合成した `paste` のイベントで確かめる。ファイル選択は `preview_act` の `upload` で、実際のファイルを `input[type=file]` に渡す。ドロップは手順に無い。
- 登録したが送らなかった画像は、未参照の画像の回収（初回提供の後）まで残る。
- 会話の欄の外にある古い行の添付は、欄をさかのぼって見えるまで取得しない。
- 未送信と応答の喪失は、`preview_evaluate` で `fetch` を差し替えて作る。ブラウザの通信を本当に切ってはいないので、報告にもそう書く。差し替えは、開き直すと消える。差し替えの式は、一回の読み込みにつき一回だけ実行する。開き直さずに二回実行すると、成功した送信が `window.__posts` に二つずつ残る。
- 未送信の行は画面のメモリにだけあり、再読込すると消える。ブラウザに保存しない。
- 仕事が動いていない画面は、state を読み直さない。curl で指示を送っても、画面は開き直すまで変わらない。画面から送れば、その場で読み直しを始める。
- `JOB_TEST_HOLD` を付けずに起動すると、仕事が速く終わり、`待機中（1番目）` を撮る前に二件目が動くことがある。
- 片付けの前に、すべての仕事が終わったことを state で確かめる（SKILL.md「片付け」）。
