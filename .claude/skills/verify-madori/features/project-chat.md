# 案件画面で指示を送り、会話を読む

案件画面（`/projects/<案件の ID>`）は、左に住宅の表示領域、右に会話と指示欄を並べる。画面の幅が 60rem より狭いと、表示領域の下に会話が来る。会話は受け付けた順に上から並び、新しい行が増えると一番下まで送られる。指示欄の `送信` はいつでも押せ、AI が編集している間に送った指示はサーバーの待機列に入る。指示の行には、送信中は `送信中…`、受け付けた直後は `受付済み`、実行中は `実行中`、待機中は `待機中（N番目）`、待機列が保留なら `保留中` が付き、終わると何も付かない。仕事が確定すると、その下に AI の説明が `案N「名前」` を添えて並び、表示領域が新しい案に変わる。送信の結果を受け取れなかった指示は `未送信` と理由と `再送` を出し、送れたとは表示しない。`再送` は最初と同じ request ID と本文を送るので、サーバーが実は受け付けていても仕事は増えない。画面は、指示を一件ずつ、送った順に送る。

## Sub-features

- `chat-send`：指示欄に書いて `送信` を押すと、指示欄が空になり、会話の最後に `指示` の行が `送信中…` で出て、受け付けられると `実行中` か `待機中（N番目）` になる。空白だけのあいだ `送信` は押せない。16384 バイトを超えると `指示が長すぎます（16384バイトまで）。` が出て押せない。
- `chat-queue`：一件目の実行中に二件目を送ると、二件目は `待機中（1番目）` になる。一件目が確定すると、会話の最後に一件目の説明が並び、二件目が `実行中` になり、続けて二件目の説明が並ぶ。会話は番号の順なので、二件目を一件目の確定より前に送ると、一件目の説明は二件目の指示の下に来る。表示する案は `案1` から `案2` へ順に変わる。
- `chat-kinds`：指示と回答は右寄せ、AI の説明・質問・お知らせは左寄せで、行の頭に `指示`・`回答`・`AI`・`AIの質問`・`お知らせ` が出る。質問は選択肢の一覧を、お知らせは `role="note"` を持つ。手元の台本は指示と説明だけを書くので、回答・質問・お知らせの表示は `conversation-view.test.ts` が確かめる。
- `chat-unsent`：送信が通信の失敗で終わると、行が `未送信` と `通信できず送信できませんでした。接続を確認して再送してください。` と `再送` を出す。15 秒答えが無いときも同じになる。`再送` を押すと同じ request ID と本文で送り直し、受け付けられると通常の行に変わる。
- `chat-lost-response`：サーバーが受け付けたのに応答だけが失われると、サーバーの `指示` の行（`実行中` か `待機中`）と `未送信` の行が並ぶ。`再送` を押すと同じ仕事が返り、行は一つになる。会話の指示も仕事も増えない。
- `chat-caption`：表示領域の見出しの下に、`確定済みの案N「名前」を表示しています。` が出る。仕事が動いている間は、後ろに `AIが編集中です。` が付く。案が無く仕事が動いているときは `AIが最初の案を編集中です。`、何も無いときは `まだ案がありません。` になる。

## How to get to it (user POV)

- 案件一覧（`/`）で案件を開くか作る。ブラウザで `/projects/<案件の ID>` を開いてもよい（[案件画面で案を見る](./project-view.md)）。
- 指示欄（`role=textbox[name="指示"]`）に書き、`送信` を押す。`未送信` の行の `再送` で送り直す。
- 会話は開いたときに最新の 50 行を読む。それより古い行は画面からはまだ読めない（#218）。

## Driving it with T3 preview

Preconditions:

