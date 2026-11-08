# SolidCraftの取り込みと更新

採用するリポジトリ、コミット、初回取り込み版、独自変更の対象ファイルは[solidcraft.json](solidcraft.json)に記録する。コード・資料・資産・ライセンスは`third_party/solidcraft/`に一式を保持する。

## 更新の方針

upstreamの更新は原則取り込む。住宅サービスの機能、データ、モジュール構成、動作環境に逆行する場合は、利用側を調整するか、その更新を保留する理由と再検討条件を記録する。有用な改善を取り込めなくする恒久的な凍結は行わない。

履歴をsquashしないgit subtreeで管理する。ルートに通常の`git merge upstream/main`を実行しない。upstream更新、取り込み領域内の独自修正、自作サービスの変更はコミットを分ける。

## 初回移行の確認（2026-11-08）

移行前のmainとorigin/mainは`9325e3ac8cc1dcad67bc5d218274e89e8a9b26fc`で、upstreamの同一コミットだった。Gitの追跡ファイル6,754件に独自差分はなかった。ユーザーから最初のコミットの変更を注意するよう指示があり、origin・upstreamを取得し直して履歴と作業ツリーを照合したが、今回のmain上には該当する独自コミットは見つからなかった。

未追跡の計画・検証記録・証拠29ファイルを別に保全し、文書は`docs/`へ、証拠は`docs/verification/evidence/`へ移した。過去の検証結果を新しい採用版での結果として書き換えていない。

最初に公式の`git subtree add --prefix=third_party/solidcraft <初回コミット>`で取り込み、取り込み先のGitツリーが元のツリーと一致することを確認した。その後、`ae1d85e5d4e32183258b3d301fb26b8687f4b969`までの115コミットを`git subtree merge`で取り込み、再びツリーの一致を確認した。元からの履歴は保持している。

## 独自変更

コミット`966920097`で、`crates/io`に`external-workspace`機能を追加した。サービス側の依存指定で有効にすると、upstreamの評価キャッシュの識別値を`unknown`とし、そのキャッシュを信頼しない。

理由は、upstreamのbuild.rsが自身のCargo.lock・設定から識別値を作る一方、サービスのビルドでは親workspaceのCargo.lock・プロファイルで依存を解決するため。識別値が同じでも実際のビルドが異なる可能性がある。upstreamを単独でビルドするときの既定動作は変えない。`trust-unknown-source`機能はサービスで有効にしない。

将来キャッシュを利用する場合は、実際のサービス側の依存解決・ビルド条件・形状評価コードを識別できる方式を実装し、異なるビルドのキャッシュを誤採用しないことを確認してから有効にする。

## 更新手順

1. 現在の作業をコミットし、更新用のブランチを作る。
2. `pnpm upstream:check`で最新のmainと差分を取得する。表示されたコミットを対象に、利用クレート・Cargo設定・保存形式・描画・資産参照への影響を確認する。
3. `pnpm upstream:update <確認した40桁のSHA>`で取り込む。これはsubtreeのマージコミットを作る。競合したら独自変更の目的を保って解消し、マージを完了させる。
4. `solidcraft.json`の採用コミットと独自変更ファイル一覧を確認する。自動マージが競合で止まった場合、採用コミットの更新は手動で行う。
5. 依存関係が変わったらルートのCargo.lockを更新する。upstreamの`[patch]`・プロファイルも確認する。現在のegui-wgpu・winitパッチはサービスの依存経路に入らないため、親には設定していない。
6. `pnpm check`を実行する。住宅機能の実装後は、計画5.5の保存・再編集・見た目・ジョブ復帰の確認も実施する。通過した結果、採用コミット、必要な調整を記録してコミットする。

問題が出た場合は、無関係な作業を巻き戻さず、更新用ブランチで修正・保留を判断する。公開ブランチの履歴を書き換えない。

`pnpm check:layout`は採用版の全ファイルと取り込み領域を照合する。記録した独自変更以外の欠落・書換えや、upstreamアプリの自作workspaceへの混入を検出する。

参照：[Git subtree](https://raw.githubusercontent.com/git/git/master/contrib/subtree/git-subtree.adoc)、[Cargo workspace](https://doc.rust-lang.org/cargo/reference/workspaces.html)。
