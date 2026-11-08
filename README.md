# instant-madori

営業と施主が、会話を通じて間取り・3D・住まいのイメージを具体化するWebサービスを開発しています。

開発環境の整備を完了し、次はサービス基盤を実装します。住宅の生成・表示、ログイン、保存、Cloudflareへの実配備は次の実装段階です。まず[現在地と次の作業](docs/status.md)、次に[実装計画](docs/plan.md)を読んでください。エージェント向けのルールは[AGENTS.md](AGENTS.md)にあります。

## 開発を始める

macOSまたはLinux、Git（`git subtree`を含む）、Node.js 24、pnpm 11.9.0、rustupを使用します。Nodeの版は`.node-version`、RustとWasmターゲットは`rust-toolchain.toml`で固定しています。Dockerはコンテナをビルドするときに必要です。

リポジトリのルートで実行します。ローカル起動にCloudflareアカウントやAIキーは不要です。

```sh
pnpm install --frozen-lockfile
pnpm setup:wasm
pnpm check
pnpm dev
```

初回はRust・Wasmと依存ライブラリをビルドします。`pnpm setup:wasm`は、ライブラリと同じ版のwasm-bindgen CLIを、このリポジトリの`.tools/`へインストールします。

`pnpm dev`は次のプロセスを起動し、Ctrl-Cでまとめて終了します。

| URL | 内容 |
| --- | --- |
| http://127.0.0.1:5173 | Reactの開発画面。Workerへの接続とWasmの初期化を表示 |
| http://127.0.0.1:8787 | ローカルWorkerとビルド済み静的ファイル。`/api/health`で応答確認 |
| http://127.0.0.1:3001/healthz | ネイティブRustサービス。SolidCraftのSession初期化後に応答 |

現在の画面は開発用の接続確認です。3D描画やWorkerからRustへの形状処理依頼は、まだ実装していません。TypeScriptは開発中に更新されますが、Rust・Wasmを変更したときは再ビルド・再起動してください。

## コマンド

| コマンド | 確認・実行するもの |
| --- | --- |
| `pnpm check` | 配置とupstream差分、全ビルド、型確認、Rustの整形・Clippy・テスト、ローカル接続のsmoke test |
| `pnpm build` | Wasm、Web、Workerのdry-runビルド、ネイティブRust |
| `pnpm typecheck` | 共通スキーマ、Web、Worker。初回は先に`pnpm build:wasm`を実行 |
| `pnpm check:rust` | 自作Rust workspaceの整形・Clippy・テスト |
| `pnpm smoke` | ビルド済みのRust・Workerを空きポートで起動して検査し、終了する |
| `pnpm dev:web` / `pnpm dev:worker` / `pnpm dev:geometry` | 各プロセスの個別起動 |
| `pnpm build:wasm` | WasmとJS/TSバインディングの再生成 |
| `pnpm upstream:check` | upstreamの更新を取得して、採用版からの変更を表示 |

本番デプロイ用のコマンドと認証情報はまだ用意していません。Workerの`build`は`--dry-run`で、リモートのリソースを作成しません。

## 配置と依存関係

| 場所 | 担当 |
| --- | --- |
| `apps/web` | React・TypeScriptの画面 |
| `apps/worker` | Cloudflare WorkersのAPI・静的配信 |
| `apps/geometry` | ネイティブRustのHTTP入口、Container用Dockerfile |
| `crates/housing` | 住宅データと整合性。環境整備時点ではモジュールの入口のみ |
| `crates/modeling` | 住宅操作とSolidCraftの接続 |
| `crates/viewer` | SolidCraftのgeom・render・gpuを使うWasm |
| `packages/contracts` | WebとWorkerで共有するスキーマ。住宅の通信型はRust実装時に生成を追加 |
| `third_party/solidcraft` | upstream一式。専用のCargo workspaceとして保持 |
| `docs` | サービスの計画、現在地、過去の検証記録 |
| `scripts` | ビルド・起動・検査・upstream更新の入口 |

ルートのCargo.lockとpnpm-lock.yamlがサービスの依存関係を固定します。SolidCraftの未使用アプリは通常のビルド対象に含めません。

## SolidCraftの更新

**upstreamの更新は原則取り込みます。** 住宅サービスへの影響を確認し、問題があれば調整するか、理由を記録して保留します。採用版は[solidcraft.json](third_party/solidcraft.json)、独自変更・更新手順・初回移行の記録は[solidcraft.md](third_party/solidcraft.md)を参照してください。

SolidCraftの元のREADME・資料・ライセンスは取り込み領域に保持しています。[MITライセンス](third_party/solidcraft/LICENSE-MIT)、[Apacheライセンス](third_party/solidcraft/LICENSE-APACHE)、[NOTICE](third_party/solidcraft/NOTICE)、[資産と依存の帰属](third_party/solidcraft/ATTRIBUTION.md)を参照してください。
