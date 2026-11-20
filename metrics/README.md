# Software Factoryの計測

このフォルダーには、Issueが着手されてからstagingに反映されるまでの流れを計測する仕組みを置く。計測は、サービス（`apps/`、`crates/`、`packages/`）から独立した開発の道具である。記録はこのマシンのSQLiteに溜め、それを読むviewerもこのフォルダーに置く。

## 計測で答える問い

計測は、次の問いに数字で答える。

- 一つのIssueは、着手から反映までのどの区間で、どれだけ待ったか。区間は、担当の作業、Codexの実装、CIの順番待ちと実行、検証、マージの関門、デプロイに分ける。
- 流れはどこで詰まっているか。runnerの稼働率、担当の枠の埋まり具合、検証のやり直しの回数、マージを止めた理由で見る。
- 一つのIssueに、モデルとツールの時間、トークン、費用がどれだけかかったか。

## 生の記録と解釈を四つの層に分ける

受け取った記録を書き換えずに溜める層と、それを解釈する層を分ける。解釈の規則を変えたときに、記録を集め直さずに計算し直すためである。

| 層         | 置くもの                             | 書くもの   | 作り直し               |
| ---------- | ------------------------------------ | ---------- | ---------------------- |
| L1 raw     | 受け取ったままの記録と、その出どころ | 受け口だけ | 作り直さない。追記だけ |
| L2 staging | ソースの単位で型を付けた表           | 変換       | L1だけから作り直す     |
| L3 core    | ファクトリーの領域モデル             | 変換       | L1だけから作り直す     |
| L4 marts   | 指標と、計測の仕組み自体の健康状態   | 変換       | L1だけから作り直す     |

viewerはL4を読む。詳しく見るときはL3を読む。

層をまたいで、次の決まりを守る。

1. L1は追記だけにする。間違いは変換の側で直す。
2. L2から上は、L1だけから作り直せる。作り直しの入口を持ち、テストでも使う。
3. 発生した時刻と取り込んだ時刻を分けて持つ。遅れて届く記録と、順番が前後する記録を扱うためである。
4. 取り込みは、何度実行しても同じ結果になる。読み終えた位置は、書き込みが成功した後に進める。
5. 外から来る形は入口で検証する。検証を通らない記録も捨てずに隔離する。

## L1は出どころを問わず同じ包みで溜める

L1の行は、どの出どころでも同じ列を持つ。

- `ingest_id` は、取り込みごとの識別子である。
- `source` は出どころで、例えば `claude.otel.log`、`claude.hook`、`codex.otel.log`、`t3.run`、`github.actions.job`、`factory.cli` である。
- `kind` は出どころの種類で、出来事は `event`、状態の観測は `observation` とする。
- `prev_ingest_id` は同じ対象の直前の観測を指す。
- `source_version` は、出どころの形式の版である。
- `observed_at` は取り込んだ時刻、`occurred_at` は出どころが言う発生時刻である。`occurred_at` は無ければ空にする。
- `natural_key` は出どころの識別子、`content_hash` はpayloadの内容のハッシュである。
- `payload` は、保存前に下記のプライバシー規則を適用したJSONである。

出どころには二つの種類がある。

- 起きたことが一度だけ届くもの（OTel、hook、CLI）は、届いたまま追記する。
- 今の状態を読みに行くもの（GitHubのPRとActionsのjob、T3のスレッドとターン）は、前回の観測と内容が違うときだけ、新しい観測として追記する。T3の表のように履歴を持たない出どころでも、いつ何が変わったかがL1に残る。

一度だけ届く出どころの重複は、`source`、`natural_key`、`content_hash` の組で除く。状態を読みに行く出どころは、同じものの最新の観測と内容が同じときだけ除く。A、B、Aと変わったときの二度目のAも残すためである。どちらの決まりも、L1の表の一意の索引が守る。入口で検証するのは包みの形だけで、payloadはL2で解釈する。

## L2は出どころの癖を吸収する

L2は、出どころの単位ごとに一つのモデルを持つ。最初に持つモデルは次のとおり。

- GitHubからは、`stg_github_issue`、`stg_github_blocked_by`、`stg_github_pr`、`stg_github_comment` を作る。
- GitHub Actionsからは、`stg_actions_job` と `stg_actions_step` を作る。
- T3からは、`stg_t3_thread`、`stg_t3_run`、`stg_t3_message` を作る。`stg_t3_message` はメッセージの種類と送り手だけを持ち、本文を持たない。
- Claude Codeからは、`stg_claude_session`、`stg_claude_model_call`、`stg_claude_tool_call` を作る。
- Codexからは、`stg_codex_session` と `stg_codex_tool_call` を作る。
- 工程の判断からは、`stg_factory_event` を作る。

