# 現在地と次の作業

更新日：2026-11-08

## 現在の到達点

計画6.1aの環境整備を完了した。SolidCraftをsubtreeへ移し、サービス用workspace、最小アプリ、開発コマンド、CIを用意した。次は6.1bのサービス基盤を実装する。

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

| 確認 | 結果 |
| --- | --- |
| upstreamの保持 | 採用版の6,794ファイルを照合。記録したキャッシュ対応の2ファイル以外は一致 |
| 過去の検証証拠 | 26ファイルすべて移行前と同じSHA-256。文書のローカルリンクも確認 |
| `pnpm install --frozen-lockfile` | 成功 |
| `pnpm check` | Rust・Wasm・Web・Workerビルド、型確認、Rust整形・Clippy・テスト、smoke testが成功 |
| engineの動作 | 10×20×30 mmの箱を生成し、体積6,000 mm³とJSON保存・再読込後の一致を確認 |
| サービス用依存 | Rust workspaceは自作4クレート。Wasmにengine/doc/kernel/eguiを含めず、Rustサービスにegui/winitを含めない |
| 評価キャッシュ | サービスで`external-workspace`を有効にし、識別値`unknown`を確認。`trust-unknown-source`は無効 |
| ローカル接続 | WorkerとRustのhealth応答、APIの404/405、Webの静的配信、Wasmの配信・初期化を確認 |
| `pnpm dev` | Web・Worker・Rustの一括起動、ViteからのAPIプロキシ、Ctrl-Cによる終了を確認 |

Wasmの実行確認は生成したバインディングをNode.jsから初期化して行い、HTTPでの配信も確認した。実ブラウザでのGPU描画確認は今回の対象に含まない。Linux用CIは設定済みだが、今回の作業ではGitHub上で実行していない。Docker daemonは停止していたためContainerのビルド・実行は未確認で、6.1bで確認する。

macOSの未最適化Rustビルドでは、リンカーからunwind情報のサイズに関する警告が出た。ビルド・テストは成功している。実配備用のreleaseビルドと資源計測は6.1bで行う。
