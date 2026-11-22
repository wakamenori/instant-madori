# instant-madori

営業と施主が、会話を通じて間取り・3D・住まいのイメージを具体化するWebサービスを開発しています。

仕様・設計・実装順は[実装計画](docs/plan.md)、エージェント向けのルールは[AGENTS.md](AGENTS.md)にあります。

## 開発を始める

macOSまたはLinux、Git（`git subtree`を含む）、[mise](https://mise.jdx.dev/getting-started.html)、rustupを使用します。Node.js・pnpm・検査ツールは`mise.toml`、Rust・Clippy・rustfmt・Wasmターゲットは`rust-toolchain.toml`で固定しています。Dockerは `pnpm dev` と `pnpm check --full` に必要です。Docker DesktopのVMには、12 GBのメモリを割り当ててください。8.32 GBのVMでは、形状サービスのイメージのビルドがメモリ不足で止まりました。画面だけの作業では `MADORI_DEV_CONTAINERS=0 pnpm dev` で起動できます。

リポジトリのルートで実行します。ローカル起動にCloudflareアカウントやAIキーは不要です。ローカルでは、AIの代わりに、決まった応答を返す台本のAIを使います。

```sh
mise trust
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm setup
mise exec -- pnpm check
mise exec -- pnpm dev
```

以降の`pnpm`コマンドも、miseを有効にしたシェルで実行します。シェルにmiseを設定していなければ、上記のように`mise exec --`を前置してください。

初回はRust・Wasmと依存ライブラリをビルドします。`pnpm setup`はツールの準備、releaseのWasmバインディング・Worker型の生成、コミット時の検査フックの登録を行います。wasm-bindgen CLIはライブラリと同じ版を、このリポジトリの`.tools/`へインストールします。依存のインストールだけではGitフックを変更しません。

Rustは、rustupのcargoで動かします。`rust-toolchain.toml` の版とWasmのターゲットは、rustupを通したときだけ使われます。`mise exec` とmiseを有効にしたシェルでは、`mise.toml` が `$CARGO_HOME/bin`（既定は `~/.cargo/bin`）をPATHの先頭に置くので、Homebrewなどで入れた別のrustがPATHの前の方にあっても、rustupのcargoを使います。`pnpm setup` は、cargoを使う前に、PATHで最初に見つかるcargoがrustupのものかを確かめ、違えばそのcargoの場所と直し方を表示して止まります。miseを使わない場合は、rustupのcargoがあるフォルダーを、ほかのcargoより前にPATHに置いてください。`$CARGO_HOME/bin` はmiseで固定したツールよりも前に来るので、そこに `cargo install` で入れた `cargo-deny` や `cargo-machete` があると、固定した版の代わりにそれが動きます。

`git worktree add` で作った別のworktreeでは、`pnpm setup` が、cargoを確かめた直後に、メインのチェックアウトの `target/` と `.tools/` をcopy-on-write（macOSはAPFSのclonefile、Linuxはreflink）で複製します。複製した後、自作のRustのクレート（workspaceのクレートと、path依存のSolidCraftのクレート）のソースの更新時刻を進めます。Cargoはpath依存のクレートが新しいかどうかをソースの更新時刻だけで判断し、クレートを見分けるハッシュもworkspaceからの相対パスで作るので、このままでは別のチェックアウトがコンパイルしたクレートを再利用してしまうためです。Cargoでビルドするときは、外部のクレートは複製を使い、自作のクレートをそのworktreeでビルドし直します。Wasmは、同じ入力で生成済みなら、ユーザーごとのキャッシュから復元します。worktreeごとに `target/` を持つので、複数のworktreeで同時にCargoを使えます。`target/` がシンボリックリンクなら、リンクだけを外して複製に置き換えます。`target/` のディレクトリがすでにあれば、何もしません。空の `target/` を作っておくと、複製せずに最初からビルドします。複製元と別のファイルシステムにあるworktreeでは、全体のコピーになるので止まります。Gitのフックは全worktreeで共有なので、メインのチェックアウトでだけ登録します。

手元の単発の値（2026-11-20）では、26 GB・約1.9万ファイルの `target/` の複製は5〜9秒で終わり、ディスクの空きはほとんど変わりませんでした。Wasmキャッシュ導入前の `pnpm setup` は複製の後に312秒かかり、自作の11のクレートだけをWasmのreleaseでビルドし直し、外部のクレートはビルドしませんでした。続く `pnpm check` は536秒でした。この二つの時間は、別のworktreeで検証が動いていた間に測ったので、ほかの負荷の分だけ伸びている可能性があります。worktreeごとに増えるディスクは、複製の後に書かれたファイルの合計で、`pnpm setup` の後で0.60 GB、`pnpm check` の後で3.94 GBでした。worktreeを消すと戻ります。メインのチェックアウトの `target/` が古くなるほど、複製と共有できる部分が減り、外部のクレートもworktreeごとにビルドし直すことになります。

`pnpm dev`は、ローカルのD1へマイグレーションを適用してから次のプロセスを起動し、Ctrl-Cでまとめて終了します。ContainerとプロキシはWranglerが終了時に削除します。終了処理の失敗は報告し、起動・実行結果と終了コードを維持します。

`pnpm dev` は、何も指定しなければ5173番（画面）と8787番（Worker）を使います。別のworktreeの `pnpm dev` と同時に動かすときは、`MADORI_DEV_PORTS=auto pnpm dev` で起動します。20000〜32767番から、空いている二つのポートを選びます。どちらの場合も、使うポートを起動の初め（マイグレーションの前）に `Web: http://127.0.0.1:<画面のポート> | Worker: http://127.0.0.1:<Workerのポート>` の行で表示します。既定のポートに `127.0.0.1` か `localhost` で応答するプロセスがあれば、その時点で止まり、別のポートへは移りません。同じチェックアウトでは、`pnpm dev` を同時に一つしか起動できません。二つ目は `.local/dev.lock` のロックを取れずに止まります。ローカルのD1と `apps/worker/.dev.vars` は、チェックアウトごとに一つしかないためです。

Containerを使うローカルセッション（別worktreeの `pnpm dev`、実Containerテスト、別worktreeやself-hosted runnerでの `pnpm check --full`）は同時に起動できます。Miniflareがセッションごとに異なるIDをContainerの名前（`workerd-<ID>-instant-madori-GeometryContainer-...`）に付けるためです。クラッシュしたセッションのContainerは残ることがあります。`docker ps -a --format '{{.ID}} {{.Names}}'` で `workerd-` で始まる名前を確かめ、動いているセッションがないときに `docker rm --force <ID>...` で削除します。

Dockerを使う重い作業は、マシン全体で共有する「Dockerの枠」を一つ取ってから始まります。枠を取るのは、`pnpm check --full` の実Containerの接続検査、形状サービスのイメージの回収、ビルドキャッシュの回収の間と、Containerを有効にした `pnpm dev` の起動から終了までです。枠は開発用に二つ、self-hosted runner用に一つあります。runnerはGitHub Actionsが設定する `GITHUB_ACTIONS=true` で見分け、開発用の枠が埋まっていても待ちません。枠が埋まっていれば空くまで待ち、待ち始めとその後の一分ごとに、各枠を持つプロセスの目的、pid、経過時間、チェックアウトを `[docker-slot]` の行に表示します。待っている間のCtrl-Cで、`pnpm check` は中断して終了コード1で、`pnpm dev` は通常の停止として終了コード0で終わります。Containerを有効にした `pnpm dev` が二つ動くと開発用の枠は両方埋まり、三つ目の `pnpm dev` と `pnpm check --full` のDockerの段階は、どちらかが止まるまで待ちます。

枠はmacOSでだけ働きます。Linuxでは枠を取らずに実行し、そのことを `[docker-slot]` の行に一行表示します。枠の実体は、`~/.local/state/instant-madori/docker-slots/` のファイルにかけるflockです。枠は取ったプロセスだけが持ち、プロセスが終わると、`kill -9` で止めた場合もOSが外します。子プロセスは枠を持ちません。そのため、`kill -9` で止めると、そのプロセスが起動した `wrangler dev` やDockerのビルドが動き続けていても枠は空きます。止めるときは、Ctrl-Cか `kill`（SIGTERM）を使ってください。

`node scripts/shared/docker-slots.ts status` で各枠を持つプロセスを表示します。`pnpm check --full` と `pnpm dev` の外でDockerの重い作業をするときは、`node scripts/shared/docker-slots.ts run -- <コマンド>` で枠を取ってから実行してください。実Containerの試験を直接動かす場合や、キャッシュなしでイメージをビルドする場合が当たります。`run` の中で `pnpm check --full` や `pnpm dev` を起動すると、二つ目の枠を待たずに失敗します。`pnpm dev` は動いている間ずっと枠を一つ持つので、使い終わったら止めてください。

形状サービスのイメージは、どのworktreeとself-hosted runnerから作っても、Cargoの `target/` を一つのcache mount（id `instant-madori-geometry-build-v2`）で共有します。Cargoはpath依存のクレートの新しさをソースの更新時刻で判断しますが、COPYはチェックアウトごとの更新時刻を持ち込みます。そのため、cache mountにはソースの写しを `target/` と並べて置き、ビルドのたびに、内容が違う項目だけを写しへ書き、余分な項目を消します。Cargoはシンボリックリンクについて、コンパイルしたときのリンクの先のファイルの更新時刻を見るので、写しにはリンクを置かず、リンクの先の内容を通常のファイルとディレクトリとして写します。参照先の無いリンクは写しません。Cargoは写しをビルドし、内容が変わったクレートとそれに依存するクレートだけを作り直します。ビルドのログの `Source copy: removed <数>, wrote <数> entries` の行が、消した項目と書いた項目の数を示し、書いた項目が20個以下なら続けてそのパスを示します。内容が違うworktreeが交互にビルドすると、違うクレートとそれに依存するクレートをそのたびに作り直します。このcache mountは一度に一つのビルドだけが使い、同時に始まったビルドは、先のビルドのCargoが終わるまで表示なしで待ちます。

cache mountのidを変えると、新しいcache mountは空から始まり、最初のビルドはすべての依存をコンパイルします。手元の計測（2026-11-22、runnerの検査と重なった状態）では795秒と1265秒かかり、実Containerの試験の起動待ちの期限（800秒）を超えることがあります。idを変えるPRでは、`pnpm check --full` の前に、`node scripts/shared/docker-slots.ts run -- docker build --platform linux/amd64 --output type=cacheonly -f apps/geometry/Dockerfile .` で一度ビルドしてcacheを温めてください。

`pnpm check --full` は、実Containerの接続検査の直後に、同じDockerの枠を持ったまま、接続先のローカルDocker Engineの未使用ビルドキャッシュを回収します。Cargoのregistry・git・targetを含む `exec.cachemount` は合計8 GiBまで残します。それとは別に、`regular` と `frontend` は最近使った記録から合計4 GiBまで残します。形状サービスの一組の層は、Rustの基底層・aptのRUN・COPY・CargoのRUN・frontend・実行用のCOPYを合わせて約3.91 GBです。4 GiBの枠はこの一組を残しますが、更新時の余裕は残りません。BuildKitは、再利用した基底層とaptのRUNの最終使用時刻を更新しません。そのため、記録が枠を超えると、回収はRustの基底イメージの層を最も古い記録として選びます。計測では、選んだ基底層の記録は回収の後も残り、層の記録の合計は回収の前後とも約6.37 GBで、枠を超えたままでした。時間の範囲ではビルドが集中した際の容量を制限できないため、容量で制限します。

各枠を超えた場合は最終使用時刻が古い未使用記録から丸ごと消し、`source.local`・`source.git.checkout`・`internal` の未使用記録はすべて消します。使用中の記録と未知の種類は残し、未知の種類は一行で報告します。Dockerは使用中のcache mountを0バイトと報告するため、その実容量は上限の計算に含められません。使用が終わった後や別のビルドで増えた後は、実容量が上限を超えることがあります。回収後の報告値も、使用中のmountの実容量を保証しません。ビルドキャッシュの回収は、イメージ・Container・ボリュームを対象にしません。Unixソケットで接続するローカルDockerを対象とし、独立したbuildx builderは対象にしません。

手で確かめる場合は `pnpm docker:prune-build-cache --dry-run` で保持・削除候補と容量を表示し、`pnpm docker:prune-build-cache` で回収します。上限を変える場合は `--mount-limit-bytes 8589934592 --layer-limit-bytes 4294967296` のようにバイト数を指定します。このオプションはその実行だけに適用します。

`pnpm check --full` は、実Containerの接続検査の直後、ビルドキャッシュの回収の前に、同じDockerの枠を持ったまま、このリポジトリの形状サービスのイメージを回収します。対象は、Wranglerが `pnpm dev` と実Containerの試験で付ける `cloudflare-dev/geometrycontainer-geometry-8788ff521eb5` のタグと、stagingへのデプロイが手元に残す `registry.cloudflare.com/<アカウントID>/instant-madori-staging-geometrycontainer-geometry` のタグだけです。ほかのリポジトリのタグは、同じイメージを指していても外しません。Wranglerはセッションを起動するたびに新しいタグを付けますが、ソースが同じならタグは同じイメージを指します。手元の計測（2026-11-22）では、192個のタグが2個のイメージを指していました。ディスクを使うのはイメージなので、イメージを単位にして、最後にタグを付けた時刻（`docker image inspect` の `Metadata.LastTagTime`）が新しい3個を残します。イメージ一つは、共有する基底の層113.6 MBのほかに、約308.5 MBを使います。

残す3個のイメージは、タグを一つだけ残し、ほかのタグを外します。それより古いイメージは、すべてのタグを外して消します。次のイメージは、数に関係なく、すべてのタグを残します。

- Container（動いているものと止まったもの）が使うイメージ。
- 動いているWranglerのうち最も古いものが起動した時刻の5分前より後に、タグを付けたイメージ。動いているセッションは、Containerが休止した後も、自分のタグからContainerを作り直すためです。5分は、Docker DesktopのVMの時計とmacOSの時計のずれに備える余裕です。
- タグを付けた時刻が分からないイメージ。

削除には、タグを指定した `docker image rm` を使い、`--force` を付けません。計画を立てた後に始まったセッションのContainerがイメージを使い、Dockerが削除を断った場合は、そのイメージを残して報告します。stagingへのデプロイが残したタグは、次の `--full` で回収します。

手で確かめる場合は `pnpm docker:prune-images --dry-run` で各イメージの扱いを表示し、`pnpm docker:prune-images` で回収します。残す数は `--keep 5` のように指定します。このオプションはその実行だけに適用します。

既定のポートでは、次のURLを使います。`MADORI_DEV_PORTS=auto` では、起動の初めの行に出たポートに置き換えます。

| URL                   | 内容                                                              |
| --------------------- | ----------------------------------------------------------------- |
| http://127.0.0.1:5173 | Reactの開発画面。指示を送り、ジョブが確定した案をWebGPUで描画する |
| http://127.0.0.1:8787 | ローカルWorkerとビルド済み静的ファイル。`/api/health`で応答確認   |

画面は、案件「開発用サンプル」を作り、そのパターンへ指示を一件送ります。パターンの状態を1秒ごとに読み、送った指示のジョブが終わったら、確定した案の表示データ（`GET /api/revisions/:id/view`）を描きます。ジョブはWorkflowからDurable Objectを通してContainerを呼び、SolidCraftでサンプルを生成して案として確定します。案件の作成と指示の要求は、最初の送信の前にブラウザの `localStorage` に保存し、再読込と再試行では同じrequest IDで送り直します。そのため、再読込しても案件とジョブは増えません。ジョブが失敗・停止したときは「もう一度送る」で新しい指示を送ります。別のブラウザのプロファイルで開くか、サイトのデータを消すと、次に開いたときに案件とジョブを一つずつ作ります。この画面は、6.2で会話の画面に置き換えます。

サンプルは床と3枚の壁、奥壁の開口で構成します。画面はドラッグでの回転と、スクロールでの拡大・縮小に対応します。ブラウザでは、WebGPUのアダプタがあるChromiumで描画を確かめ、合成したポインタイベントでの回転と、ホイールイベントでの拡大を確かめました。縮小、実際のマウス・トラックパッドでの操作感、Chromium以外のブラウザは確かめていません。WebGPUを利用できるブラウザが必要です。初回のamd64イメージのビルドには数分かかります。

Rustサービスだけを反復する場合は `MADORI_INTERNAL_TOKEN=local cargo run -p madori-geometry` で起動します。`http://127.0.0.1:3001/healthz` は認証不要、`/v1/sample/display` は `authorization: Bearer local` が必要です。このプロセスをWorkerが呼ぶことはありません。

5分ごとのCron Triggerが、受付または実行権の取得から5分を超えたジョブのパターンDOを起こします。保留中の待機列は再開しません。ローカルでは次のコマンドで同じ定期処理を呼べます（`auto` ではWorkerのポートに置き換えます）。

```sh
curl http://127.0.0.1:8787/cdn-cgi/local/scheduled
```

ローカルのWorkerを再読込または再起動したあと、Workflowがrunningのまま再開しない場合は、そのジョブを停止してください。

### ローカルでのログイン

ローカルではCloudflare Accessの代わりに、生成した開発用の鍵を使います。`pnpm dev`は初回に鍵を `.local/access-key.json` に作り、Workerの設定 `apps/worker/.dev.vars` をそこから生成します。どちらもGitの追跡対象外です。`.dev.vars` は毎回生成し直すので、手で編集しないでください。この仕組み以外で作った `.dev.vars` があると、上書きせずに停止します。

Viteのプロキシ（画面のポート。既定は5173番）経由のAPI要求には、開発者として署名したトークンが付きます。変更を伴う要求は、その回の画面のOrigin（画面のポートを `127.0.0.1` と `localhost` で書いた二つ）からだけ受け付け、ほかのOriginからは403になります。`.dev.vars` の `APP_ORIGINS` には、起動のたびにこの二つだけを書きます。別の利用者として試すときは、`MADORI_DEV_EMAIL=other@example.com pnpm dev` のように起動します。Workerのポート（既定は8787番）へ直接送った要求には認証ヘッダーが付かないため、認証が必要なAPIは401になります。`/api/health` は認証なしで応答し、未知のパスは404、許可していないメソッドは405になります。TypeScriptは開発中に更新されますが、Rust・Wasmを変更したときは再ビルド・再起動してください。

## 日常のコマンド

検査の入口は `pnpm check` にまとめています。すべてのモードで最初にPrettier・rustfmt・ESLintの自動修正を行い、Rustをビルドする場合はClippyが自動適用できる修正を行ってから再整形・再検査します。修正できない問題が残れば失敗して後続処理を止めます。作業ツリーを書き換えるので、完了後に差分を確認してから必要な変更をステージしてください。コマンドはGitのステージ内容を変更しません。

| コマンド            | 用途                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check --fast` | 自動修正、TypeScriptの型付きlint・型確認、Rustのnative/Wasm Clippy、未使用コード・依存、Dockerfile、upstream境界、マイグレーションの不変、SQL接続状態、文書のパス、秘密情報を検査 |
| `pnpm check`        | 通常の作業確認。軽い検査にTypeScriptとRustのテストを追加                                                                                                                          |
| `pnpm check --full` | 全体確認。releaseのWasmの再生成、Web・Worker・Rustのビルド、ローカル接続テスト、依存のライセンス・取得元・脆弱性監査も実行。Dockerとネットワークが必要                            |
| `pnpm dev`          | Web・WorkerとDockerの形状処理Containerを起動                                                                                                                                      |
| `pnpm build`        | releaseのWasm・Web・Worker・ネイティブRustの成果物だけをビルド                                                                                                                    |

手元の通常・軽い検査は、`origin/main` との分岐点からのコミット、ステージ済み・未ステージの差分、Gitが無視しない未追跡ファイルを調べます。どれも [Rust の入力](scripts/check/rust-inputs.ts) に触れていなければ、Rustからの契約生成、Clippy、Rustテスト、RustをビルドするNodeテスト1件を省き、分岐点を表示します。rustfmt、未使用依存の検査、生成済みJSON SchemaからのZod生成は実行します。`--rust` を付けると、選んだモードのRust検査をすべて実行します。CI、`--full`、Gitで変更を判定できない場合も同様です。

補助スクリプトは `scripts/check/`・`scripts/dev/`・`scripts/generate/`・`scripts/build/`・`scripts/upstream/`・`scripts/deploy/`・`scripts/measure/` に目的別に置き、複数の目的で使う部品は `scripts/shared/` に置きます。テストは対象ファイルと同じフォルダーに置きます。

初期設定は `pnpm setup`、引数の確認は `pnpm check --help`。upstreamの取得・取り込みには後述の `pnpm upstream:check` / `pnpm upstream:update` を使います。個別ツールを順に手動実行する必要はありません。

Issue・PR・検証記録に貼る画像は、`pnpm images:upload --issue <番号> <ファイル>...` で `images` ブランチへ上げ、出力されたMarkdownを貼ります。作業中のブランチとworktreeは変わりません。置き方の決まりは[AGENTS.md](AGENTS.md)にあります。

`--fast` はテスト実行・アプリのビルド・ネットワーク監査を省きます。Rustの型付き検査自体には依存のコンパイルが必要で、初回は時間がかかります。繰り返し実行ではCargoのキャッシュを再利用し、変更されたクレートを検査します。検査ごとの所要時間を出力します。

Cargoのdevプロファイルは、incrementalコンパイルを無効にしています（`Cargo.toml` の `incremental = false`）。Cargoはincrementalの有無をクレートのハッシュに含めます。そのため、有効な実行と無効な実行が混ざると、path依存のSolidCraftのクレートと自作のクレートの成果物が、別のハッシュで一式ずつ `target/` に残ります。環境変数の `CARGO_INCREMENTAL` はこの設定より優先されます。`CARGO_INCREMENTAL` を付けない実行と `CARGO_INCREMENTAL=0` の実行は同じ成果物を使いますが、`CARGO_INCREMENTAL=1` は別の一式を作ります。Cargoは、`CARGO_INCREMENTAL` が設定されていなければ、環境変数の `CI` が設定されているとき（値によらず）incrementalを無効にします。この設定があれば、`CI` の有無でも成果物は変わりません。`RUSTFLAGS` もハッシュに含まれるので、付けると同じく別の一式を作ります。incrementalのキャッシュ（`target/debug/incremental`）も作りません。有効だったときは、一回の `pnpm check` で6.1 GBになりました（2026-11-20、一つのworktree）。

`pnpm setup`・`pnpm dev`・`pnpm build`・`pnpm check --full` は同じスクリプトでreleaseのWasmを準備します。入力が一致すると、サイズ検査に使う `target/wasm32-unknown-unknown/release/madori_viewer.wasm` とWebが読む `crates/viewer/pkg/` をまとめて復元します。初めての入力ではCargoでビルドし、自作の全クレートのdep-infoにこのチェックアウトの出力先が記録されていることを確かめてから、wasm-bindgenでバインディングを生成します。

キャッシュの鍵は、Wasm向けの依存に含まれるローカルクレートのファイル（未コミット・未追跡のソースも含む）、親workspaceのマニフェスト、Cargo.lock、CargoとRustの設定、ツールの版、ビルドスクリプト、ビルドに関わる環境変数のSHA-256です。既定の置き場は `$XDG_CACHE_HOME/instant-madori/wasm`（未設定なら `~/.cache/instant-madori/wasm`）です。`MADORI_WASM_CACHE_DIR` で変更できます。一組32 MiB以下の成果物を保存し、保存時刻の新しい8組を残します。`MADORI_WASM_CACHE=0 pnpm setup` で復元と保存を止め、Cargoとwasm-bindgenを実行します。Cargoの外部設定、独自のコンパイラ・リンカーなど、入力を列挙できない設定でもこのビルド経路を使います。GitHub Actionsでは毎回この経路を検査します。

`pnpm setup` で生成したWasmの型定義を通常・軽いモードで使います。初期生成がなければ準備手順を示して停止します。Wasmの公開API・依存・ビルド設定・upstreamを変更した場合は `--full` を実行してください。全体モードではreleaseのWasmを再生成してからTypeScriptを検査し、配信用のWasmもローカル配信と実Containerの接続テストで確認します。

TypeScriptのテストはNode.js標準のtest runnerを使います。HTTP経由のWorker APIテストは、テストファイルごとに一時的なD1へ実際のマイグレーションを適用し、`wrangler dev` でworkerd上のWorkerを起動して、HTTPで検査します。署名にはテスト用の鍵を使い、Cloudflareのアカウントは不要です。`apps/*/{src,tests}/**/*.test.ts`、`packages/*/{src,tests}/**/*.test.ts`、`scripts/**/*.test.ts` が対象です。現在は、WorkerのAPI（認証、所有権、冪等性、版の競合、ページング、指示の受付・停止、案の確定・読取とR2の内容の照合）、Containerの起動・引継ぎ・障害復帰、内部プロトコル、WebのAPIエラーとビューアの初期化・解放、操作量、アクセシビリティの静的マークアップ、スキーマ・生成契約・環境別バインディングを確認するテストがあります。Rustでは表示形式の固定フィクスチャ・破損入力・大量入力、配置済み形状の書出し、内部API認証、シーン変換とカメラを検査します。Node.jsの型だけを使うテストには専用のtsconfigを用意し、Worker本体の実行環境の型から分けています。RPCとサービスの単体テストはWorkerの型も必要なため、Node用のテストからtsconfigを分けています。これらの単体テスト自体はNodeで動きます。`tests/rpc/` の実D1・R2を使うテストと `revision-fixture.ts` は、共通の `platform-proxy.ts` から `getPlatformProxy` を開き、workerd上のローカルの束縛を呼びます。Containerは起動しません。共通ヘルパーは、呼出し中の参照をMiniflareがGCで先に解放する競合を避けるため、返されたネイティブプロキシを `dispose()` まで保持します。GCの回帰テストは子プロセスを `--expose-gc` で起動し、D1のbatch送信を遅らせて解放処理との順序を確かめます。`revision-fixture.ts` は案の保存のHTTPテストから子プロセスとして起動され、同じ束縛を使ってサービスを実行します。HTTPテストはその間Workerを一時停止し、fixtureは同じ永続化先を指定します。fixtureがproxyを終了してからWorkerを再開し、保存した内容を公開APIから読みます。同じSQLiteファイルを二つのworkerdが同時に開かないためです。静的マークアップとDOM/GPUの代替オブジェクトによる検査は、ブラウザでの実描画を確かめるものではありません。

全体モードもローカル実行で、Cloudflareへのデプロイや本番リソースの作成はしません。Workerのビルドは `--dry-run` です。DockerイメージをビルドしてLinuxで起動し、Workerで受け付けたジョブがパターンのDOを通じて表示データを生成し、確定した案から取得・復号できることを検査します。通常のWorker APIテストとdry-runビルドではContainerを無効にします。

## 検査の担当と範囲

| 対象                              | 検査                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript・React・開発スクリプト | TypeScriptのstrict設定、型情報を使うESLint、React Hooksルール                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 整形                              | Prettier、rustfmt、EditorConfig。文章は文字数による自動改行をしない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Rust                              | Clippyで警告をエラーにする。自作コードのunsafe・unwrap・expect・panicなどを禁止                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 未使用コード・依存                | Knipとcargo-machete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 依存の脆弱性                      | pnpm audit、cargo-deny。JSはlow以上、Rustは脆弱性・yankedを検査し、unmaintainedはworkspaceの直接依存を対象にする。Rustで無視する勧告は、理由と使ってよい経路（`wrappers`）を `deny.toml` に書き、当たらなくなった無視と使われない経路の指定を失敗にする                                                                                                                                                                                                                                                                                                                                                                                        |
| 依存のライセンス・取得元          | pnpmのメタデータでJSのGPL/LGPL/AGPL・不明ライセンスを拒否し、Rustはcargo-denyの許可リストで検査。Rustは実際に使うSolidCraft側の依存も対象                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 秘密情報                          | Gitleaks。`check`の全モードで追跡済み・未追跡のGit管理対象ファイル、コミット時にステージ済みの差分を検査。gitignoreされたローカル認証情報は除く。Gitの全履歴の監査ではない                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| WorkerのSQL                       | `check`の全モードで、WorkerソースのTypeScript文字列・テンプレートとマイグレーションSQLの `changes()`・`total_changes()`・`last_insert_rowid()` を拒否する。大文字・小文字と括弧の前の空白を区別しない。TypeScriptのコメントは除外する。所有者条件などSQLの意味や、文字列の連結・実行時の組み立て、エスケープで書いた文字、`(` の前のコメント、引用符で囲んだ関数名は検査しない。対象のファイルは `apps/worker/src/**/*.ts` と `apps/worker/migrations/*.sql` である。どちらかに当たるファイルが一つも無ければ、探す場所の誤りとして失敗する                                                                                                    |
| requests表への書込み              | `check`の全モードで、`apps/worker/src/` のTypeScript文字列・テンプレートにある `requests` 表へのINSERT・UPDATE・DELETE・REPLACEと、INSERTのUPSERTを拒否する。例外は `apps/worker/src/storage/requests.ts` だけとし、読取りは制限しない。大文字小文字、引用符、空白・改行、SQLコメント、スキーマ修飾に対応する。表名を連結・変数・テンプレートの埋込みで実行時に組み立てる書き方は検査できない。`OR`・`INTO`・`FROM` に空白なしで接した埋込み（例：`INSERT OR${conflict} INTO requests`）は検査できない。SQLと通常の文章は区別しないため、`failed to delete from requests` のような文言も誤検出する場合がある                                   |
| D1マイグレーション                | `check`の全モードで、基準にあるファイルの変更・削除・改名と、基準の最大番号以下の追加を拒否する。PRは `origin/main` との分岐点、mainはfirst parentを基準にする。PRのマージコミットにも対応する。`MADORI_MIGRATION_BASE` にコミットを渡すとそれを基準にし、HEADの履歴に無ければ失敗する。空の値と0だけの値は、渡さない場合と同じに扱う。stagingへのデプロイはpushの前のmainを渡す。Gitの全履歴が必要で、まだmainにないマイグレーションの修正は許可する。前の版のWorkerとの両立はレビューで確かめる                                                                                                                                              |
| 文書のパス                        | `check`の全モードで、README.md・AGENTS.md・docs/plan.md のパスの実在を検査する。相対リンクは文書の場所から解決する。コードの中では、`apps/`・`crates/`・`packages/`・`scripts/`・`docs/`・`third_party/`・`.github/` で始まる語を、末尾の `:行番号` を除いて検査する。大文字と小文字を区別し、末尾の `/` にはディレクトリを求める。Gitが無視する生成物は無くてもよい。まだ無いパスは `scripts/check/check-doc-paths.ts` の一覧のものだけを許し、一覧のパスが作られるか文書から消えると失敗にする。見出しへのリンク、別の場所からの相対の断片、ディレクトリを含まないファイル名、`<...>` やglobを含む語、URLは検査しない                        |
| skillの引数                       | `check`の全モードで、`.claude/skills` の下のMarkdownにある `$` に続く数字（`$0`、`$1` など）を拒否する。Claude Codeはskillを引数つきで起動すると、本文のこの並びを引数で置き換えるため、シェルの位置引数は `${1}` の形で書く。Markdownが一つも見つからなければ、探す場所の誤りとして失敗する                                                                                                                                                                                                                                                                                                                                                   |
| Dockerfile                        | hadolint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| upstreamとの境界                  | 採用版とのファイル照合、独自変更の記録、Cargo workspaceと依存先の検査                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 依存の境界                        | `scripts/check/boundaries.ts` の表から、TypeScriptはコンパイラAPIで解決した参照先ファイルの検査とESLintの構文・global制限を、Rustは `cargo metadata` と `cargo tree` の検査を組み立てる。Rustの依存グラフの行は、禁止するcrateを、守る性質ごとの集まり（UIツールキット、GPU、pluginの実行環境、編集エンジン）で指定する。表の各行を違反・許可の例でテストする。Workerの層は許可先から禁止先を生成し、未宣言ディレクトリも拒否する。import境界は自動修正後の`check`とpre-commitで検査し、エディタのESLint診断には出ない。非文字列の動的importは構文で拒否する。層外の再export、`require()` の呼出し、servicesの `fetch`・`Headers` は検査しない |
| ビューアのWasm                    | `--full` で、releaseのWasm（wasm-bindgenの前）の名前セクションとexportの名前を `scripts/check/check-viewer-wasm.ts` が読み、crateごとの関数の数とコード量をMarkdownの表でログに出す。各関数を本体を定義したcrateに数え、CADカーネル（solidcore・solidcore-ops）、編集エンジン、UIツールキットの関数があれば失敗する。名前を変えない関数は、wasm-bindgenのcrateの識別子か検査の一覧で数える。名前の無い関数、読めない名前、出どころの分からない名前も失敗にする。`target/` のWasmと `crates/viewer/pkg` のWasmで `madori_viewer` のcrateのハッシュが違えば失敗する。インライン化されたコードは、呼び出し側のcrateに数える                       |

Workerの保存境界では、型名・バインディングの取り出し・組み立て関数の入口を別の行で検査する。`storage/` では `z.any` と `z.custom` を禁止し、行の型は渡したスキーマから導出する。テストは破損注入のためにこれらの制限を除外し、ブランド型への直接キャストと `as never` の禁止だけは適用する。この構文検査では、次の形を防げない。

- 作成の証拠の行が、その要求の文で新しく作られたか。既存のIDを証拠にすると、変更のない記録が残る。
- 作成の文が何かを作るとき、必ず証拠の行も作るか。そうでなければ記録のない変更が残り、再送で繰り返される。
- 冪等な操作の結果のSQLが、正しい結果を作るか。
- `OwnerId`・`VerifiedIdentity` の名前を書かないキャストで作る形。ブランドを含む型へのキャスト（例：`as AuthenticatedUser`、`as AuthenticatedUser["id"]`、`as RequestKey`）、型の別名を通したキャストがこれに当たる。
- `JobExecutionRight` の型の別名、indexed access、tuple、union、`typeof`、名前を変えたimport、`import()` 型を通したキャスト。直接の型名と名前空間付きの型名へのキャストは構文検査で拒む。実行権を受け取る操作は、非公開の欄の存在を実行時に確認してからその欄を読み、偽造した値がD1・R2へ届くことを防ぐ。
- 保存結果の `resolved.constructor` を構築可能な型へキャストし、任意の利用者行を渡す形。非公開コンストラクタも、明示的なキャストによる偽造までは防がない。
- `VerifiedIdentity` の欄の直接代入や `Object.assign` による書き換えは、生成時の凍結で拒否する。型の偽造はこの保証に含まれない。
- 使う箇所にキャストを書かず、宣言で型を作る形。型述語、ジェネリックの補助関数、オーバーロードのシグネチャ、戻り値の型の宣言がこれに当たる。
- 計算したキーやrest分割代入でバインディングを取り出す形。
- `zod` の別名やnamespaceのimport、計算したプロパティ、分割代入、`zod/v4` などの別のパスから `any`・`custom` を名前でimportする形と、`z.ZodType<T>` へのキャストや `transform` の中のキャストで検証しないスキーマを作る形。
- 例外として許可したファイル（`compose.ts`、`api/app.ts`、`objects/pattern-coordinator.ts`、`workflows/job-workflow.ts`、`storage/` のファイル）が、組み立て関数、Storeやアダプターの構築関数を再exportする形。再exportしたものは、そのファイルを値としてimportできる層と `src/` 直下のファイルから使える。

`OwnerId` は他のIDとの取り違えを型で防ぎ、生成には `VerifiedIdentity` と保存処理を通った結果を要求する。異なる認証主体の結果との組み合わせは実行時に拒否する。上記の明示的な偽造やSQLの所有者条件は保証しない。所有者条件は実際のD1に対する所有権のテストとレビューで確かめる。

自作コードのlint・一括整形・未使用検査は、`third_party/solidcraft`を対象にしません。生成物も除外し、過去の検証記録・証拠は一括整形しません。依存の脆弱性やライセンスの検査対象はソースの配置で除外せず、サービスのlockfileから決めます。

Lefthookのコミット前検査は、ステージした自作ファイルの整形・lint、自作Rustの整形、秘密情報です。自動修正は先に `pnpm check` で行い、整形・lintはステージ対象ファイルの作業ツリーを、秘密情報はステージ済みの差分を検査します。フックはファイルやGitのステージ内容を書き換えません。部分ステージした変更をまとめてステージすることはありません。フックだけでは全体の型確認・テストを代替できません。

Dependabotはnpm・Cargoの更新提案用に残し、upstream本体はsubtreeの手順で更新します。

## PRの検査（self-hosted runner）

開発用Macで2台のself-hosted runnerを動かします。PRごとに `.github/workflows/check.yml` の `mode` ジョブが `madori-light` 上で変更ファイルを `scripts/check/ci-mode.ts` に渡します。`check` ジョブは通常モードなら `madori-light`、`--full` なら `madori` で `pnpm setup` と検査を実行します。stagingへのデプロイは `madori` が担当するので、通常モードの検査はデプロイ中にも開始できます。最後に、自動修正で差分が出ていないことを確かめます。GitHubのrunnerは使いません。無料プランのprivateリポジトリでは2コア・ディスクの空き13 GBで、`--full` がディスク不足で失敗し、無料枠も足りないためです。

`pnpm check` は試験ごとの結果を `target/test-results/` に書きます。保存先は `MADORI_TEST_RESULTS_DIR` で変更できます。`check` と `deploy-staging` は、失敗した回も含め、結果を成果物 `test-results-v1-<workflow>-<attempt>` として30日間保存します。取り消した回は保存しません。

`node scripts/check/test-history.ts` で直近200件の成果物を集計し、試験ごとの失敗率を表示します。スキップは分母から除きます。`--last N` で件数を変えられます。`--all` は安定した試験も表示します。`--test <文字列>` は名前にその文字列を含む試験を表示します。判定は次の順です。

- `flaky` は同じコミット、またはmainの実行で成功と失敗の両方を観測した試験です。
- `failing` は集計期間に失敗だけを観測した試験です。
- `suspect` は成功歴があり、複数のブランチで失敗した試験、またはmainで失敗して他のブランチでだけ成功した試験です。
- `branch-local` は成功歴があり、失敗が一つのPRブランチに限られる試験です。
- `stable` は成功だけを観測した試験です。

checkoutは毎回clone直後と同じ状態から始めます。Rustの `target/` と `.tools/` だけは、`$RUNNER_TOOL_CACHE/madori` へのシンボリックリンクで実行の間に再利用します。runnerの `--full` は、runner用のDockerの枠（「開発を始める」）を使うので、手元の `pnpm dev` や `pnpm check --full` が開発用の枠を埋めていても待ちません。Dockerを使う `madori` は一度に一つのジョブしか動かさないので、stagingへのデプロイで `wrangler deploy` がイメージをビルドするときも、runnerのDockerの作業は一つまでです。

runnerでも、`--full` の実Containerの接続検査の直後に、手元と同じ規則でDockerのビルドキャッシュを回収します。cache mountは合計8 GiBまで、最近使ったregularとfrontendは別枠で合計4 GiBまで残します。使用中の記録はBuildKitが保持するため、並行するビルドの記録は消しません。使用中のcache mountの0バイトという報告値では実容量を把握できません。runnerの `target/` と `.tools/` はこの回収の対象にしません。runnerの `--full` も、ビルドキャッシュの前に、手元と同じ規則で形状サービスのイメージを回収します。runnerと手元は同じDocker Engineを使うので、動いている手元のセッションのイメージは残ります。

このリポジトリではブランチ保護を使えないため、検査の成功はマージの条件として強制されません。マージの前に、PRの最新のheadで `check` が成功していることを確かめます。

デプロイ用の `madori` を入れ直すときは、[actions/runner](https://github.com/actions/runner/releases)のosx-arm64版を `~/actions-runner/instant-madori` に展開し、リポジトリの登録トークン（`gh api -X POST repos/wakamenori/instant-madori/actions/runners/registration-token`）で `./config.sh --labels madori` を実行します。mise・cargo・Dockerのある `PATH` で設定すると、runnerがその `PATH` を保存します。runnerの `.env` には、作業フォルダーを信頼する `MISE_TRUSTED_CONFIG_PATHS=<runnerのフォルダー>/_work` と、デプロイ用の認証情報を読む `MADORI_ENV_FILE=<リポジトリの .env の絶対パス>` を書きます。最後に `./svc.sh install` と `./svc.sh start` でlaunchdに常駐させます。外すときは `./svc.sh uninstall` の後に `./config.sh remove` を実行します。

通常モード用のrunnerは、同じ配布物を別のフォルダー `~/actions-runner/instant-madori-light` に展開します。そこで登録時に `./config.sh --name instant-madori-light --labels madori-light` を使います。追加するラベルは `madori-light` だけです。このrunnerの `.env` には `MISE_TRUSTED_CONFIG_PATHS=<light runnerのフォルダーの絶対パス>/_work` を書き、デプロイ用の `MADORI_ENV_FILE` は設定しません。

各runnerのツールキャッシュは、既定で各作業フォルダーの `_tool` にあります。初回だけ、元のrunnerがキャッシュを書き換えていない間に、同じAPFSボリューム上で次のコマンドを実行します。コピー先の `madori` がまだない状態で実行してください。`cp -c` は更新したブロックだけを別に保存するため、初回ビルドを省いても、2台が同じCargoの `target/` に書き込むことはありません。

```sh
cd ~/actions-runner/instant-madori-light
mkdir -p _work/_tool
cp -cR ../instant-madori/_work/_tool/madori _work/_tool/
./svc.sh install
./svc.sh start
```

ワークフローは `mise exec -- actionlint` で検査します。actionlintはrunnerのラベル `madori` と `madori-light` を `.github/actionlint.yaml` から読み込むので、ラベルを変更するときはこのファイルも更新します。

VS Code向けの推奨拡張・保存時整形・ESLint自動修正・Rust Analyzer設定を `.vscode/` に用意しています。他のエディタやエージェントによる直接編集でも、同じ `pnpm check` を使えます。

## 依存とツールを更新する

Node.js・pnpm・CLI検査ツールの版は`mise.toml`、共有するTypeScript・Node型・Zodの版は`pnpm-workspace.yaml`のcatalogで変更します。Node.jsは`.node-version`とも揃えます。TypeScriptは型付きlintの対応範囲に合わせて6.0系を採用しています。

pnpmは厳密なpeer dependency検査と、公開後24時間未満のパッケージを採用しない設定です。インストールスクリプトの実行は必要なパッケージだけ許可します。manifestや設定が変わったら明示的に`pnpm install`を実行し、コマンド実行時の自動インストールはしません。生成されたlockfileを確認し、`pnpm check --full` で依存監査も通してからコミットします。

一時的な依存上書きには理由を残します。現在のminimatchの上書きは[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)への対応です。ESLint/typescript-eslint側が修正版を採用したら取り除きます。

JavaScriptの脆弱性監査は、picomatchの[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)だけを一時的に無視します。修正版がまだ無く、picomatchは開発用の依存（knip・tinyglobby・vite）だけに入るためです。修正版が `minimumReleaseAge` の24時間を過ぎたら、`pnpm-workspace.yaml` の `auditConfig` から外します。

Rustの脆弱性監査は、rsaの `RUSTSEC-2023-0071` とcrypto-bigintの `RUSTSEC-2026-0387` だけを無視します。どちらもpgpからだけ来ます。pgpは `solidcraft-io` が公開鍵で署名を検証するために使い、2つの勧告は秘密鍵の操作に関するものです。`deny.toml` の `[bans]` は、この経路の外でrsaとcrypto-bigintを使うと失敗にします。upstreamが依存を直して勧告が当たらなくなると、`pnpm check --full` の監査が失敗します。そのときに `deny.toml` から無視を外します。理由の詳細は[SolidCraftの取り込みと更新](third_party/solidcraft.md)にあります。

Miniflareのsharp依存は、LGPLのlibvipsを含むため除外しています。現在使うWorker・静的配信には不要ですが、Cloudflare Imagesバインディングと`cf.image`のローカル画像変換は使えません。画像添付・R2への保存とは別の機能です。この機能を追加するときはライセンス方針と実行方法を再検討してください。

## 配置と依存関係

| 場所                     | 担当                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `apps/web`               | React・TypeScriptの画面                                                                |
| `apps/worker`            | Cloudflare WorkersのAPI・静的配信・Durable Objects・Workflow                           |
| `apps/geometry`          | ネイティブRustのHTTP入口、Container用Dockerfile                                        |
| `crates/display`         | 依存を持たない表示データの型と版付きバイナリ形式                                       |
| `crates/geometry-api`    | 内部API契約とTypeScript定義の生成                                                      |
| `crates/housing`         | 住宅データと整合性。環境整備時点ではモジュールの入口のみ                               |
| `crates/modeling`        | 住宅操作とSolidCraftの接続                                                             |
| `crates/viewer`          | SolidCraftのgeom・viewport・viewport-gpuを使うWasm                                     |
| `packages/contracts`     | WebとWorkerで共有するスキーマ。住宅の通信型はRust実装時に生成を追加                    |
| `third_party/solidcraft` | upstream一式。専用のCargo workspaceとして保持                                          |
| `docs`                   | 実装計画、過去の判断・検証記録                                                         |
| `scripts`                | ビルド・起動・検査・upstream更新・デプロイのTypeScriptスクリプト。Node.js 26で直接実行 |

ルートのCargo.lockとpnpm-lock.yamlがサービスの依存関係を固定します。SolidCraftの未使用アプリは通常のビルド対象に含めません。

## SolidCraftの更新

**upstreamの更新は原則取り込みます。** 住宅サービスへの影響を確認し、問題があれば調整するか、理由を記録して保留します。採用版は[solidcraft.json](third_party/solidcraft.json)、独自変更・更新手順・初回移行の記録は[solidcraft.md](third_party/solidcraft.md)を参照してください。Containerのイメージのビルドは、取り込み領域のうちビルドが読まないデータを `.dockerignore` で除いて送ります。更新の後に `pnpm check --full` のDockerのビルドが除いたファイルを読めずに失敗したら、`.dockerignore` からそのパスの行を消します。

SolidCraftの元のREADME・資料・ライセンスは取り込み領域に保持しています。[MITライセンス](third_party/solidcraft/LICENSE-MIT)、[Apacheライセンス](third_party/solidcraft/LICENSE-APACHE)、[NOTICE](third_party/solidcraft/NOTICE)、[資産と依存の帰属](third_party/solidcraft/ATTRIBUTION.md)を参照してください。

## stagingへデプロイする

mainへのpushで、`.github/workflows/deploy-staging.yml` が `madori` でstagingへデプロイします。`pnpm check --full`、D1のマイグレーションの適用、`scripts/deploy/wrangler-deploy.ts` を通した `wrangler deploy --env staging` の順に進め、その後 `scripts/check/staging-smoke.ts` で、Accessを通した疎通を確かめます。実行中のデプロイは最後まで続けます。待機できる実行は一つで、後から来たpushの実行が先に待っていた実行を取り消します。実行中のデプロイが終わると、最後に待っていたpushのコミットをデプロイします。マイグレーションはデプロイの前に適用するため、動いている前の版のWorkerと両立する形で書きます。mainに入ったマイグレーションは変更せず、修正は番号の大きいファイルを追加します。`pnpm check` の全モードがこの不変条件を検査します。pushによるデプロイは、`github.event.before` が指すpushの前のmainと比較します。force pushなどで、そのコミットがHEADの履歴に無ければ失敗します。手動の実行と、前のSHAが無いpushでは、`pnpm check` と同じく、mainはfirst parent、ブランチは `origin/main` との分岐点と比較します。

GitHubはmainへのpushの前後のコミットを比較し、変更したファイルがすべてworkflowの `paths-ignore` に該当すればデプロイを起動しません。対象は `docs/`、`.claude/`、`.github/ISSUE_TEMPLATE/`、`metrics/` の配下と、ルートの `README.md`、`AGENTS.md`、`CLAUDE.md` です。これらは文書、エージェント向けの指示、開発の計測で、Containerイメージのビルド、Workerと静的ファイルのビルド、マイグレーション、デプロイ、疎通確認では読みません。読むのは `pnpm check` の整形、ESLint、文書のパス検査、秘密情報の検査、テストだけで、マージ前にPRの `check` ですべて実行します。一覧の各項目はディレクトリ全体（`<ディレクトリ>/**`）か一つのMarkdownファイルです。この形式と、デプロイが読むディレクトリと重ならないことを `scripts/check/staging-smoke.test.ts` で確かめます。アプリ、クレート、パッケージ、スクリプト、upstream、マイグレーション、依存関係やツールのバージョン固定、このworkflow自体など、対象外のファイルを一つでも変えればデプロイします。ルートのREADMEだけを変えた場合も含め、対象の文書や指示だけのpushでは、stagingは直前にデプロイしたコミットのままで、そのpushのコミットにはdeploy-stagingの実行がありません。手動実行（`gh workflow run`）ではこの一覧を使いません。

`wrangler deploy` は、Workerの新しい版を公開した後、その版を読んでContainerのアプリケーション設定を適用します。アップロードの直後は、Cloudflareの版のAPIがその版に404（コード100146）を返すことがあります。Wranglerはこの読み取りを500ミリ秒おきに5回だけ試し、読めなければ「The Worker version was deployed, but its Durable Object-managed Container application settings were not fully applied. Re-run the same \`wrangler deploy\` command to retry and finish deployment.」で失敗します。このとき新しい版は公開済みですが、Containerの設定とトリガーは適用されていません。Wrangler 4.160.0から4.165.0まで同じ動きなので、版を変えても直りません。

`scripts/deploy/wrangler-deploy.ts` は、受け取った引数のまま `wrangler deploy` を実行し、この失敗のときだけ同じコマンドをやり直します。試行は初回を含めて3回までで、間で待ちません。やり直すたびに新しい版をアップロードし、Wranglerはその版の読み取りを最初から試すため、待っても読み取りの猶予は延びません。失敗は、Wranglerが `WRANGLER_OUTPUT_FILE_PATH` に書く構造化出力で見分けます。終了コードが1で、`command-failed` の行がちょうど一つあり、その `message` が上の文と完全に一致したときだけやり直します。ほかの失敗、シグナルによる停止、読めない出力ではやり直さずに失敗します。マイグレーションは別のコマンドなので繰り返しません。やり直した実行には、実行の概要に `wrangler deploy re-run` の警告が残ります。workflowを取り消すと、受け取ったシグナルをWranglerへ渡し、次の試行を始めません。構造化出力にはClient IDを含むコマンドラインが残るので、出力は表示せず、`RUNNER_TEMP` の下に作って終わりに消します。`pnpm check` は、差し替えたWranglerと、ローカルの偽のCloudflare APIに向けた実際のWranglerの両方でこの判定を検査し、Wranglerの更新でこの文や出力の形が変わると失敗します。

疎通の確認では、Accessのservice tokenを、固定の検証用ユーザー（subjectは `staging:verifier`、メールアドレスは `verifier@staging.invalid`）として使います。token無しの302、`/api/health` の200、`/api/me` の200と検証用メールアドレスを確かめます。案件を固定のrequest IDで作成・再送し、一覧から現在のversionを読んで名前を変更します。versionが一つ増え、読み直した一覧に変更が反映されること、存在しない案件のパターン一覧が404 `not_found` になることも確かめます。

デプロイごとに、この案件の最初のパターンでジョブを一件動かします。まず状態を読み、待機列が保留なら、保留の原因になったジョブのIDを指定して待機中の指示を取り消します。前回の失敗はそのデプロイで報告済みなので、取り消しは保留を解くために行い、今回のジョブの合否には含めません。指示には毎回新しいrequest IDを使います。同じIDを再送すると、記録済みの受付結果が返るためです。

受付後は2秒おきに状態を読み、送ったジョブの完了と、新しい案が現在の案になったことを確かめます。期限は `wrangler.jsonc` の検証用 `JOB_TEST_HOLD` に240秒を加えた値で、現在は420秒です。その案の `GET /api/revisions/:id/view` が200を返し、表示データのメディア型、案のID、空でない本文がそろえば成功です。既存の案を読むだけではR2のスナップショットが返り、Containerを通りません。ジョブを動かすことで、指示の受付からパターンのDO、Workflow、Container、R2への保存、D1での確定までを検査します。

成功したデプロイごとに、検証用の固定パターンに案が一件増えます。R2には表示スナップショット（実Containerテストで4,272バイト）とそのマニフェストを保存します。D1では `messages`、`jobs`、`snapshots`、`revisions` が各一行、`requests` が指示の受付と案件名の変更で二行増えます。保留を解いたときは `requests` がさらに一行増えます。stagingではこの増加分を検証用データとして保存します。

runnerは、`MADORI_ENV_FILE` が指す `.env` から、マイグレーションには `CLOUDFLARE_API_TOKEN`、デプロイには加えて `STAGING_ACCESS_CLIENT_ID`、疎通確認には `STAGING_ACCESS_CLIENT_ID` と `STAGING_ACCESS_CLIENT_SECRET` を読みます。Client IDはログにマスクしてから、デプロイの `--var ACCESS_VERIFIER_CLIENT_ID:<Client ID>` でWorkerへ渡します。空の値や空白だけならデプロイ前に失敗します。Client IDはリポジトリに保存しません。service tokenはAccessアプリの `non_identity` のポリシーで許可し、期限は1年です。

stagingをデプロイし直す方法は、このworkflowだけです。試験用のブランチも同じ方法を使います。

```sh
gh workflow run deploy-staging.yml --ref <ブランチまたはmain>
```

指定したrefで、検査・マイグレーション・デプロイ・疎通確認を同じ順に実行します。マイグレーションを含むブランチでは、mainに入る前にそのマイグレーションがstagingのD1に適用されます。`--var` なしの手動デプロイは検証用IDの設定を消し、疎通確認も実行しないため使いません。

手元で同じ疎通確認を行うには、上記のservice tokenの二つの値を入れた `.env` のパスを指定します。値をコマンドや出力に表示する必要はありません。成功すると `Staging smoke passed: <Origin>` が出ます。

```sh
mise exec -- node --env-file=/path/to/.env scripts/check/staging-smoke.ts
```

デプロイの最後に `node scripts/check/r2-create-only/main.ts` で、Cloudflareのedge preview内の検証用WorkerからstagingのR2へ書き込みます。これはデプロイを行いません。実際の保存アダプターの二回目の書込みが拒まれ、直接の条件付きputが `null` を返すことを確かめます。Node側はRESTで最初の保存後・拒否後の元のバイト列と、削除後の404を照合します。実行前後のWorkerスクリプト一覧も比較します。

手で実行するときは `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` の両方を環境変数に設定し、`mise exec -- node scripts/check/r2-create-only/main.ts` を実行します。空のトークンは個人のWrangler認証へ切り替えず失敗します。トークンには、対象アカウントのedge previewを使うWorkers Scripts Editと、stagingのバケットをRESTで読み書き・一覧するWorkers R2 Storage Writeの権限が必要です。通常の `pnpm check` は差し替えたバケットで判定を検査し、認証情報やネットワークを使いません。

検査は `checks/r2-create-only/` に実行ごとのキーを作り、失敗時も削除を試みます。強制終了時の残りは、次回実行の先頭で、同じprefixの1時間より古いオブジェクトだけをRESTで回収します。検査や回収が失敗すると非ゼロで終了します。

疎通とR2の確認が成功した後、stagingのレジストリから一覧を直接取得します。対象には、Wranglerの一覧に出ない `sha256:` で始まるダイジェスト名も含みます。Cloudflareがデプロイ時に作る実行用イメージ（prepared artifact）は、マニフェストの注釈が指す生成元と一緒に判定します。最新10版と現在のデプロイに含まれる全版が使うイメージは、別名も実行用イメージも残します。これらの版が直接使うマニフェストは、注釈が古い版だけの生成元を指していても残します。古い版だけが使うイメージについては、通常のタグと生成元のダイジェスト名を削除し、レジストリに未使用レイヤーの回収を依頼します。レジストリは実行用イメージの削除を409（`SINGLETON_ARTIFACT_EXISTS`）で拒否するため、古い版だけが生成元を使う実行用イメージは `prepared` に記録して残します。どの版からも参照されないものは `unreferenced` に記録して残します。他のリポジトリは対象外です。版の全件取得、対象リポジトリの特定、全マニフェストとダイジェストの検証が済んでから削除を始めます。

`wrangler deploy` をやり直した実行では、失敗した試行の版の詳細に、Cloudflareの版のAPIが回収の時点でまだ404（コード100146）を返すことがあります。その版が最新10版か現在のデプロイに含まれるときは、その版が使うイメージが分からないため、回収はその実行で何も削除せず、レジストリにも触れずに、実行の概要に `registry retention deferred` の警告を残して成功で終わります。待って読み直すことはしません。版が読めるようになった後のデプロイの回収が、残ったイメージを削除します。保持対象より古い版が読めないときは回収を続け、その版だけが使うイメージは `unreferenced` に記録して残します。版の詳細のほかの404やほかの失敗では、何も消さずに失敗します。

手元から候補だけを見るには、staging用の `CLOUDFLARE_API_TOKEN` が入った `.env` を指定します。既定は表示だけです。出力の `keep` は最新10版または現在のデプロイが使う保持対象、`remove` は削除候補です。`prepared` は生成元を古い版だけが使う実行用イメージ、`unreferenced` はどの版からも参照されない保持対象です。読めない版で回収を見送るときは、候補の代わりに、読めない版のIDを含む `registry retention deferred` の警告1行だけを出します。トークンとレジストリのパスワードは出力しません。削除する `--apply` はworkflowが使います。

```sh
mise exec -- node --env-file=/path/to/.env scripts/deploy/registry-retention.ts --dry-run
```

計画6.1bの完了条件の障害の試験のうち、stagingで起こせるものは `scripts/check/staging-faults/main.ts` で繰り返します。デプロイの中では実行せず、手で実行します。再デプロイをまたぐ試験はデプロイの中では行えません。また、ほかの試験もジョブを待たせるので、毎回のデプロイに入れると、デプロイがそのたびに数分ずつ延びます。6.1bを閉じるとき、6.2でジョブの中身を置き換えた後、ジョブの進行・停止・確定・復帰の仕組みを変えた後に実行します。

スクリプトは、検証用の利用者の案件に、パターン「障害試験」を固定のrequest IDで作り直して（再送して）使います。次の順に試します。

1. 待たせたジョブをまたぐ再デプロイ。
2. 指示の再送と、そのrequest IDの別の本文・別の操作への使い回し（422）。
3. 確定の後の停止（`already_finished`）。
4. 待ちの間の停止（`cancelled`）。
5. 停止の後の待機列の保留と再開。

各試験の前後で、案の一覧と各案の表示データのSHA-256を読みます。前の案がすべて変わらず、増えた案が期待どおり0件か1件であることを確かめます。同じパターンを使い続けるので、毎回それまでの実行で確定した案をすべて照合し直します。最後にWorkers Logsで三つを確かめます。待ちの間にパターンのDOが新しい版に切り替わったこと、止めたジョブが `cancelled` で終わったこと、照合の失敗が無いことです。

実行には、stagingの占有と、mainの再デプロイが要ります。スクリプトはデプロイを起こしません。指揮役が `gh workflow run deploy-staging.yml --ref main` で起動したrunのIDを受け取ったら、すぐに実行します。「Migrate and deploy」が始まる前に実行すれば間に合います。スクリプトは、終わっていないdeploy-stagingの実行がそのrunだけで、「Migrate and deploy」がまだ始まっていないことを確かめます。試験前の案と表示データを読んだら、「Migrate and deploy」の開始を待って、待たせるジョブを送ります。待ちは `JOB_TEST_HOLD` の180秒のままで足ります。待ちが覆う必要があるのは、十数秒から1分ほどで終わるこの段階と、その後にパターンのDOが新しい版に切り替わるまでの時間だけだからです。再デプロイの試験が終わったら、残りの四つの試験を実行します。`.env` には、疎通確認のservice tokenの二つの値と、Workers Logsを読む `CLOUDFLARE_API_TOKEN`（`Workers Observability Write` の権限）を入れます。アカウントIDは秘密ではないので、コマンドで渡します。

```sh
CLOUDFLARE_ACCOUNT_ID=4a67230af28ec94d9c70ca48572d8e9f mise exec -- node --env-file=/path/to/.env \
  scripts/check/staging-faults/main.ts --deploy-run <runのID> --evidence <証拠のフォルダー>
```

試験ごとに `PASS`・`FAIL`・`MISSED` の行を出し、証拠のフォルダーに `journey.jsonl`（各試験の前後の案と判定）、`logs.jsonl`（このパターンのWorkers Logsの行）、`container.jsonl`、`deploy-run.json` を書きます。終了コードは三つです。合格は0です。DOの切り替えを観測できなかったときは2で、再デプロイをもう一度頼んで実行し直します。それ以外の失敗は1です。一回の実行で、デプロイが一回、検証用の利用者のジョブが5件（完了3件、停止2件）増え、「障害試験」の案が3件増えます。記録は[検証8](docs/verification/verification-08.md)にあります。

以下は、stagingの環境を最初に作るときの手順です。Cloudflareリソースの作成とデプロイを伴い、ローカルの検査では実行しません。現在のstagingは `https://instant-madori-staging.firpmnfiywl.workers.dev` です。

1. Workers Paidのアカウントで、staging用D1を `wrangler d1 create instant-madori-staging` で、R2バケットを `wrangler r2 bucket create instant-madori-staging` で作成します。Containersを使うにはWorkers Paidが必要です。
2. `apps/worker/wrangler.jsonc` の `env.staging` に、D1のID、画面のOrigin（workers.devのホスト名）、Accessのチームドメインを設定します。この時点では `workers_dev` を無効にしておきます。Accessで守る前に公開すると、静的ファイルはWorkerの認証を通らずに配信されるためです。`preview_urls` は常に無効にします。初期値の `.invalid` 発行元は認証設定の検査で拒否します。
3. `pnpm check --full` を実行します。
4. `pnpm --filter @madori/worker exec wrangler d1 migrations apply DB --remote --env staging` でマイグレーションを適用します。
5. `workers_dev` を無効にしたまま `pnpm --filter @madori/worker exec wrangler deploy --env staging` でデプロイし、公開前にWorkerを作ります。
6. Worker宛先（`destinations: [{"type": "worker", "worker_id": "<WorkerのID>"}]`）のAccessアプリと招待ポリシーを作成します。WorkerのIDは `GET /accounts/{account_id}/workers/scripts` の `tag` です。APIで作る場合は、Accessのアプリとポリシーを編集できるトークンを使います。
7. Accessアプリのaudienceを `ACCESS_AUD` に設定し、`workers_dev` を有効にします。service tokenをAccessで許可して `.env` に設定し、そのrefを上記のworkflowでデプロイします。ログインせずに `/` へアクセスすると、Accessのログイン画面へリダイレクトされることを確かめます。

`GEOMETRY_INSTANCE_TYPE` と `GEOMETRY_IDLE_TIMEOUT_MS` は環境別の設定です。値の根拠は[検証3](docs/verification/verification-03.md)にあります。休止時間は10分のままです。接続用DOが操作の開始・終了時刻を保存し、最後の操作の完了から休止時間が過ぎたらアラームでContainerを止めます。操作には応答本文の読取りを含み、操作中は止めません。停止ログ `container.idle_stopped` の `ms` は最後の操作からの経過時間です。DOが再起動しても保存した期限を戻します。実行環境の停止猶予は休止時間に60秒を足した値にするため、休止時間の設定範囲は60,000〜21,540,000 msです。停止に失敗した場合は記録を残し、1秒から倍増し休止時間を上限とする間隔で再試行します。ローカルの確認は[検証4](docs/verification/verification-04.md)に記録します。Workers Logsを有効にしているので、接続用DOの `container.ready`（`mode: cold` の `ms` が起動時間）とContainer内の `geometry.request`（`vmHwmKib` がメモリの最大値）を、Workers Logsの検索APIで読めます。検索には `Workers Observability Write` の権限を持つトークンが要ります。検証3で使った取得と集計のスクリプトは[記録フォルダ](docs/verification/evidence/verification-03/)にあります。

Container接続用DOと内部プロトコルは `apps/worker/src/geometry/` に置き、`services/` から呼びます。パターンごとの調整DOは `objects/`、ジョブのWorkflowは `workflows/` に置き、どちらも `services/` だけを呼びます。ジョブの形状処理は、パターンごとの接続用DOとそのContainerで行います。

内部APIの本文は `crates/geometry-api` で定義し、`pnpm generate:geometry` でJSON Schema・Zod・TypeScript型を再生成します。Rustをビルドする `pnpm check` でも再生成し、RustとNodeのテストが生成結果の一致を検査します。

### stagingのContainerを計測する

stagingのContainerの計測は `scripts/measure/` のコマンドで行います。Workers Logsを読むコマンドは、`Workers Observability Write` の権限を持つCloudflareのAPIトークンを、環境変数 `CF_API_TOKEN_FILE` が指すファイルから読みます。トークンは出力しません。

| コマンド                                                             | 用途                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm measure:logs --from <ISO時刻> --to <ISO時刻> --out <ファイル>` | 時間帯のWorkers Logsを、古い順に1行1件のJSONで書き出す。各行はログの項目に `t`（ms）と `service` を加えた形で、検証3の `events.jsonl` と同じ。2,000件に達したら、時間帯を狭めるよう求めて失敗する。既存のファイルは上書きしない                                                                                                                           |
| `pnpm -s measure:summary <ファイル>`                                 | 書き出したログから、コールドスタート（`container.ready` の `mode: cold`）、処理時間、`vmHwmKib` の最大値、`geometry.limits`、Containerの起動と停止をJSONで集計する。定義は検証3と同じで、中央値は件数が偶数のとき小さいほうの値を採る                                                                                                                     |
| `pnpm measure:deploy --ref <ブランチ> --instance <種類>`             | pushしたブランチの先頭を、`gh workflow run deploy-staging.yml --ref <ブランチ>` でstagingへデプロイし、実行の成功まで待つ。そのコミットの `env.staging.vars.GEOMETRY_INSTANCE_TYPE` が `<種類>` でないとき、または待機中のデプロイがあるとき（新しい実行が待機中の実行を取り消すため）は、実行を始めずに失敗する。`wrangler.jsonc` の変更とpushは手で行う |
| `pnpm measure:cold`                                                  | 直近2時間のログに現れたContainerがすべて停止し、最後の停止から5分たつまで待つ。次の要求は新しいContainerを起動する                                                                                                                                                                                                                                        |

インスタンスの種類を変えて測るときは、計測用のブランチで `wrangler.jsonc` の種類を変えてcommitとpushをし、`pnpm measure:deploy` と `pnpm measure:cold` を順に実行してから要求を送ります。手で `wrangler deploy --env staging` を実行すると、検証用のClient IDが渡りません。ログには停止したContainerを識別する項目が無いため、`measure:cold` は停止の行を起動の行と対にせず、動いているContainerの数を数えます。複数のパターンのContainerが同時に動くと、早く終わることがあります。測った後に、集計の `coldReadyMs` の件数と、`limits` の `cgroupMemoryMax` が種類と合うことを確かめます。
