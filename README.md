# instant-madori

営業と施主が、会話を通じて間取り・3D・住まいのイメージを具体化するWebサービスを開発しています。

開発環境の整備を完了し、次はサービス基盤を実装します。住宅の生成・表示、ログイン、保存、Cloudflareへの実配備は次の実装段階です。まず[現在地と次の作業](docs/status.md)、次に[実装計画](docs/plan.md)を読んでください。エージェント向けのルールは[AGENTS.md](AGENTS.md)にあります。

## 開発を始める

macOSまたはLinux、Git（`git subtree`を含む）、[mise](https://mise.jdx.dev/getting-started.html)、rustupを使用します。Node.js・pnpm・検査ツールは`mise.toml`、Rust・Clippy・rustfmt・Wasmターゲットは`rust-toolchain.toml`で固定しています。Dockerはコンテナをビルドするときに必要です。

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

`pnpm dev`は次のプロセスを起動し、Ctrl-Cでまとめて終了します。

| URL                           | 内容                                                            |
| ----------------------------- | --------------------------------------------------------------- |
| http://127.0.0.1:5173         | Reactの開発画面。Workerへの接続とWasmの初期化を表示             |
| http://127.0.0.1:8787         | ローカルWorkerとビルド済み静的ファイル。`/api/health`で応答確認 |
| http://127.0.0.1:3001/healthz | ネイティブRustサービス。SolidCraftのSession初期化後に応答       |

現在の画面は開発用の接続確認です。3D描画やWorkerからRustへの形状処理依頼は、まだ実装していません。TypeScriptは開発中に更新されますが、Rust・Wasmを変更したときは再ビルド・再起動してください。

## 日常のコマンド

| コマンド                                                 | 確認・実行するもの                                                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format`                                            | 自作コード・設定・文書をPrettierとrustfmtで整形                                                                                                          |
| `pnpm lint:fix`                                          | ESLintが安全に自動修正できる指摘を反映                                                                                                                   |
| `pnpm check:fast`                                        | 整形、型付きlint、型確認、native/WasmのClippy、未使用コード・依存、CI/Dockerfile、配置を検査。ビルドとテストは省くが、初回のClippyは依存をコンパイルする |
| `pnpm check`                                             | `check:fast`に加え、全ビルド、Rustテスト、JS/Rustの依存ポリシー、秘密情報、ローカル接続のsmoke test                                                      |
| `pnpm check:security`                                    | Git管理対象の現在のファイルの秘密情報と、JS/Rust依存の既知の脆弱性。監査データを取得するためネットワークが必要                                           |
| `pnpm build`                                             | Wasm、Web、Workerのdry-runビルド、ネイティブRust                                                                                                         |
| `pnpm typecheck`                                         | 共通スキーマ、Web、Worker、開発用TypeScriptスクリプト。初回は先に`pnpm setup`を実行                                                                      |
| `pnpm check:rust`                                        | 自作Rust workspaceの整形・native/WasmのClippy・テスト                                                                                                    |
| `pnpm smoke`                                             | ビルド済みのRust・Workerを空きポートで起動して検査し、終了する                                                                                           |
| `pnpm dev:web` / `pnpm dev:worker` / `pnpm dev:geometry` | 各プロセスの個別起動                                                                                                                                     |
| `pnpm build:wasm`                                        | WasmとJS/TSバインディングの再生成                                                                                                                        |
| `pnpm upstream:check`                                    | upstreamの更新を取得して、採用版からの変更を表示                                                                                                         |

本番デプロイ用のコマンドと認証情報はまだ用意していません。Workerの`build`は`--dry-run`で、リモートのリソースを作成しません。

## 検査の担当と範囲

| 対象                              | 検査                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript・React・開発スクリプト | TypeScriptのstrict設定、型情報を使うESLint、React Hooksルール                                                                                                            |
| 整形                              | Prettier、rustfmt、EditorConfig。文章は文字数による自動改行をしない                                                                                                      |
| Rust                              | Clippyで警告をエラーにする。自作コードのunsafe・unwrap・expect・panicなどを禁止                                                                                          |
| 未使用コード・依存                | Knipとcargo-machete                                                                                                                                                      |
| 依存の脆弱性                      | pnpm audit、cargo-deny。JSはlow以上、Rustは脆弱性・yankedを検査し、unmaintainedはworkspaceの直接依存を対象にする                                                         |
| 依存のライセンス・取得元          | pnpmのメタデータでJSのGPL/LGPL/AGPL・不明ライセンスを拒否し、Rustはcargo-denyの許可リストで検査。Rustは実際に使うSolidCraft側の依存も対象                                |
| 秘密情報                          | Gitleaks。`check:secrets`で追跡済み・未追跡のGit管理対象ファイル、コミット時にステージ済みの差分を検査。gitignoreされたローカル認証情報は除く。Gitの全履歴の監査ではない |
| GitHub Actions・Dockerfile        | actionlint、hadolint                                                                                                                                                     |
| upstreamとの境界                  | 採用版とのファイル照合、独自変更の記録、Cargo workspaceと依存先の検査                                                                                                    |

自作コードのlint・一括整形・未使用検査は、`third_party/solidcraft`を対象にしません。生成物も除外し、過去の検証記録・証拠は一括整形しません。依存の脆弱性やライセンスの検査対象はソースの配置で除外せず、サービスのlockfileから決めます。

Lefthookのコミット前検査は、ステージした自作ファイルの整形・lint、Rust変更時のworkspace整形、秘密情報です。ファイルを自動で書き換えません。全体の型確認・ビルド・テストは`pnpm check`とCIが担当します。GitHubではPR・main更新時にサービスCIと依存監査を実行し、依存監査は週次にも実行します。Dependabotはルートのnpm・Cargo・Actionsの更新を提案します。SolidCraft本体はsubtreeの手順で更新します。

VS Code向けの推奨拡張・保存時整形・Rust Analyzer設定を`.vscode/`に用意しています。他のエディタでも同じCLI検査とEditorConfigを使えます。

## 依存とツールを更新する

Node.js・pnpm・CLI検査ツールの版は`mise.toml`、共有するTypeScript・Node型・Zodの版は`pnpm-workspace.yaml`のcatalogで変更します。Node.jsは`.node-version`とも揃えます。TypeScriptは型付きlintの対応範囲に合わせて6.0系を採用しています。

pnpmは厳密なpeer dependency検査と、公開後24時間未満のパッケージを採用しない設定です。インストールスクリプトの実行は必要なパッケージだけ許可します。manifestや設定が変わったら明示的に`pnpm install`を実行し、コマンド実行時の自動インストールはしません。生成されたlockfileを確認してコミットします。

一時的な依存上書きには理由を残します。現在のminimatchの上書きは[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)への対応です。ESLint/typescript-eslint側が修正版を採用したら取り除きます。

Miniflareのsharp依存は、LGPLのlibvipsを含むため除外しています。現在使うWorker・静的配信には不要ですが、Cloudflare Imagesバインディングと`cf.image`のローカル画像変換は使えません。画像添付・R2への保存とは別の機能です。この機能を追加するときはライセンス方針と実行方法を再検討してください。

## 配置と依存関係

| 場所                     | 担当                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `apps/web`               | React・TypeScriptの画面                                                      |
| `apps/worker`            | Cloudflare WorkersのAPI・静的配信                                            |
| `apps/geometry`          | ネイティブRustのHTTP入口、Container用Dockerfile                              |
| `crates/housing`         | 住宅データと整合性。環境整備時点ではモジュールの入口のみ                     |
| `crates/modeling`        | 住宅操作とSolidCraftの接続                                                   |
| `crates/viewer`          | SolidCraftのgeom・render・gpuを使うWasm                                      |
| `packages/contracts`     | WebとWorkerで共有するスキーマ。住宅の通信型はRust実装時に生成を追加          |
| `third_party/solidcraft` | upstream一式。専用のCargo workspaceとして保持                                |
| `docs`                   | サービスの計画、現在地、過去の検証記録                                       |
| `scripts`                | ビルド・起動・検査・upstream更新のTypeScriptスクリプト。Node.js 24で直接実行 |

ルートのCargo.lockとpnpm-lock.yamlがサービスの依存関係を固定します。SolidCraftの未使用アプリは通常のビルド対象に含めません。

## SolidCraftの更新

**upstreamの更新は原則取り込みます。** 住宅サービスへの影響を確認し、問題があれば調整するか、理由を記録して保留します。採用版は[solidcraft.json](third_party/solidcraft.json)、独自変更・更新手順・初回移行の記録は[solidcraft.md](third_party/solidcraft.md)を参照してください。

SolidCraftの元のREADME・資料・ライセンスは取り込み領域に保持しています。[MITライセンス](third_party/solidcraft/LICENSE-MIT)、[Apacheライセンス](third_party/solidcraft/LICENSE-APACHE)、[NOTICE](third_party/solidcraft/NOTICE)、[資産と依存の帰属](third_party/solidcraft/ATTRIBUTION.md)を参照してください。