状態を読みに行く出どころからは、最新の状態の表と、有効期間を持つ変化の表の二つを作る。時刻はUTCにそろえる。解釈できなかったpayloadは、理由と一緒に隔離の表へ入れる。

同じ種類の記録が、時期によって違う出どころから来ることがある。例えばツールの時間は、過去の分を会話ログから、これからの分をOTelから取る。L2はどちらも同じ `stg_claude_tool_call` の形にそろえ、出どころを列に残す。

## L3は一つのIssueを一本のtraceとして表す

L3は、記録をファクトリーの言葉で表す。一つのIssueを一本のtraceとし、そこで起きた活動をspanとして持つ。OTelのtraceと同じ形なので、OTelから来る記録とそのままつながる。

- 作業項目（`work_item`）はIssueである。milestone、作成した時刻、着手できるようになった時刻、閉じた時刻を持つ。着手できるようになった時刻は、依存するIssueがすべて閉じた時刻である。
- 変更（`change`）はPRで、版（`revision`）はheadのSHAとpushの時刻である。変更は、本文の `Closes #N` で作業項目に結ぶ。
- 担い手（`actor`）は、役割、モデル、effort、T3のスレッド、セッションを持つ。役割は、指揮役、担当、検証役、実装役（Codex）、設計の相談役のどれかである。
- 対応表（`identity_link`）は、セッション、T3のスレッド、作業項目、変更、版を結ぶ。どの手がかりで結んだかも持つ。手がかりは、`T3CODE_THREAD_ID`、最初の指示、cwd、`Closes` である。
- span（`span`）は、始まりと終わりのある活動である。ターン、モデルの呼び出し、ツールの呼び出し、Codexの実装、検証、CIの順番待ちと実行、デプロイ、staging占有を含む。どのspanも、作業項目と担い手に結ぶ。
- 出来事（`event`）は、一瞬で起きることである。報告、判定、マージ、マージを止めたこと、直しの依頼を含む。判定はPASSかFAILかとFAILの理由の分類を、マージを止めたことはその理由を持つ。

## L4は指標の定義を版付きで持つ

L4は、L3から指標を計算する。指標の定義はコードとして版を付けて持つので、定義を変えてもL1を集め直さない。

- Issueの流れは、着手できた、着手した、PRを出した、マージした、stagingに反映した、の各時刻の間隔を持つ。待ちの内訳、FAILの回数、費用も持つ。
- 待ちの内訳は、Issueの各分を「その時点で何を待っていたか」に一つだけ割り当てる。重なった活動は、定義に書いた優先順位で一つに決める。
- CIは、jobごとの順番待ちと実行の時間と、1時間ごとのrunnerの稼働率を持つ。
- マージの関門は、マージを待った時間を理由ごとに持つ。
- 担い手は、役割とeffortごとに、モデルとツールの時間、トークン、費用を持つ。
- 流れ全体は、WIP（担当の枠の埋まり具合）、スループット、flow efficiencyを持つ。flow efficiencyは、作業していた時間を全体の時間で割った値である。
- 計測の仕組みの健康状態は、出どころごとの最後の取り込み、取り込みの遅れ、隔離した件数を持つ。受け口は1分ごとに、出どころごとの件数（追記、重複、保留、期限切れ、L1に入れずに捨てた数）と最後に取り込んだ時刻を、出どころ `metrics.receiver` の記録としてL1に書く。そのため健康状態もL1だけから作り直せる。

## 記録は三つの部品で取り込む

受け口は `node metrics/receiver/receiver.ts` で起動する。`127.0.0.1:4318` を確保してからDBを開き、spoolを取り込んでからHTTP要求を処理する。二つ目の受け口が同じポートを確保できなければ、DBを開く前に終了する。

- ログは `POST /v1/logs`、メトリクスは `POST /v1/metrics` にOTLP/HTTP JSONで送る。ログは1件ずつ、メトリクスはデータ点ごとに所属を判定する。保留を含む書き込みが確定したら200、保存に失敗したら503を返す。
- 検証に失敗した要求は、信号の種類、バイト数、SHA-256、検証エラーのパスだけを隔離する。JSONとして読めない要求は隔離して400を返す。
- `GET /health` はSQLiteの `health_source` ビューを返す。出どころごとに最終受信時刻、過去24時間の件数と遅れ、隔離・期限切れの件数、現在の保留件数を読める。

