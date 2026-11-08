# 現在地と次の作業

更新日：2026-11-08

## 現在の到達点

計画6.1aの環境整備を完了した。SolidCraftをsubtreeへ移し、サービス用workspace、最小アプリ、開発コマンド、静的解析・依存監査・コミット前検査・CIを用意した。次は6.1bのサービス基盤を実装する。

事前の住宅・ブラウザ・日差しの技術検証は完了扱い。[過去の検証記録](verification/verification-02.md)は限定した例での結果であり、本体の実装済み機能ではない。試作コードと当時の生成物は削除済み。

## 実装した入口

- WebからローカルWorkerのhealth APIを呼び、Rust/Wasmの初期化を確認する開発画面。
- SolidCraftのSessionを初期化するRustサービスとhealth API。
- 移行したengineで箱を生成し、体積とJSON保存・再読込を確認するテスト。
- upstreamの保持内容と自作workspaceの分離を検査するコマンド。

住宅モデル・住宅操作・3Dビューア・ログイン・案件保存・AI・ジョブ管理は未実装。`crates/housing`はモジュールの入口のみ。`packages/contracts`は現在WebとWorkerの接続確認用スキーマを共有し、Rustの住宅型の生成は住宅モデル実装時に追加する。

## 次の作業

[計画6.1b](plan.md#61-サービスの土台)のサービス基盤へ進む。Access認証、D1・R2、案件・パターン、実行権と条件付き確定、WorkerからContainerへの処理依頼を実装する。本番リソース・秘密情報はまだ設定していない。

設計を再開するときは[計画書](plan.md)を読み、作業方法は[README](../README.md)、取り込み方針は[SolidCraftの更新手順](../third_party/solidcraft.md)に従う。過去の検証をもう一度独立した試作として作り直す段階には戻らない。

## 今回確認したこと

macOS arm64、Rust 1.99.1、Node.js 24.22.1、pnpm 11.9.0で確認した。

| 確認                             | 結果                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| upstreamの保持                   | 採用版の6,794ファイルを照合。記録したキャッシュ対応の2ファイル以外は一致                                                                                 |
| subtreeの履歴                    | 通常のsplitが成功し、採用版を祖先として維持。更新コマンドの同一版指定と、サービス側コミットの誤指定を拒否する動作も確認                                  |
| 過去の検証証拠                   | 26ファイルすべて移行前と同じSHA-256。文書のローカルリンクも確認                                                                                          |
| `pnpm install --frozen-lockfile` | 成功                                                                                                                                                     |
| `pnpm check`                     | 整形、型付きESLint、型確認、native/WasmのClippy、未使用コード・依存、CI/Dockerfile、配置、全ビルド、Rustテスト、依存ポリシー、秘密情報、smoke testが成功 |
| engineの動作                     | 10×20×30 mmの箱を生成し、体積6,000 mm³とJSON保存・再読込後の一致を確認                                                                                   |
| サービス用依存                   | Rust workspaceは自作4クレート。Wasmにengine/doc/kernel/eguiを含めず、Rustサービスにegui/winitを含めない                                                  |
| 評価キャッシュ                   | サービスで`external-workspace`を有効にし、識別値`unknown`を確認。`trust-unknown-source`は無効                                                            |
| ローカル接続                     | WorkerとRustのhealth応答、APIの404/405、Webの静的配信、Wasmの配信・初期化を確認                                                                          |
| `pnpm dev`                       | Web・Worker・Rustの一括起動、ViteからのAPIプロキシ、Ctrl-Cによる終了を確認                                                                               |

## 開発環境に追加した検査

開発ツールをmise、共有するTypeScript・Node型・Zodをpnpm catalogで固定した。初期手順は`pnpm setup`、普段の静的検査は`pnpm check:fast`、全体確認は`pnpm check`、ネットワークを使う依存監査は`pnpm check:security`にまとめた。具体的な検査範囲・更新方法は[README](../README.md)にある。

- 型情報を使うESLintとReact Hooks検査、Prettier、Knipを導入した。開発スクリプトもTypeScriptに移し、Node.jsの実行方式に合わせて型確認する。TypeScriptは型付きlintが対応する6.0.3を採用した。
- RustはnativeとWasmのClippy、cargo-machete、cargo-denyを実行する。現在使っていないhousing依存をmodelingから除いた。ioとwgpuの直接依存は機能を有効にするために必要で、未使用検査の例外に理由を記録した。
- JavaScript依存のライセンス検査、Gitleaks、actionlint、hadolint、Lefthook、EditorConfig、VS Code設定を追加した。秘密情報の検査はGit管理対象の現在のファイルとコミット前の差分を対象にし、gitignoreされたローカル認証情報を除く。
- ActionsをコミットSHAで固定し、依存監査の週次実行とDependabotを設定した。依存のpeer整合を必須にし、公開後24時間未満のパッケージの採用とコマンド実行時の自動インストールを防いでいる。

依存監査で開発ツールのminimatchに[既知の脆弱性](https://github.com/advisories/GHSA-g3hv-75wg-m249)が見つかったため、11.0.5への限定した上書きを加えた。利用側の呼び出しと新しい版でのlint動作を確認した。利用側が修正版に対応したら上書きを削除する。

ライセンス確認ではMiniflareのsharpがLGPLのlibvipsを含んでいたため、未使用のローカル画像変換用依存を外した。Cloudflare Imagesバインディング・`cf.image`のローカル実行を追加する場合は再検討が必要。除外後のWorkerの起動・API・静的配信もsmoke testで確認した。最終のJS監査は既知の脆弱性なしで、Rustのadvisories・bans・licenses・sources検査も通過した。

意図的なPromiseの処理漏れ・条件付きReact Hookを一時ファイルへ入れ、ESLintが該当ルールで拒否することを確認した。生成した偽の認証情報も検出され、出力は秘匿された。同じ情報をgitignoreされた一時ファイルに置いた場合は検査を通過した。これらの一時ファイルは削除した。`pnpm setup`、一括起動、APIプロキシ、Ctrl-Cでの終了、ステージした変更へのコミット前フックも確認した。

## 整形・lintの比較検証

[Prettier・Biomeの比較](verification/tooling-comparison.md)を実施した。設定を揃え、実ファイル42件の入力・整形出力が両ツールで一致した状態では、整形チェックが約351msから51msへ短縮した。lintは移行設定の結果だけで判断せず、対応する2ルールだけを明示的に有効にした追加試験を行った。JSONのプロパティ返却やDOMのasyncイベント処理で検出範囲の差が残った。整形だけをBiomeに移し、現在の型付きESLintとReact Hooks検査を維持する構成を推奨する。採用は未決定で、設定・依存はPrettier＋ESLintのまま。自動移行した除外設定の修正方法も記録した。

## 残る実行環境の確認

Wasmの実行確認は生成したバインディングをNode.jsから初期化して行い、HTTPでの配信も確認した。実ブラウザでのGPU描画確認は今回の対象に含まない。Linux用CIは設定済みだが、今回の作業ではGitHub上で実行していない。Docker daemonは停止していたためContainerのビルド・実行は未確認で、6.1bで確認する。

macOSの未最適化Rustビルドでは、リンカーからunwind情報のサイズに関する警告が出た。ビルド・テストは成功している。実配備用のreleaseビルドと資源計測は6.1bで行う。
