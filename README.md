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

`pnpm dev`は、ローカルのD1へマイグレーションを適用してから次のプロセスを起動し、Ctrl-Cでまとめて終了します。Wrangler 4.158の終了処理は形状イメージに属するContainerを削除しますが、別イメージの通信プロキシが残るため、Wrangler起動前に全ContainerのIDと、このWorker名・宣言したContainerクラスの名前のパターンを保存します。終了後は保存したパターンに一致し、開始時に存在しなかったIDのContainerとプロキシを削除します。途中で設定を変更しても対象パターンを広げず、開始時に存在したIDは削除しません。終了処理の失敗は報告し、起動・実行結果と終了コードを維持します。実Containerテストも同じ終了処理を使います。

このWorkerのローカルセッション（`pnpm dev`、`pnpm check --full`、別worktreeでの実行を含む）の同時起動はサポートしません。MiniflareはWorker名とContainerクラス名から同じ名前を作るため、終了処理に関係なく衝突し、重複して起動すると他セッションの新しいContainerを終了処理で削除することもあります。クラッシュ後に残ったContainerは次回起動時のIDとして保存されるため、自動削除しません。残りを削除する場合は、このWorkerの全ローカルセッションを停止してから `docker ps -a --no-trunc --format '{{.ID}} {{.Names}}'` で一覧を確認し、このWorker・Containerクラスに属する残りのIDを選んで `docker rm --force <ID>...` を実行します。

| URL                   | 内容                                                            |
| --------------------- | --------------------------------------------------------------- |
| http://127.0.0.1:5173 | Reactの開発画面。サンプルをWebGPUで描画する                     |
| http://127.0.0.1:8787 | ローカルWorkerとビルド済み静的ファイル。`/api/health`で応答確認 |

サンプルは床と3枚の壁、奥壁の開口で構成します。画面はドラッグでの回転と、スクロールでの拡大・縮小に対応します。ブラウザで確かめた範囲は、[実装計画](docs/plan.md)の6.1bにあります。Worker → Durable Object → Containerを通してSolidCraftで生成し、Wasmビューアへ表示データを渡します。WebGPUを利用できるブラウザが必要です。初回のamd64イメージのビルドには数分かかります。

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

TypeScriptのテストはNode.js標準のtest runnerを使います。HTTP経由のWorker APIテストは、テストファイルごとに一時的なD1へ実際のマイグレーションを適用し、`wrangler dev` でworkerd上のWorkerを起動して、HTTPで検査します。署名にはテスト用の鍵を使い、Cloudflareのアカウントは不要です。`apps/*/{src,tests}/**/*.test.ts`、`packages/*/{src,tests}/**/*.test.ts`、`scripts/**/*.test.ts` が対象です。現在は、WorkerのAPI（認証、所有権、冪等性、版の競合、ページング、サンプル取得、案の確定・読取とR2の内容の照合）、Containerの起動・引継ぎ・障害復帰、内部プロトコル、WebのAPIエラーとビューアの初期化・解放、操作量、アクセシビリティの静的マークアップ、スキーマ・生成契約・環境別バインディングを確認するテストがあります。Rustでは表示形式の固定フィクスチャ・破損入力・大量入力、配置済み形状の書出し、内部API認証、シーン変換とカメラを検査します。Node.jsの型だけを使うテストには専用のtsconfigを用意し、Worker本体の実行環境の型から分けています。RPCとサービスの単体テストはWorkerの型も必要なため、Node用のテストからtsconfigを分けています。これらの単体テスト自体はNodeで動き、workerdやContainerを起動しません。例外として、`tests/rpc/revision-fixture.ts` は単体テストではなく、案の保存のHTTPテストから子プロセスとして起動され、`getPlatformProxy` 経由のworkerdでローカルのD1・R2に対してサービスを実行します。静的マークアップとDOM/GPUの代替オブジェクトによる検査は、ブラウザでの実描画を確かめるものではありません。

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

GitHub Actionsを実行・合否判定の前提にしません。サービス用workflowを削除し、ローカルの `check` に検査を集約しています。Dependabotはnpm・Cargoの更新提案用に残し、upstream本体はsubtreeの手順で更新します。

VS Code向けの推奨拡張・保存時整形・ESLint自動修正・Rust Analyzer設定を `.vscode/` に用意しています。他のエディタやエージェントによる直接編集でも、同じ `pnpm check` を使えます。

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

この手順はCloudflareリソースの作成とデプロイを伴います。ローカルの検査では実行しません。現在のstagingは `https://instant-madori-staging.firpmnfiywl.workers.dev` です。

1. Workers Paidのアカウントで、staging用D1を `wrangler d1 create instant-madori-staging` で、R2バケットを `wrangler r2 bucket create instant-madori-staging` で作成します。Containersを使うにはWorkers Paidが必要です。
2. `apps/worker/wrangler.jsonc` の `env.staging` に、D1のID、画面のOrigin（workers.devのホスト名）、Accessのチームドメインを設定します。この時点では `workers_dev` を無効にしておきます。Accessで守る前に公開すると、静的ファイルはWorkerの認証を通らずに配信されるためです。`preview_urls` は常に無効にします。初期値の `.invalid` 発行元は認証設定の検査で拒否します。
3. `pnpm check --full` を実行します。
4. `pnpm --filter @madori/worker exec wrangler d1 migrations apply DB --remote --env staging` でマイグレーションを適用します。
5. `workers_dev` を無効にしたまま `pnpm --filter @madori/worker exec wrangler deploy --env staging` でデプロイし、公開前にWorkerを作ります。
6. Worker宛先（`destinations: [{"type": "worker", "worker_id": "<WorkerのID>"}]`）のAccessアプリと招待ポリシーを作成します。WorkerのIDは `GET /accounts/{account_id}/workers/scripts` の `tag` です。APIで作る場合は、Accessのアプリとポリシーを編集できるトークンを使います。
7. Accessアプリのaudienceを `ACCESS_AUD` に設定し、`workers_dev` を有効にして再度デプロイします。ログインせずに `/` へアクセスすると、Accessのログイン画面へリダイレクトされることを確かめます。

`GEOMETRY_INSTANCE_TYPE` と `GEOMETRY_IDLE_TIMEOUT_MS` は環境別の設定です。値の根拠は[検証3](docs/verification/verification-03.md)にあります。Workers Logsを有効にしているので、接続用DOの `container.ready`（`mode: cold` の `ms` が起動時間）とContainer内の `geometry.request`（`vmHwmKib` がメモリの最大値）を、Workers Logsの検索APIで読めます。検索には `Workers Observability Write` の権限を持つトークンが要ります。検証3で使った取得と集計のスクリプトは[記録フォルダ](docs/verification/evidence/verification-03/)にあります。

Container接続用DOと内部プロトコルは `apps/worker/src/geometry/` に置き、`services/` から呼びます。将来の案ごとの調整DOは `objects/` から `services/` を呼ぶ構成です。

内部APIの本文は `crates/geometry-api` で定義し、`pnpm generate:geometry` でJSON Schema・Zod・TypeScript型を再生成します。`pnpm check` も全モードで再生成し、RustとNodeのテストが生成結果の一致を検査します。