- Container が必要。[SKILL.md の「起動」](../SKILL.md#起動)の手順で `MADORI_DEV_JOB_TEST_HOLD=first_answer:20` を付けて起動する。仕事は台本の AI の最初の応答の後に 20 秒待つので、二件目が待機中になっている間に画面を撮れる。
- 状態確認が通っている。
- `$EVIDENCE/project-chat/` がある。`. "$EVIDENCE/dev.env"` で `API` を読み込み、`D="$EVIDENCE/project-chat"` を設定している。

- **案件を作って開く。** `preview_open` に `target: { kind: "environment-port", port: <WEB_PORT> }`、`open: false`、`reuseExistingTab: false` を渡し、返った `tabId` を以後のすべての呼び出しに渡す。`preview_resize` に `mode: "freeform"`、`width: 1280`、`height: 800` を渡す。`preview_act` の `click` で `locator: 'role=button[name="新しい案件を作る"]'` を押し、`preview_wait_for` で `text: "まだ案がありません。"` を待つ。`preview_evaluate` の `location.pathname` から ID を取り、`PID=<ID>` と `PAT=$(curl -sS "$API/projects/$PID/patterns" | jq -r '.patterns[0].id')` を設定する。
- **二つ続けて送る。** `preview_act` の `type` で `locator: 'role=textbox[name="指示"]'`、`clear: true` を付けて `小さな平屋を作ってください。` を入れ、`click` で `role=button[name="送信"]` を押す。すぐに同じ `type` で `窓を大きくしてください。` を入れて、もう一度 `送信` を押す。`preview_wait_for` で `text: "待機中（1番目）"` を待つ。一件目の行に `実行中`、二件目の行に `待機中（1番目）` が付き、`[role="status"]` が `指示を実行しています…待機中の指示が1件あります。`、見出しの下が `AIが最初の案を編集中です。` になる。撮って `$D/queued.png` に写す。
- **順に完了するのを見る。** 再読込せずに、`preview_wait_for` で `text: "確定済みの案1「台本の案」を表示しています。"` を `timeoutMs: 60000` で待つ。届かなければ、もう一度待つ。会話の最後に `AI` の説明と `案1「台本の案」` が並び、二件目が `実行中` になる。撮って `$D/first-done.png` に写す。続けて `text: "確定済みの案2「台本の案」を表示しています。"` を `timeoutMs: 60000` で待つ。会話が `指示`・`指示`・`AI`（`案1「台本の案」`）・`AI`（`案2「台本の案」`）の順に並び、指示の行に印が無く、`[role="status"]` が無い。撮って `$D/both-done.png` に写す。`curl -sS "$API/patterns/$PAT/messages" | jq -c '[.messages[] | [.number, .kind, .revision.number]] | reverse'` が `[[1,"instruction",1],[2,"instruction",2],[3,"explanation",1],[4,"explanation",2]]` を返す。二件目は一件目の確定より前に受け付けたので、一件目の説明は番号 3 になり、二件目の指示の下に並ぶ。
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
- **狭い画面。** `preview_resize` に `mode: "freeform"`、`width: 800`、`height: 1400` を渡すと、会話が表示領域の下に来る。撮って `$D/narrow.png` に写す。

## Gotchas

- 未送信と応答の喪失は、`preview_evaluate` で `fetch` を差し替えて作る。ブラウザの通信を本当に切ってはいないので、報告にもそう書く。差し替えは、開き直すと消える。差し替えの式は、一回の読み込みにつき一回だけ実行する。開き直さずに二回実行すると、成功した送信が `window.__posts` に二つずつ残る。
- 未送信の行は画面のメモリにだけあり、再読込すると消える。ブラウザに保存しない。
- 仕事が動いていない画面は、state を読み直さない。curl で指示を送っても、画面は開き直すまで変わらない。画面から送れば、その場で読み直しを始める。
- `JOB_TEST_HOLD` を付けずに起動すると、仕事が速く終わり、`待機中（1番目）` を撮る前に二件目が動くことがある。
- 片付けの前に、すべての仕事が終わったことを state で確かめる（SKILL.md「片付け」）。
