# instant-madori

営業と施主が、会話を通じて間取り・3D・住まいのイメージを具体化するWebサービスを開発しています。

仕様・設計・実装順は[実装計画](docs/plan.md)、エージェント向けのルールは[AGENTS.md](AGENTS.md)にあります。

## 開発を始める

macOSまたはLinux、Git（`git subtree`を含む）、[mise](https://mise.jdx.dev/getting-started.html)、rustupを使用します。Node.js・pnpm・検査ツールは`mise.toml`、Rust・Clippy・rustfmt・Wasmターゲットは`rust-toolchain.toml`で固定しています。Dockerは `pnpm dev` と `pnpm check --full` に必要です。画面だけの作業では `MADORI_DEV_CONTAINERS=0 pnpm dev` で起動できます。

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

初回はRust・Wasmと依存ライブラリをビルドします。`pnpm setup`はツールの準備、Wasmバインディング・Worker型の生成、コミット時の検査フックの登録を行います。wasm-bindgen CLIはライブラリと同じ版を、このリポジトリの`.tools/`へインストールします。依存のインストールだけではGitフックを変更しません。

`pnpm dev`は、ローカルのD1へマイグレーションを適用してから次のプロセスを起動し、Ctrl-Cでまとめて終了します。ContainerとプロキシはWranglerが終了時に削除します。終了処理の失敗は報告し、起動・実行結果と終了コードを維持します。

Containerを使うローカルセッション（実Containerテスト、別worktreeやself-hosted runnerでの `pnpm check --full`）は同時に起動できます。Miniflareがセッションごとに異なるIDをContainerの名前（`workerd-<ID>-instant-madori-GeometryContainer-...`）に付けるためです。`pnpm dev` だけは8787番と5173番のポートを固定しているので、同時に一つしか起動できません。クラッシュしたセッションのContainerは残ることがあります。`docker ps -a --format '{{.ID}} {{.Names}}'` で `workerd-` で始まる名前を確かめ、動いているセッションがないときに `docker rm --force <ID>...` で削除します。

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

| コマンド            | 用途                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check --fast` | 作業中。自動修正、TypeScriptの型付きlint・型確認、Rustのnative/Wasm Clippy、未使用コード・依存、Dockerfile、upstream境界、秘密情報を検査      |
| `pnpm check`        | 通常の作業確認。軽い検査にTypeScriptとRustのテストを追加                                                                                      |
| `pnpm check --full` | 全体確認。Wasmの再生成、Web・Worker・Rustのビルド、ローカル接続テスト、依存のライセンス・取得元・脆弱性監査も実行。Dockerとネットワークが必要 |
| `pnpm dev`          | Web・WorkerとDockerの形状処理Containerを起動                                                                                                  |
| `pnpm build`        | Wasm・Web・Worker・ネイティブRustの成果物だけをビルド                                                                                         |

補助スクリプトは `scripts/check/`・`scripts/dev/`・`scripts/generate/`・`scripts/build/`・`scripts/upstream/` に目的別に置き、複数の目的で使う部品は `scripts/shared/` に置きます。テストは対象ファイルと同じフォルダーに置きます。

初期設定は `pnpm setup`、引数の確認は `pnpm check --help`。upstreamの取得・取り込みには後述の `pnpm upstream:check` / `pnpm upstream:update` を使います。個別ツールを順に手動実行する必要はありません。

`--fast` はテスト実行・アプリのビルド・ネットワーク監査を省きます。Rustの型付き検査自体には依存のコンパイルが必要で、初回は時間がかかります。繰り返し実行ではCargoのキャッシュを再利用し、変更されたクレートを検査します。検査ごとの所要時間を出力します。

`pnpm setup` で生成したWasmの型定義を通常・軽いモードで使います。初期生成がなければ準備手順を示して停止します。Wasmの公開API・依存・ビルド設定・upstreamを変更した場合は `--full` を実行してください。全体モードではWasmを再生成してからTypeScriptを検査し、実際に生成したWasmも接続テストで確認します。

TypeScriptのテストはNode.js標準のtest runnerを使います。HTTP経由のWorker APIテストは、テストファイルごとに一時的なD1へ実際のマイグレーションを適用し、`wrangler dev` でworkerd上のWorkerを起動して、HTTPで検査します。署名にはテスト用の鍵を使い、Cloudflareのアカウントは不要です。`apps/*/{src,tests}/**/*.test.ts`、`packages/*/{src,tests}/**/*.test.ts`、`scripts/**/*.test.ts` が対象です。現在は、WorkerのAPI（認証、所有権、冪等性、版の競合、ページング、サンプル取得、案の確定・読取とR2の内容の照合）、Containerの起動・引継ぎ・障害復帰、内部プロトコル、WebのAPIエラーとビューアの初期化・解放、操作量、アクセシビリティの静的マークアップ、スキーマ・生成契約・環境別バインディングを確認するテストがあります。Rustでは表示形式の固定フィクスチャ・破損入力・大量入力、配置済み形状の書出し、内部API認証、シーン変換とカメラを検査します。Node.jsの型だけを使うテストには専用のtsconfigを用意し、Worker本体の実行環境の型から分けています。RPCとサービスの単体テストはWorkerの型も必要なため、Node用のテストからtsconfigを分けています。これらの単体テスト自体はNodeで動き、workerdやContainerを起動しません。例外として、`tests/rpc/revision-fixture.ts` は単体テストではなく、案の保存のHTTPテストから子プロセスとして起動され、`getPlatformProxy` 経由のworkerdでローカルのD1・R2に対してサービスを実行します。HTTPテストはその間Workerを一時停止し、fixtureは同じ永続化先を指定します。fixtureがproxyを終了してからWorkerを再開し、保存した内容を公開APIから読みます。同じSQLiteファイルを二つのworkerdが同時に開かないためです。静的マークアップとDOM/GPUの代替オブジェクトによる検査は、ブラウザでの実描画を確かめるものではありません。

全体モードもローカル実行で、Cloudflareへのデプロイや本番リソースの作成はしません。Workerのビルドは `--dry-run` です。DockerイメージをビルドしてLinuxで起動し、WorkerとDOを通した表示データの取得を検査します。通常のWorker APIテストとdry-runビルドではContainerを無効にします。

## 検査の担当と範囲

| 対象                              | 検査                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript・React・開発スクリプト | TypeScriptのstrict設定、型情報を使うESLint、React Hooksルール                                                                                                                                                                                                                                                                                                                                                                                                            |
| 整形                              | Prettier、rustfmt、EditorConfig。文章は文字数による自動改行をしない                                                                                                                                                                                                                                                                                                                                                                                                      |
| Rust                              | Clippyで警告をエラーにする。自作コードのunsafe・unwrap・expect・panicなどを禁止                                                                                                                                                                                                                                                                                                                                                                                          |
| 未使用コード・依存                | Knipとcargo-machete                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 依存の脆弱性                      | pnpm audit、cargo-deny。JSはlow以上、Rustは脆弱性・yankedを検査し、unmaintainedはworkspaceの直接依存を対象にする                                                                                                                                                                                                                                                                                                                                                         |
| 依存のライセンス・取得元          | pnpmのメタデータでJSのGPL/LGPL/AGPL・不明ライセンスを拒否し、Rustはcargo-denyの許可リストで検査。Rustは実際に使うSolidCraft側の依存も対象                                                                                                                                                                                                                                                                                                                                |
| 秘密情報                          | Gitleaks。`check`の全モードで追跡済み・未追跡のGit管理対象ファイル、コミット時にステージ済みの差分を検査。gitignoreされたローカル認証情報は除く。Gitの全履歴の監査ではない                                                                                                                                                                                                                                                                                               |
| WorkerのSQL                       | `check`の全モードで、WorkerソースのTypeScript文字列・テンプレートとマイグレーションSQLの `changes(` を拒否する。大文字・小文字と括弧の前の空白を区別しない。TypeScriptのコメントは除外する。所有者条件などSQLの意味や、文字列の連結・実行時の組み立ては検査しない                                                                                                                                                                                                        |
| Dockerfile                        | hadolint                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| upstreamとの境界                  | 採用版とのファイル照合、独自変更の記録、Cargo workspaceと依存先の検査                                                                                                                                                                                                                                                                                                                                                                                                    |
| 依存の境界                        | `scripts/check/boundaries.ts` の表から、TypeScriptはESLintのimport・構文・global制限を、Rustは `cargo metadata` とContainer対象のpackage別 `cargo tree` による検査を組み立てる。表の各行に違反と許可の例をテストする。Workerの層は許可先から禁止先を生成し、`src/` 直下の未宣言ディレクトリも拒否する。層に属さないファイルを経由した再exportは検査しない。`require()`、servicesの `fetch`・`Headers` は検査しない。`../worker/` の判定はWeb内の同名フォルダーも拒否する |

Workerの保存境界では、型名・バインディングの取り出し・組み立て関数の入口を別の行で検査する。`storage/` では `z.any` と `z.custom` を禁止し、行の型は渡したスキーマから導出する。テストは破損注入のためにこれらの制限を除外し、ブランド型への直接キャストと `as never` の禁止だけは適用する。この構文検査では、次の形を防げない。

- `OwnerId`・`VerifiedIdentity` の名前を書かないキャストで作る形。ブランドを含む型へのキャスト（例：`as AuthenticatedUser`、`as AuthenticatedUser["id"]`、`as RequestKey`）、型の別名を通したキャストがこれに当たる。
- 使う箇所にキャストを書かず、宣言で型を作る形。型述語、ジェネリックの補助関数、オーバーロードのシグネチャ、戻り値の型の宣言がこれに当たる。
- 計算したキーやrest分割代入でバインディングを取り出す形。
- `zod` の別名やnamespaceのimport、計算したプロパティ、分割代入、`zod/v4` などの別のパスから `any`・`custom` を名前でimportする形と、`z.ZodType<T>` へのキャストや `transform` の中のキャストで検証しないスキーマを作る形。
- 例外として許可したファイル（`compose.ts`、`api/app.ts`、`services/users.ts`、`storage/` のファイル）が、組み立て関数、`authenticatedUser`、Storeやアダプターの構築関数を再exportする形。再exportしたものは、そのファイルを値としてimportできる層と `src/` 直下のファイルから使える。
- 組み立て関数・`authenticatedUser`・Storeとアダプターの構築関数のimport制限は、ファイル名（`compose`・`owner`・`storage/store`・`storage/d1`・`storage/r2`）で判定する。そのため、別の場所に同じ名前、またはその名前と `.` で始まる名前（例：`compose.helpers.ts`）のファイルを作ると、無関係なimportも拒否する。

`OwnerId` は他のIDとの取り違えを型で防ぐもので、IDの由来やSQLの所有者条件を保証しない。所有者条件は実際のD1に対する所有権のテストとレビューで確かめる。

自作コードのlint・一括整形・未使用検査は、`third_party/solidcraft`を対象にしません。生成物も除外し、過去の検証記録・証拠は一括整形しません。依存の脆弱性やライセンスの検査対象はソースの配置で除外せず、サービスのlockfileから決めます。

Lefthookのコミット前検査は、ステージした自作ファイルの整形・lint、自作Rustの整形、秘密情報です。自動修正は先に `pnpm check` で行い、整形・lintはステージ対象ファイルの作業ツリーを、秘密情報はステージ済みの差分を検査します。フックはファイルやGitのステージ内容を書き換えません。部分ステージした変更をまとめてステージすることはありません。フックだけでは全体の型確認・テストを代替できません。

Dependabotはnpm・Cargoの更新提案用に残し、upstream本体はsubtreeの手順で更新します。

## PRの検査（self-hosted runner）

PRごとに `.github/workflows/check.yml` が、開発用Macのself-hosted runner（ラベル `madori`）で `pnpm setup` と `pnpm check` を実行します。変更したファイルから `scripts/check/ci-mode.ts` が `--full` を付けるかを決めます。最後に、自動修正で差分が出ていないことを確かめます。GitHubのrunnerは使いません。無料プランのprivateリポジトリでは2コア・ディスクの空き13 GBで、`--full` がディスク不足で失敗し、無料枠も足りないためです。

checkoutは毎回clone直後と同じ状態から始めます。Rustの `target/` と `.tools/` だけは、`$RUNNER_TOOL_CACHE/madori` へのシンボリックリンクで実行の間に再利用します。runnerの `--full` は、手元の `pnpm dev` や `pnpm check --full` と同時に動いても衝突しません。

このリポジトリではブランチ保護を使えないため、検査の成功はマージの条件として強制されません。マージの前に、PRの最新のheadで `check` が成功していることを確かめます。

runnerを入れ直すときは、[actions/runner](https://github.com/actions/runner/releases)のosx-arm64版を `~/actions-runner/instant-madori` に展開し、リポジトリの登録トークン（`gh api -X POST repos/wakamenori/instant-madori/actions/runners/registration-token`）で `./config.sh --labels madori` を実行します。mise・cargo・Dockerのある `PATH` で設定すると、runnerがその `PATH` を保存します。runnerの `.env` には、作業フォルダーを信頼する `MISE_TRUSTED_CONFIG_PATHS=<runnerのフォルダー>/_work` と、デプロイ用の認証情報を読む `MADORI_ENV_FILE=<リポジトリの .env の絶対パス>` を書きます。最後に `./svc.sh install` と `./svc.sh start` でlaunchdに常駐させます。外すときは `./svc.sh uninstall` の後に `./config.sh remove` を実行します。

VS Code向けの推奨拡張・保存時整形・ESLint自動修正・Rust Analyzer設定を `.vscode/` に用意しています。他のエディタやエージェントによる直接編集でも、同じ `pnpm check` を使えます。

## 作業の管理

作業の単位と状態はGitHubのmilestoneとIssueで管理し、[plan.md](docs/plan.md)には仕様と設計を書きます。計画にある作業は、着手する前にすべてIssueにしておき、plan.mdにだけ書かれた作業を残しません。milestoneは計画6章の段階に対応し、名前には節の番号を付けません（例：サービス基盤）。段階の順は6章の節の順で、milestoneの番号も同じ順です。Issueは一つのPRで終わる作業で、[テンプレート](.github/ISSUE_TEMPLATE/unit.md)の欄（目的、計画の該当節、範囲、終わった証拠、依存、人の判断）をすべて埋めます。範囲の「PRで決めること」は任意で、PRでpstackのarchitectとinterrogateを使って決める設計の問いを書きます。PRは、対応するIssueを本文の `Closes #<番号>` で閉じます。

一つのIssueには、変更を一つだけ入れます。その変更は自分の証拠を持ち、ほかの変更と関係なく失敗しうるものです。別々に確かめられる二つの変更を一つの下書きが含むときは、二つのIssueに分けます。

作業中に見つかった問題や改善案は、milestoneの無いIssueに「振り分け待ち」のラベルを付けて入れます。計画を進める指揮役が、その中身を確かめてmilestoneへ振り分けます。

段階を新しくIssueに分けるときは、次の順に進めます。

1. 下書きを `.issues/<id>.md` に書きます。このフォルダーはGitで追跡しません。本文はテンプレートと同じ見出しにし、先頭のfrontmatterに `id`、`title`、`milestone`、`blockedBy`（先に閉じる必要がある下書きの `id` か既存のIssueの `#<番号>`、カンマ区切り）を書きます。`#` を含む値は引用符で囲みます。YAMLでは、値の先頭か空白の直後にある、引用符の外の `#` から後ろがコメントになるためです。依存の欄では、まだ番号のない下書きを `#<id>` で指し、`blockedBy` と同じものだけを並べます。
2. 下書きを書いたエージェントとは別のエージェントが、下書きをplan.mdとコードに照らして確かめます。確かめるのは、計画の抜けと重複、下書き同士の食い違い、終わった証拠が実行できる形で書いてあるか、依存の向き、人の判断が要る項目です。plan.mdがコードや決めたことと食い違っていれば、下書きに合わせず、正しい内容を決めてplan.mdを直します。指摘を直してから次へ進みます。
3. 依存の先から順にIssueを作り、依存の欄の `#<id>` を実際の番号に置き換えます。`blockedBy` の組は、GitHubのIssueの依存関係（blocked by）にも登録します。Issueを作った後は、Issueを正とし、下書きは消します。

### 次に着手するIssue

着手できるIssueは、GitHubの検索 `is:issue is:open milestone:"<milestoneの名前>" -is:blocked` で一覧できます。依存関係に登録したIssueがすべて閉じたものだけが残ります。

選ぶのは、開いているmilestoneのうち最も前の段階のIssueです。その段階に、担当のいない着手できるIssueが無いときだけ、次の段階から選びます。同じ段階の中では、実環境での確認や試作のように危険を早く明らかにするIssueを先に選び、次に、後に続く依存の鎖が最も長いIssueを選びます。それでも決まらなければ、番号の小さいIssueを選びます。

### milestoneを閉じる

milestoneは、そのIssueがすべて閉じたときに閉じます。Issueが一つも無いmilestoneは閉じません。段階の受け入れを確かめるIssueは、記録に失敗や未確認の項目が一つでも残る間は閉じず、直した後に確かめ直します。milestoneを閉じる前に、pstackのreflectでその段階の進め方を振り返り、見つかった改善を「振り分け待ち」のIssueにします。

## 依存とツールを更新する

Node.js・pnpm・CLI検査ツールの版は`mise.toml`、共有するTypeScript・Node型・Zodの版は`pnpm-workspace.yaml`のcatalogで変更します。Node.jsは`.node-version`とも揃えます。TypeScriptは型付きlintの対応範囲に合わせて6.0系を採用しています。

pnpmは厳密なpeer dependency検査と、公開後24時間未満のパッケージを採用しない設定です。インストールスクリプトの実行は必要なパッケージだけ許可します。manifestや設定が変わったら明示的に`pnpm install`を実行し、コマンド実行時の自動インストールはしません。生成されたlockfileを確認し、`pnpm check --full` で依存監査も通してからコミットします。

一時的な依存上書きには理由を残します。現在のminimatchの上書きは[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)への対応です。ESLint/typescript-eslint側が修正版を採用したら取り除きます。

Miniflareのsharp依存は、LGPLのlibvipsを含むため除外しています。現在使うWorker・静的配信には不要ですが、Cloudflare Imagesバインディングと`cf.image`のローカル画像変換は使えません。画像添付・R2への保存とは別の機能です。この機能を追加するときはライセンス方針と実行方法を再検討してください。

## 配置と依存関係

| 場所                     | 担当                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `apps/web`               | React・TypeScriptの画面                                                      |
| `apps/worker`            | Cloudflare WorkersのAPI・静的配信                                            |
| `apps/geometry`          | ネイティブRustのHTTP入口、Container用Dockerfile                              |
| `crates/display`         | 依存を持たない表示データの型と版付きバイナリ形式                             |
| `crates/geometry-api`    | 内部API契約とTypeScript定義の生成                                            |
| `crates/housing`         | 住宅データと整合性。環境整備時点ではモジュールの入口のみ                     |
| `crates/modeling`        | 住宅操作とSolidCraftの接続                                                   |
| `crates/viewer`          | SolidCraftのgeom・render・gpuを使うWasm                                      |
| `packages/contracts`     | WebとWorkerで共有するスキーマ。住宅の通信型はRust実装時に生成を追加          |
| `third_party/solidcraft` | upstream一式。専用のCargo workspaceとして保持                                |
| `docs`                   | 実装計画、過去の判断・検証記録                                               |
| `scripts`                | ビルド・起動・検査・upstream更新のTypeScriptスクリプト。Node.js 26で直接実行 |

ルートのCargo.lockとpnpm-lock.yamlがサービスの依存関係を固定します。SolidCraftの未使用アプリは通常のビルド対象に含めません。

## SolidCraftの更新

**upstreamの更新は原則取り込みます。** 住宅サービスへの影響を確認し、問題があれば調整するか、理由を記録して保留します。採用版は[solidcraft.json](third_party/solidcraft.json)、独自変更・更新手順・初回移行の記録は[solidcraft.md](third_party/solidcraft.md)を参照してください。

SolidCraftの元のREADME・資料・ライセンスは取り込み領域に保持しています。[MITライセンス](third_party/solidcraft/LICENSE-MIT)、[Apacheライセンス](third_party/solidcraft/LICENSE-APACHE)、[NOTICE](third_party/solidcraft/NOTICE)、[資産と依存の帰属](third_party/solidcraft/ATTRIBUTION.md)を参照してください。

## stagingへデプロイする

mainへのpushで、`.github/workflows/deploy-staging.yml` がself-hosted runnerでstagingへデプロイします。`pnpm check --full`、D1のマイグレーションの適用、`wrangler deploy --env staging` の順に進め、最後に `scripts/check/staging-smoke.ts` で、Accessを通した疎通を確かめます。デプロイは途中で止めず、後から来たpushは前のデプロイが終わってから最新のmainをデプロイします。マイグレーションはデプロイの前に適用するため、動いている前の版のWorkerと両立する形で書きます。

疎通の確認では、Accessのservice tokenを使います。token無しでAccessのログインへ302でリダイレクトされること、`/api/health` が200を返すこと、`/api/me` が403 `forbidden` を返すことを確かめます。Workerはservice tokenの利用者を受け付けないため、403は、WorkerがAccessのJWTを設定した発行元・audienceで検証したことを示します。認証の要るAPIはこの確認では呼びません。runnerは、`MADORI_ENV_FILE` が指す `.env` から、`CLOUDFLARE_API_TOKEN`、`STAGING_ACCESS_CLIENT_ID`、`STAGING_ACCESS_CLIENT_SECRET` だけを読みます。service tokenはAccessアプリの `non_identity` のポリシーで許可し、期限は1年です。

以下は、stagingの環境を最初に作るときの手順です。Cloudflareリソースの作成とデプロイを伴い、ローカルの検査では実行しません。現在のstagingは `https://instant-madori-staging.firpmnfiywl.workers.dev` です。

1. Workers Paidのアカウントで、staging用D1を `wrangler d1 create instant-madori-staging` で、R2バケットを `wrangler r2 bucket create instant-madori-staging` で作成します。Containersを使うにはWorkers Paidが必要です。
2. `apps/worker/wrangler.jsonc` の `env.staging` に、D1のID、画面のOrigin（workers.devのホスト名）、Accessのチームドメインを設定します。この時点では `workers_dev` を無効にしておきます。Accessで守る前に公開すると、静的ファイルはWorkerの認証を通らずに配信されるためです。`preview_urls` は常に無効にします。初期値の `.invalid` 発行元は認証設定の検査で拒否します。
3. `pnpm check --full` を実行します。
4. `pnpm --filter @madori/worker exec wrangler d1 migrations apply DB --remote --env staging` でマイグレーションを適用します。
5. `workers_dev` を無効にしたまま `pnpm --filter @madori/worker exec wrangler deploy --env staging` でデプロイし、公開前にWorkerを作ります。
6. Worker宛先（`destinations: [{"type": "worker", "worker_id": "<WorkerのID>"}]`）のAccessアプリと招待ポリシーを作成します。WorkerのIDは `GET /accounts/{account_id}/workers/scripts` の `tag` です。APIで作る場合は、Accessのアプリとポリシーを編集できるトークンを使います。
7. Accessアプリのaudienceを `ACCESS_AUD` に設定し、`workers_dev` を有効にして再度デプロイします。ログインせずに `/` へアクセスすると、Accessのログイン画面へリダイレクトされることを確かめます。

`GEOMETRY_INSTANCE_TYPE` と `GEOMETRY_IDLE_TIMEOUT_MS` は環境別の設定です。値の根拠は[検証3](docs/verification/verification-03.md)にあります。Workers Logsを有効にしているので、接続用DOの `container.ready`（`mode: cold` の `ms` が起動時間）とContainer内の `geometry.request`（`vmHwmKib` がメモリの最大値）を、Workers Logsの検索APIで読めます。検索には `Workers Observability Write` の権限を持つトークンが要ります。検証3で使った取得と集計のスクリプトは[記録フォルダ](docs/verification/evidence/verification-03/)にあります。

Container接続用DOと内部プロトコルは `apps/worker/src/geometry/` に置き、`services/` から呼びます。将来のパターンごとの調整DOは `objects/` から `services/` を呼ぶ構成です。

内部APIの本文は `crates/geometry-api` で定義し、`pnpm generate:geometry` でJSON Schema・Zod・TypeScript型を再生成します。`pnpm check` も全モードで再生成し、RustとNodeのテストが生成結果の一致を検査します。
