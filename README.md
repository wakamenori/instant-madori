# instant-madori

営業と施主が、会話を通じて間取り・3D・住まいのイメージを具体化するWebサービスを開発しています。

仕様・設計・実装順は[実装計画](docs/plan.md)、エージェント向けのルールは[AGENTS.md](AGENTS.md)にあります。

## 開発を始める

macOSまたはLinux、Git（`git subtree`を含む）、[mise](https://mise.jdx.dev/getting-started.html)、rustupを使用します。Node.js・pnpm・検査ツールは`mise.toml`、Rust・Clippy・rustfmt・Wasmターゲットは`rust-toolchain.toml`で固定しています。Dockerは `pnpm dev` と `pnpm check --full` に必要です。Docker DesktopのVMには、12 GBのメモリを割り当ててください。8.32 GBのVMでは、形状サービスのイメージのビルドがメモリ不足で止まりました。画面だけの作業では `MADORI_DEV_CONTAINERS=0 pnpm dev` で起動できます。

リポジトリのルートで実行します。ローカル起動にCloudflareアカウントやAIキーは不要です。

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

`pnpm dev`は、ローカルのD1へマイグレーションを適用してから次のプロセスを起動し、Ctrl-Cでまとめて終了します。ContainerとプロキシはWranglerが終了時に削除します。終了処理の失敗は報告し、起動・実行結果と終了コードを維持します。

Containerを使うローカルセッション（実Containerテスト、別worktreeやself-hosted runnerでの `pnpm check --full`）は同時に起動できます。Miniflareがセッションごとに異なるIDをContainerの名前（`workerd-<ID>-instant-madori-GeometryContainer-...`）に付けるためです。`pnpm dev` だけは8787番と5173番のポートを固定しているので、同時に一つしか起動できません。クラッシュしたセッションのContainerは残ることがあります。`docker ps -a --format '{{.ID}} {{.Names}}'` で `workerd-` で始まる名前を確かめ、動いているセッションがないときに `docker rm --force <ID>...` で削除します。

`pnpm check --full` は最後に、接続先のローカルDocker Engineの未使用ビルドキャッシュを回収します。Cargoのregistry・git・targetを含む `exec.cachemount` は合計8 GiBまで残します。それとは別に、`regular` と `frontend` は最近使った記録から合計4 GiBまで残します。形状サービスの一組の層は、Rustの基底層・aptのRUN・COPY・CargoのRUN・frontendを合わせて約3.30 GBでした。4 GiBの枠でこの一組と更新時の余裕を残し、毎回のRustイメージの再取得とaptの実行を避けます。時間の範囲ではビルドが集中した際の容量を制限できないため、容量で制限します。

各枠を超えた場合は最終使用時刻が古い未使用記録から丸ごと消し、`source.local`・`source.git.checkout`・`internal` の未使用記録はすべて消します。使用中の記録と未知の種類は残し、未知の種類は一行で報告します。Dockerは使用中のcache mountを0バイトと報告するため、その実容量は上限の計算に含められません。使用が終わった後や別のビルドで増えた後は、実容量が上限を超えることがあります。回収後の報告値も、使用中のmountの実容量を保証しません。イメージ・Container・ボリュームは回収しません。Unixソケットで接続するローカルDockerを対象とし、独立したbuildx builderは対象にしません。

手で確かめる場合は `pnpm docker:prune-build-cache --dry-run` で保持・削除候補と容量を表示し、`pnpm docker:prune-build-cache` で回収します。上限を変える場合は `--mount-limit-bytes 8589934592 --layer-limit-bytes 4294967296` のようにバイト数を指定します。このオプションはその実行だけに適用します。

| URL                   | 内容                                                            |
| --------------------- | --------------------------------------------------------------- |
| http://127.0.0.1:5173 | Reactの開発画面。サンプルをWebGPUで描画する                     |
| http://127.0.0.1:8787 | ローカルWorkerとビルド済み静的ファイル。`/api/health`で応答確認 |

サンプルは床と3枚の壁、奥壁の開口で構成します。画面はドラッグでの回転と、スクロールでの拡大・縮小に対応します。ブラウザでは、WebGPUのアダプタがあるChromiumで描画を確かめ、合成したポインタイベントでの回転と、ホイールイベントでの拡大を確かめました。縮小、実際のマウス・トラックパッドでの操作感、Chromium以外のブラウザは確かめていません。Worker → Durable Object → Containerを通してSolidCraftで生成し、Wasmビューアへ表示データを渡します。WebGPUを利用できるブラウザが必要です。初回のamd64イメージのビルドには数分かかります。

Rustサービスだけを反復する場合は `MADORI_INTERNAL_TOKEN=local cargo run -p madori-geometry` で起動します。`http://127.0.0.1:3001/healthz` は認証不要、`/v1/sample/display` は `authorization: Bearer local` が必要です。このプロセスをWorkerが呼ぶことはありません。

### ローカルでのログイン

ローカルではCloudflare Accessの代わりに、生成した開発用の鍵を使います。`pnpm dev`は初回に鍵を `.local/access-key.json` に作り、Workerの設定 `apps/worker/.dev.vars` をそこから生成します。どちらもGitの追跡対象外です。`.dev.vars` は毎回生成し直すので、手で編集しないでください。この仕組み以外で作った `.dev.vars` があると、上書きせずに停止します。

Viteのプロキシ（5173番）経由のAPI要求には、開発者として署名したトークンが付きます。別の利用者として試すときは、`MADORI_DEV_EMAIL=other@example.com pnpm dev` のように起動します。8787番のWorkerへ直接送った要求には認証ヘッダーが付かないため、認証が必要なAPIは401になります。`/api/health` は認証なしで応答し、未知のパスは404、許可していないメソッドは405になります。TypeScriptは開発中に更新されますが、Rust・Wasmを変更したときは再ビルド・再起動してください。

## 日常のコマンド

検査の入口は `pnpm check` にまとめています。すべてのモードで最初にPrettier・rustfmt・ESLintの自動修正を行い、RustもClippyが自動適用できる修正を行ってから再整形・再検査します。修正できない問題が残れば失敗して後続処理を止めます。作業ツリーを書き換えるので、完了後に差分を確認してから必要な変更をステージしてください。コマンドはGitのステージ内容を変更しません。

| コマンド            | 用途                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check --fast` | 自動修正、TypeScriptの型付きlint・型確認、Rustのnative/Wasm Clippy、未使用コード・依存、Dockerfile、upstream境界、SQL接続状態、秘密情報を検査          |
| `pnpm check`        | 通常の作業確認。軽い検査にTypeScriptとRustのテストを追加                                                                                               |
| `pnpm check --full` | 全体確認。releaseのWasmの再生成、Web・Worker・Rustのビルド、ローカル接続テスト、依存のライセンス・取得元・脆弱性監査も実行。Dockerとネットワークが必要 |
| `pnpm dev`          | Web・WorkerとDockerの形状処理Containerを起動                                                                                                           |
| `pnpm build`        | releaseのWasm・Web・Worker・ネイティブRustの成果物だけをビルド                                                                                         |

補助スクリプトは `scripts/check/`・`scripts/dev/`・`scripts/generate/`・`scripts/build/`・`scripts/upstream/`・`scripts/deploy/` に目的別に置き、複数の目的で使う部品は `scripts/shared/` に置きます。テストは対象ファイルと同じフォルダーに置きます。

初期設定は `pnpm setup`、引数の確認は `pnpm check --help`。upstreamの取得・取り込みには後述の `pnpm upstream:check` / `pnpm upstream:update` を使います。個別ツールを順に手動実行する必要はありません。

`--fast` はテスト実行・アプリのビルド・ネットワーク監査を省きます。Rustの型付き検査自体には依存のコンパイルが必要で、初回は時間がかかります。繰り返し実行ではCargoのキャッシュを再利用し、変更されたクレートを検査します。検査ごとの所要時間を出力します。

`pnpm setup`・`pnpm dev`・`pnpm build`・`pnpm check --full` は、同じスクリプトでWasmをreleaseビルドします。Cargoのプロファイルとwasm-bindgenの入力先は一つの値から決め、`target/wasm32-unknown-unknown/release/madori_viewer.wasm` からバインディングを生成します。開発・検査・配信で同じWasmを使います。依存を含む初回のWasmコンパイルは、手元の単発の参考値でdebugが19秒、releaseが31秒でした。初回は長くなりますが、再ビルドでは依存のキャッシュを再利用します。RustのテストとClippyはdebugのままです。

`pnpm setup` で生成したWasmの型定義を通常・軽いモードで使います。初期生成がなければ準備手順を示して停止します。Wasmの公開API・依存・ビルド設定・upstreamを変更した場合は `--full` を実行してください。全体モードではreleaseのWasmを再生成してからTypeScriptを検査し、配信用のWasmもローカル配信と実Containerの接続テストで確認します。

TypeScriptのテストはNode.js標準のtest runnerを使います。HTTP経由のWorker APIテストは、テストファイルごとに一時的なD1へ実際のマイグレーションを適用し、`wrangler dev` でworkerd上のWorkerを起動して、HTTPで検査します。署名にはテスト用の鍵を使い、Cloudflareのアカウントは不要です。`apps/*/{src,tests}/**/*.test.ts`、`packages/*/{src,tests}/**/*.test.ts`、`scripts/**/*.test.ts` が対象です。現在は、WorkerのAPI（認証、所有権、冪等性、版の競合、ページング、サンプル取得、案の確定・読取とR2の内容の照合）、Containerの起動・引継ぎ・障害復帰、内部プロトコル、WebのAPIエラーとビューアの初期化・解放、操作量、アクセシビリティの静的マークアップ、スキーマ・生成契約・環境別バインディングを確認するテストがあります。Rustでは表示形式の固定フィクスチャ・破損入力・大量入力、配置済み形状の書出し、内部API認証、シーン変換とカメラを検査します。Node.jsの型だけを使うテストには専用のtsconfigを用意し、Worker本体の実行環境の型から分けています。RPCとサービスの単体テストはWorkerの型も必要なため、Node用のテストからtsconfigを分けています。これらの単体テスト自体はNodeで動きます。`tests/rpc/` の実D1・R2を使うテストと `revision-fixture.ts` は、共通の `platform-proxy.ts` から `getPlatformProxy` を開き、workerd上のローカルの束縛を呼びます。Containerは起動しません。共通ヘルパーは、呼出し中の参照をMiniflareがGCで先に解放する競合を避けるため、返されたネイティブプロキシを `dispose()` まで保持します。GCの回帰テストは子プロセスを `--expose-gc` で起動し、D1のbatch送信を遅らせて解放処理との順序を確かめます。`revision-fixture.ts` は案の保存のHTTPテストから子プロセスとして起動され、同じ束縛を使ってサービスを実行します。HTTPテストはその間Workerを一時停止し、fixtureは同じ永続化先を指定します。fixtureがproxyを終了してからWorkerを再開し、保存した内容を公開APIから読みます。同じSQLiteファイルを二つのworkerdが同時に開かないためです。静的マークアップとDOM/GPUの代替オブジェクトによる検査は、ブラウザでの実描画を確かめるものではありません。

全体モードもローカル実行で、Cloudflareへのデプロイや本番リソースの作成はしません。Workerのビルドは `--dry-run` です。DockerイメージをビルドしてLinuxで起動し、WorkerとDOを通した表示データの取得を検査します。通常のWorker APIテストとdry-runビルドではContainerを無効にします。

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
| WorkerのSQL                       | `check`の全モードで、WorkerソースのTypeScript文字列・テンプレートとマイグレーションSQLの `changes()`・`total_changes()`・`last_insert_rowid()` を拒否する。大文字・小文字と括弧の前の空白を区別しない。TypeScriptのコメントは除外する。所有者条件などSQLの意味や、文字列の連結・実行時の組み立て、エスケープで書いた文字、`(` の前のコメント、引用符で囲んだ関数名は検査しない                                                                                                                                                                                                                                                                 |
| requests表への書込み              | `check`の全モードで、`apps/worker/src/` のTypeScript文字列・テンプレートにある `requests` 表へのINSERT・UPDATE・DELETE・REPLACEと、INSERTのUPSERTを拒否する。例外は `apps/worker/src/storage/requests.ts` だけとし、読取りは制限しない。大文字小文字、引用符、空白・改行、SQLコメント、スキーマ修飾に対応する。表名を連結・変数・テンプレートの埋込みで実行時に組み立てる書き方は検査できない。`OR`・`INTO`・`FROM` に空白なしで接した埋込み（例：`INSERT OR${conflict} INTO requests`）は検査できない。SQLと通常の文章は区別しないため、`failed to delete from requests` のような文言も誤検出する場合がある                                   |
| D1マイグレーション                | `check`の全モードで、基準にあるファイルの変更・削除・改名と、基準の最大番号以下の追加を拒否する。PRは `origin/main` との分岐点、mainはfirst parentを基準にする。PRのマージコミットにも対応する。Gitの全履歴が必要で、まだmainにないマイグレーションの修正は許可する。前の版のWorkerとの両立はレビューで確かめる                                                                                                                                                                                                                                                                                                                                |
| Dockerfile                        | hadolint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| upstreamとの境界                  | 採用版とのファイル照合、独自変更の記録、Cargo workspaceと依存先の検査                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 依存の境界                        | `scripts/check/boundaries.ts` の表から、TypeScriptはコンパイラAPIで解決した参照先ファイルの検査とESLintの構文・global制限を、Rustは `cargo metadata` と `cargo tree` の検査を組み立てる。Rustの依存グラフの行は、禁止するcrateを、守る性質ごとの集まり（UIツールキット、GPU、pluginの実行環境、編集エンジン）で指定する。表の各行を違反・許可の例でテストする。Workerの層は許可先から禁止先を生成し、未宣言ディレクトリも拒否する。import境界は自動修正後の`check`とpre-commitで検査し、エディタのESLint診断には出ない。非文字列の動的importは構文で拒否する。層外の再export、`require()` の呼出し、servicesの `fetch`・`Headers` は検査しない |

Workerの保存境界では、型名・バインディングの取り出し・組み立て関数の入口を別の行で検査する。`storage/` では `z.any` と `z.custom` を禁止し、行の型は渡したスキーマから導出する。テストは破損注入のためにこれらの制限を除外し、ブランド型への直接キャストと `as never` の禁止だけは適用する。この構文検査では、次の形を防げない。

- 作成の証拠の行が、その要求の文で新しく作られたか。既存のIDを証拠にすると、変更のない記録が残る。
- 作成の文が何かを作るとき、必ず証拠の行も作るか。そうでなければ記録のない変更が残り、再送で繰り返される。
- 冪等な操作の結果のSQLが、正しい結果を作るか。
- `OwnerId`・`VerifiedIdentity` の名前を書かないキャストで作る形。ブランドを含む型へのキャスト（例：`as AuthenticatedUser`、`as AuthenticatedUser["id"]`、`as RequestKey`）、型の別名を通したキャストがこれに当たる。
- `JobExecutionRight` の型の別名、indexed access、tuple、union、`typeof`、名前を変えたimport、`import()` 型を通したキャスト。直接の型名と名前空間付きの型名へのキャストは構文検査で拒む。実行権を受け取る操作は、非公開の欄の存在を実行時に確認してからその欄を読み、偽造した値がD1・R2へ届くことを防ぐ。
- 保存結果の `resolved.constructor` を構築可能な型へキャストし、任意の利用者行を渡す形。非公開コンストラクタも、明示的なキャストによる偽造までは防がない。
- `VerifiedIdentity` の欄の直接代入や `Object.assign` による書き換えは、生成時の凍結で拒否する。既存の証拠をspreadし、別の値へ置き換えたオブジェクトや、型の偽造はこの保証に含まれない。
- 使う箇所にキャストを書かず、宣言で型を作る形。型述語、ジェネリックの補助関数、オーバーロードのシグネチャ、戻り値の型の宣言がこれに当たる。
- 計算したキーやrest分割代入でバインディングを取り出す形。
- `zod` の別名やnamespaceのimport、計算したプロパティ、分割代入、`zod/v4` などの別のパスから `any`・`custom` を名前でimportする形と、`z.ZodType<T>` へのキャストや `transform` の中のキャストで検証しないスキーマを作る形。
- 例外として許可したファイル（`compose.ts`、`api/app.ts`、`storage/` のファイル）が、組み立て関数、Storeやアダプターの構築関数を再exportする形。再exportしたものは、そのファイルを値としてimportできる層と `src/` 直下のファイルから使える。

`OwnerId` は他のIDとの取り違えを型で防ぎ、生成には `VerifiedIdentity` と保存処理を通った結果を要求する。異なる認証主体の結果との組み合わせは実行時に拒否する。上記の明示的な偽造やSQLの所有者条件は保証しない。所有者条件は実際のD1に対する所有権のテストとレビューで確かめる。

自作コードのlint・一括整形・未使用検査は、`third_party/solidcraft`を対象にしません。生成物も除外し、過去の検証記録・証拠は一括整形しません。依存の脆弱性やライセンスの検査対象はソースの配置で除外せず、サービスのlockfileから決めます。

Lefthookのコミット前検査は、ステージした自作ファイルの整形・lint、自作Rustの整形、秘密情報です。自動修正は先に `pnpm check` で行い、整形・lintはステージ対象ファイルの作業ツリーを、秘密情報はステージ済みの差分を検査します。フックはファイルやGitのステージ内容を書き換えません。部分ステージした変更をまとめてステージすることはありません。フックだけでは全体の型確認・テストを代替できません。

Dependabotはnpm・Cargoの更新提案用に残し、upstream本体はsubtreeの手順で更新します。

## PRの検査（self-hosted runner）

PRごとに `.github/workflows/check.yml` が、開発用Macのself-hosted runner（ラベル `madori`）で `pnpm setup` と `pnpm check` を実行します。変更したファイルから `scripts/check/ci-mode.ts` が `--full` を付けるかを決めます。最後に、自動修正で差分が出ていないことを確かめます。GitHubのrunnerは使いません。無料プランのprivateリポジトリでは2コア・ディスクの空き13 GBで、`--full` がディスク不足で失敗し、無料枠も足りないためです。

checkoutは毎回clone直後と同じ状態から始めます。Rustの `target/` と `.tools/` だけは、`$RUNNER_TOOL_CACHE/madori` へのシンボリックリンクで実行の間に再利用します。runnerの `--full` は、手元の `pnpm dev` や `pnpm check --full` と同時に動いても衝突しません。

runnerでも `--full` の最後に、手元と同じ規則でDockerのビルドキャッシュを回収します。cache mountは合計8 GiBまで、最近使ったregularとfrontendは別枠で合計4 GiBまで残します。使用中の記録はBuildKitが保持するため、並行するビルドの記録は消しません。使用中のcache mountの0バイトという報告値では実容量を把握できません。runnerの `target/` と `.tools/` はこの回収の対象にしません。

このリポジトリではブランチ保護を使えないため、検査の成功はマージの条件として強制されません。マージの前に、PRの最新のheadで `check` が成功していることを確かめます。

runnerを入れ直すときは、[actions/runner](https://github.com/actions/runner/releases)のosx-arm64版を `~/actions-runner/instant-madori` に展開し、リポジトリの登録トークン（`gh api -X POST repos/wakamenori/instant-madori/actions/runners/registration-token`）で `./config.sh --labels madori` を実行します。mise・cargo・Dockerのある `PATH` で設定すると、runnerがその `PATH` を保存します。runnerの `.env` には、作業フォルダーを信頼する `MISE_TRUSTED_CONFIG_PATHS=<runnerのフォルダー>/_work` と、デプロイ用の認証情報を読む `MADORI_ENV_FILE=<リポジトリの .env の絶対パス>` を書きます。最後に `./svc.sh install` と `./svc.sh start` でlaunchdに常駐させます。外すときは `./svc.sh uninstall` の後に `./config.sh remove` を実行します。

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
| `apps/worker`            | Cloudflare WorkersのAPI・静的配信                                                      |
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

**upstreamの更新は原則取り込みます。** 住宅サービスへの影響を確認し、問題があれば調整するか、理由を記録して保留します。採用版は[solidcraft.json](third_party/solidcraft.json)、独自変更・更新手順・初回移行の記録は[solidcraft.md](third_party/solidcraft.md)を参照してください。

SolidCraftの元のREADME・資料・ライセンスは取り込み領域に保持しています。[MITライセンス](third_party/solidcraft/LICENSE-MIT)、[Apacheライセンス](third_party/solidcraft/LICENSE-APACHE)、[NOTICE](third_party/solidcraft/NOTICE)、[資産と依存の帰属](third_party/solidcraft/ATTRIBUTION.md)を参照してください。

## stagingへデプロイする

mainへのpushで、`.github/workflows/deploy-staging.yml` がself-hosted runnerでstagingへデプロイします。`pnpm check --full`、D1のマイグレーションの適用、`wrangler deploy --env staging` の順に進め、その後 `scripts/check/staging-smoke.ts` で、Accessを通した疎通を確かめます。デプロイは途中で止めず、後から来たpushは前のデプロイが終わってから最新のmainをデプロイします。マイグレーションはデプロイの前に適用するため、動いている前の版のWorkerと両立する形で書きます。mainに入ったマイグレーションは変更せず、修正は番号の大きいファイルを追加します。`pnpm check` の全モードがこの不変条件を検査し、デプロイ時は一つ前のmainと比較します。

疎通の確認では、Accessのservice tokenを、固定の検証用ユーザー（subjectは `staging:verifier`、メールアドレスは `verifier@staging.invalid`）として使います。token無しの302、`/api/health` の200、`/api/me` の200と検証用メールアドレスを確かめます。案件を固定のrequest IDで作成・再送し、一覧から現在のversionを読んで名前を変更します。versionが一つ増え、読み直した一覧に変更が反映されること、存在しない案件のパターン一覧が404 `not_found` になること、`/api/sample/display` が表示データを返すことも確かめます。要求の期限は、Containerのreadinessの60秒と表示処理の30秒に、通信の余裕を加えた120秒です。検証用の案件と最初のパターンは一つに保ち、二回目以降は確認ごとに `requests` の行だけが一つ増えます。R2には書き込みません。

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

疎通とR2の確認が成功した後、レジストリのstaging用イメージを回収します。新しい順に10のWorkerの版と、今のデプロイに含まれるすべての版が指すダイジェストのタグを残します。同じダイジェストの別名のタグもすべて残します。古い版だけが指すタグを消し、Wranglerに未使用レイヤーの回収を依頼します。どの版からも指されていないタグは消さず、`unreferenced` に出します。他のリポジトリは対象にしません。全版のページ送り、対象リポジトリの特定、すべての対象タグのダイジェストの取得が成功しなければ、削除前に失敗します。

手元から候補だけを見るには、staging用の `CLOUDFLARE_API_TOKEN` が入った `.env` を指定します。既定は表示だけです。出力の `keep` は保持、`remove` は削除候補、`unreferenced` は参照のない保持タグです。トークンとレジストリのパスワードは出力しません。削除する `--apply` はworkflowが使います。

```sh
mise exec -- node --env-file=/path/to/.env scripts/deploy/registry-retention.ts --dry-run
```

以下は、stagingの環境を最初に作るときの手順です。Cloudflareリソースの作成とデプロイを伴い、ローカルの検査では実行しません。現在のstagingは `https://instant-madori-staging.firpmnfiywl.workers.dev` です。

1. Workers Paidのアカウントで、staging用D1を `wrangler d1 create instant-madori-staging` で、R2バケットを `wrangler r2 bucket create instant-madori-staging` で作成します。Containersを使うにはWorkers Paidが必要です。
2. `apps/worker/wrangler.jsonc` の `env.staging` に、D1のID、画面のOrigin（workers.devのホスト名）、Accessのチームドメインを設定します。この時点では `workers_dev` を無効にしておきます。Accessで守る前に公開すると、静的ファイルはWorkerの認証を通らずに配信されるためです。`preview_urls` は常に無効にします。初期値の `.invalid` 発行元は認証設定の検査で拒否します。
3. `pnpm check --full` を実行します。
4. `pnpm --filter @madori/worker exec wrangler d1 migrations apply DB --remote --env staging` でマイグレーションを適用します。
5. `workers_dev` を無効にしたまま `pnpm --filter @madori/worker exec wrangler deploy --env staging` でデプロイし、公開前にWorkerを作ります。
6. Worker宛先（`destinations: [{"type": "worker", "worker_id": "<WorkerのID>"}]`）のAccessアプリと招待ポリシーを作成します。WorkerのIDは `GET /accounts/{account_id}/workers/scripts` の `tag` です。APIで作る場合は、Accessのアプリとポリシーを編集できるトークンを使います。
7. Accessアプリのaudienceを `ACCESS_AUD` に設定し、`workers_dev` を有効にします。service tokenをAccessで許可して `.env` に設定し、そのrefを上記のworkflowでデプロイします。ログインせずに `/` へアクセスすると、Accessのログイン画面へリダイレクトされることを確かめます。

`GEOMETRY_INSTANCE_TYPE` と `GEOMETRY_IDLE_TIMEOUT_MS` は環境別の設定です。値の根拠は[検証3](docs/verification/verification-03.md)にあります。休止時間は10分のままです。接続用DOが操作の開始・終了時刻を保存し、最後の操作の完了から休止時間が過ぎたらアラームでContainerを止めます。操作には応答本文の読取りを含み、操作中は止めません。停止ログ `container.idle_stopped` の `ms` は最後の操作からの経過時間です。DOが再起動しても保存した期限を戻します。実行環境の停止猶予は休止時間に60秒を足した値にするため、休止時間の設定範囲は60,000〜21,540,000 msです。停止に失敗した場合は記録を残し、1秒から倍増し休止時間を上限とする間隔で再試行します。ローカルの確認は[検証4](docs/verification/verification-04.md)に記録します。Workers Logsを有効にしているので、接続用DOの `container.ready`（`mode: cold` の `ms` が起動時間）とContainer内の `geometry.request`（`vmHwmKib` がメモリの最大値）を、Workers Logsの検索APIで読めます。検索には `Workers Observability Write` の権限を持つトークンが要ります。検証3で使った取得と集計のスクリプトは[記録フォルダ](docs/verification/evidence/verification-03/)にあります。

Container接続用DOと内部プロトコルは `apps/worker/src/geometry/` に置き、`services/` から呼びます。将来のパターンごとの調整DOは `objects/` から `services/` を呼ぶ構成です。

内部APIの本文は `crates/geometry-api` で定義し、`pnpm generate:geometry` でJSON Schema・Zod・TypeScript型を再生成します。`pnpm check` も全モードで再生成し、RustとNodeのテストが生成結果の一致を検査します。