- 受け口は、launchdで常駐し、OTLP/HTTPとhookの記録を受ける。L1に書くのは受け口だけにして、書き手を一つにする。hookは受け口に送らず、いつも一時ファイル（spool）に書いて終わる。受け口は1秒ごとにspoolを取り込み、書き込みが成功した後にファイルを消す。受け口が止まっている間はspoolに溜まり、戻ったときに、OTLPを受け始める前に取り込む。受け口がこのマシンで一度も動いていなければ、hookは何も書かない。受け口のポートはOTLP/HTTPの既定の4318で、`pnpm dev` が使う5173と8787を避ける。
- ポーラーは、GitHub（Issue、依存、PR、コメント、Actionsのjobとstep）を数分ごとに、T3のDBを1分ごとに読む。T3のDBは読み取り専用で開く。
- hookは、リポジトリの `.claude/settings.json` に置き、SessionStart、UserPromptSubmit、Stopの三つだけを使う。SessionStartは、`session_id` とT3のスレッド（`T3CODE_THREAD_ID`）とcwdを結ぶ。UserPromptSubmitとStopは、ターンの始まりと終わりを記録する。ツールとモデルの時間はOTelが出すので、ツールを呼ぶたびに動くhookは使わない。

OTelは、リポジトリではなくこのマシンの設定で有効にする。Claude Codeは、プロジェクトの `.claude/settings.json` の `env` に書いたテレメトリーの設定を使わないためである。

- Claude Codeは、`~/.claude_personal/settings.json` の `env` で有効にする。T3は、このフォルダーを `CLAUDE_CONFIG_DIR` としてClaude Codeを起動する。
- Codexは、`~/.codex/config.toml` の `[otel]` で有効にする。Codexのプロジェクトのhookは、`hooks.json` の絶対パスごとに信頼の登録が要り、Issueごとに作るworktreeでは動かないので使わない。

どちらもこのマシンのすべてのセッションに効く。受け口は、hookの記録でこのリポジトリと結べたセッションと、T3のDBでこのリポジトリのスレッドと結べたCodexの会話だけをL1に書き、ほかは捨てる。hookは、セッションのプロジェクトの `.git` が何を指すかを書き、受け口はそれがこのリポジトリのgitの共通ディレクトリかを確かめる。本体のチェックアウトと、Claude CodeとT3が作るworktreeは、どれも同じ共通ディレクトリを持つ。Codexの `conversation.id` は、読み取り専用の `~/.t3/userdata/statev2.sqlite` でCodexスレッドの `nativeThreadRef.nativeId` と照合する。本体のチェックアウトがプロジェクトの `workspace_root` と一致したら、根拠を `t3.codex_link` としてL1に残す。照合に失敗した回数は受け口の健康記録に含める。結べるまでの記録はプライバシー規則を適用してSQLiteに保留し、24時間のうちに結べなければL1に入れずに捨てる。

過去の分は、T3のDB、会話ログ、GitHubから一度だけ取り込む。取り込んだ記録の `source` には、これからの記録と区別できる出どころの名前を付ける。

## 保存はSQLite、変換はSQLで行う

- DBは、Nodeに組み込みの `node:sqlite` で扱うSQLiteで、WALモード、`synchronous=FULL` で開く。置き場所は `~/Library/Application Support/instant-madori/metrics.sqlite` で、リポジトリとworktreeの外である。`INSTANT_MADORI_METRICS_HOME` でDBとspoolの親ディレクトリを指定できる。
- L2〜L4は、SQLファイルで書く。小さなTypeScriptの実行役が、それを依存の順に流して作る。
- L2から上の計算が遅くなったら、L2から上をDuckDBに移す。DuckDBは書き手が一つのプロセスに限られるので、L1には使わない。

## L1に入れるものを先に決める

L1は直さない約束なので、入れた記録を後から消すのは難しい。そのため、入れるものを次のように決める。

- 指示の本文（ユーザーと指揮役が書いた文）は入れない。UserPromptSubmitの本文からは、役割、Issue、PR、ターンを起こしたものの種類だけを取り出し、本文は捨てる。Stopの `last_assistant_message` も捨てる。
- 利用者を示す属性は入れない。OTelの記録にある `user.email`、`user.id`、`user.account_uuid`、`user.account_id`、`organization.id`、`host.name` は、受け口で捨てる。
- コマンドの文字列は入れる。後で分類を変えたときに、集め直さずに済むためである。既知の形のトークンは、受け口で伏せる。
- ツールの入力（OTelの `tool_input`、`tool_parameters`、Codexの `arguments`）は、コマンドと、ツールが働いた場所（ファイルのパス、パターン、URL）だけを残し、ほかの文字列は長さだけにする。サブエージェントへの指示やほかのスレッドへのメッセージは、指揮役と担当が書いた文だからである。ツールの出力（Codexの `output`）も入れない。
- DBは、このマシンの外に出さない。

## 指揮役は計測を意識しない

指揮役、担当、検証役は、計測のために何もしない。計測は、指揮役、担当、検証役がすでに残すもの（T3のDB、GitHub、OTel、hook）だけから組み立てる。計測の仕組みが止まっても壊れても、三者の作業は変わらない。

- 工程の出来事は、すでにある記録から導く。staging占有の開始と終了は、指揮役がIssueに書くコメントから読む。判定は、検証役の最後のメッセージとPRのコメントから読む。マージを止めた理由は、PASSからマージまでの間に重なったstaging占有、実行中のデプロイ、衝突から推定する。導けない出来事は、指揮役に記録を頼まずに、推定できないものとしてL4に出す。
- hookは、すべての担当、検証役、指揮役のセッションで動く。そのため、受け口が無くても速く終わり、何も出力せず、どの場合も終了コード0で終わる。
- 計測のIssueとPRには、ラベル `metrics` を付ける。指揮役の `rank-ready.mjs` は `metrics` のIssueを候補に出さず、指揮役が開いているPRを一覧するコマンドは `metrics` のPRを除く。計測のIssueとPRは、計測のスレッドが作り、確かめ、マージする。
- `metrics/` だけの変更では、stagingへデプロイしない。そのため、計測のPRのマージは、staging占有に関わらず行える。
- ポーラーは、GitHub APIの上限を指揮役と分け合う。条件付きリクエストを使い、残りが一定の数を下回ったら次の周期まで待つ。
- 計測の健康状態は、viewerにだけ出す。指揮役の見回りには出さない。
- `metrics/` は、`apps/`、`crates/`、`packages/`、`scripts/` をimportしない。サービスも `metrics/` をimportしない。hookはNodeの組み込み、`metrics/home.ts` とhook内だけを読み込み、取り込みのパーサーはI/Oを行わない。L1への書き込みを開始できるのは受け口だけである。各境界を `scripts/check/boundaries.ts` の表に加えて検査する。

## フォルダーの構成

```text
metrics/
├── README.md   この設計
├── home.ts     DBとspoolの置き場所
├── hook/       hookと、hookが受け口に渡すspoolの形式
├── ingest/     OTLPとhookの解釈、所属の判定
├── l1/         出どころの表、保存前のプライバシー規則、L1の書き込みとスキーマ
├── receiver/   HTTP、spoolの取り込み、T3照合、ポーラーの起動
├── models/     L2〜L4のSQL（staging/、core/、marts/）
├── build/      変換の実行役
└── viewer/     viewer
```

## 設計が頼る前提

試作で確かめた前提は次のとおり。

- T3は、起動するClaude Codeのプロセスに `T3CODE_THREAD_ID` を渡す。T3が起動したセッションで、プロジェクトの `.claude/settings.json` のhookが動き、その入力に `session_id`、`prompt_id`、cwdが入る。
- Claude CodeのOTelは、モデルの呼び出しごと（`api_request`）に時間、最初のトークンまでの時間、トークン、費用、モデル、effortを出す。ツールの呼び出しごと（`tool_result`）に、ツール名、時間、成否、コマンドを出す。OTelの `session.id` は、hookの `session_id` と同じ値である。
- プロジェクトの `.claude/settings.json` の `env` に書いたOTelの設定は、T3でもコマンドラインでも効かない。プロセスの環境変数とフラグの設定では効く。
- CodexのOTelは、`conversation.id`、トークン、最初のトークンまでの時間、effort、ツールの判定を出す。
- CodexはT3のすべてのスレッドで一つの `codex app-server` を共有するので、環境変数ではスレッドを見分けられない。
- launchdで動くプロセスから、`gh` の認証、`git` のリモートへの接続、T3のDBの読み取りが使える。

まだ確かめていない前提は次のとおり。

- `~/.claude_personal/settings.json` の `env` に書いたOTelの設定が、T3が起動したClaude Codeで効く。
- `~/.codex/config.toml` の `[otel]` が、T3の `codex app-server` で効く。
- 受け口が止まっているとき、OTelの送信の失敗が、担当、検証役、指揮役のセッションに何も表示しない。

## 集計を作り直す

`node metrics/build/build.ts` は、計測ディレクトリの `metrics.sqlite` を読み取り専用で開き、`metrics-derived.sqlite` の全表を一つのトランザクションで作り直す。受け口は追記後にこのコマンドを子プロセスで起動する。起動間隔は最短1分である。

T3はプロジェクトの最初のスレッドから、GitHubは2026年11月1日から収集する。以後は取り込みが確定した位置から再開する。GitHub APIの残量が1500件を下回ると、その周期を見送る。失敗と見送りの回数は `mart_health` で確認できる。

待ち時間は担当スレッドが作成された瞬間から1分刻みで分類する。マージ直前の端数も1分に数えるため、状態別の合計とタイムスタンプから求めた経過時間には、Issueごとに1分未満の差が出る。
