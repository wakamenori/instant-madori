# SolidCraftの取り込みと更新

採用するリポジトリ、コミット、初回取り込み版、独自変更の対象ファイルは[solidcraft.json](solidcraft.json)に記録する。コード・資料・資産・ライセンスは`third_party/solidcraft/`に一式を保持する。

## 更新の方針

upstreamの更新は原則取り込む。住宅サービスの機能、データ、モジュール構成、動作環境に逆行する場合は、利用側を調整するか、その更新を保留する理由と再検討条件を記録する。有用な改善を取り込めなくする恒久的な凍結は行わない。

履歴をsquashしないgit subtreeで管理する。ルートに通常の`git merge upstream/main`を実行しない。upstream更新、取り込み領域内の独自修正、自作サービスの変更はコミットを分ける。

## 初回移行の確認（2026-11-08）

移行前のmainとorigin/mainは`9325e3ac8cc1dcad67bc5d218274e89e8a9b26fc`で、upstreamの同一コミットだった。Gitの追跡ファイル6,754件に独自差分はなかった。ユーザーから最初のコミットの変更を注意するよう指示があり、origin・upstreamを取得し直して履歴と作業ツリーを照合したが、今回のmain上には該当する独自コミットは見つからなかった。

未追跡の計画・検証記録・証拠29ファイルを別に保全し、文書は`docs/`へ、証拠は`docs/verification/evidence/`へ移した。過去の検証結果を新しい採用版での結果として書き換えていない。

最初に公式の`git subtree add --prefix=third_party/solidcraft <初回コミット>`で取り込み、取り込み先のGitツリーが元のツリーと一致することを確認した。その後、`ae1d85e5d4e32183258b3d301fb26b8687f4b969`までの115コミットを`git subtree merge`で取り込み、再びツリーの一致を確認した。元からの履歴は保持している。

移行元と取り込み元が同じコミットだと、初回の`git-subtree-mainline`と`git-subtree-split`が同一になり、後の`git subtree split`が失敗した。そのため、移行開始を示す空コミットを挟む形に今回の未公開コミットだけを組み直し、両者を区別した。組み直し前後で作業ツリーの一致を確認した。通常の`git subtree split --prefix=third_party/solidcraft`が成功し、切り出した履歴が採用済みupstreamを祖先に持つこと、差分が記録した2ファイルだけであることも確認済み。

## 採用版とサービスで使う構成

採用版は、2026-11-19のupstream main`7c0f565e915faf6235d95d8cbdc74f8efed07451`である。前の採用版`ae1d85e5d`から5,213コミットを、更新手順どおり`git subtree merge`で取り込んだ。競合は`crates/io/Cargo.toml`の`[features]`の1か所だけで、独自変更の`external-workspace`とupstreamの`dxf-legacy-baseline-tests`を両方残して解消した。マージしたツリーとupstreamとの差分は、記録した独自変更の2ファイルだけである。

この版から、upstreamは形状のカーネルsolidcoreを`solidcore/`に同梱し、gitの依存として取得しない。描画は、カメラとシーンを持つ`crates/viewport`と、wgpuで描く`crates/viewport-gpu`に分かれた。サービスのビューアは、geom・viewport・viewport-gpuに直接依存する。geomがsolidcoreに依存するため、ビューアのCargoの依存グラフにはsolidcoreが入る。利用者に届くWasmにsolidcoreのコードが無いことは、`pnpm check --full`の「Viewer Wasm contents」の段が確かめる。

### pluginを使わない

ルートの`Cargo.toml`は、`solidcraft-engine`の既定のfeatureを外す。既定の`plugins`は、craft-plugin-wasmとwasmtimeを依存に加える。サービスはpluginを実行しない。外すと、Containerの依存（x86_64 Linux）は416から357パッケージに減り、Cのコードをコンパイルする`cc`が依存から無くなる。modelingとgeometryのテストは、外したままで通る。`scripts/check/boundaries.ts`の`geometry-plugin-runtime`の行は、Containerの依存にwasmtimeかcraft-plugin-wasmが入ると失敗にする。pluginを使う機能を加えるときは、この行と計画4.2を一緒に変える。

### 依存監査で無視する勧告

`deny.toml`は、RUSTSEC-2023-0071（rsa）とRUSTSEC-2026-0387（crypto-bigint）を無視する。どちらもpgpからだけ来る。pgpは、`solidcraft-io`が公開鍵で署名を検証するために使う。2つの勧告は、秘密鍵の操作に関するものである。`[bans]`の`wrappers`は、pgpを`solidcraft-io`からだけ、rsaをpgpからだけ、crypto-bigintをpgpの楕円曲線のcrate（cx448とelliptic-curve）からだけ使えるように、経路を固定する。

`pnpm check --full`は、cargo denyに`-D advisory-not-detected -D unused-wrapper`を付けて実行する。upstreamが依存を直して勧告が当たらなくなると、残った無視の指定と、使われなくなった`wrappers`の指定で検査が失敗する。そのときに、その指定を`deny.toml`から外す。

### Containerのビルドに必要なメモリ

Docker DesktopのVMには、12 GBのメモリを割り当てる。Dockerの中でのsolidcoreのreleaseビルドは、一つのrustcで最大3.99 GBを使った。8.32 GBのVMでは、このビルドがSIGKILLで止まった。12 GBのVMでは、ビルドの並列数を`.cargo/config.toml`の`jobs = 4`のままにして、Containerのイメージのビルドが526 sで通った。そのうちcargoのreleaseビルドは8分29秒だった。

## 独自変更

`crates/io`に`external-workspace`機能を加えた。サービスは、ルートの`Cargo.toml`の依存指定でこの機能を有効にする。有効にすると、`crates/io/build.rs`の`git()`が常に`None`を返し、build.rsはgitを読まない。評価キャッシュの識別値`SOLIDCRAFT_EVALUATION_SOURCE`と、記録用のコミット`SOLIDCRAFT_SOURCE_COMMIT`は、どちらも`unknown`になる。build.rsは`<git-dir>/logs/HEAD`の変更では再実行されない。この機能を有効にしない、upstreamを単独でビルドするときの動作は変えない。`scripts/check/boundaries.ts`の`geometry-cache-trust`の行が、madori-geometryの依存でこの機能が有効であることを検査する。

評価キャッシュを信頼しない理由。upstreamのbuild.rsは、自身のCargo.lock・設定から識別値を作る。一方、サービスのビルドは、親workspaceのCargo.lock・プロファイルで依存を解決する。識別値が同じでも、実際のビルドが異なる可能性がある。`trust-unknown-source`機能はサービスで有効にしない。

コミットを読まない理由。`third_party/solidcraft`はsubtreeなので、このリポジトリのHEADはSolidCraftのソースを表さない。upstreamのbuild.rsは、HEADが動くたびに再実行してコミットを埋め直す。そのままでは、コミット・checkout・resetのたびに、solidcraft-io・solidcraft-engine・madori-modeling・madori-geometryを作り直す。空のコミットの後の`cargo build -p madori-geometry --tests`は、負荷のあるこのマシンで2〜3分かかっていた。サービスはこの値を読まない。読むのは、サービスが使わない`crates/mcp`と、サービスが書かないモデルキャッシュ・取り込みキャッシュの記録だけである。本番のContainerは`.git`を含めずにビルドするので、もとから`unknown`だった。

gitの読み取りを`git()`の一か所で止めるので、upstreamが`git()`から作る値や再実行の条件を足しても、マージしただけで同じ扱いになる。`git()`を通らずにgitを読むコードが入ると、この扱いから漏れる。upstreamの更新で`crates/io/build.rs`が変わったら、空のコミットの後に`cargo build -p madori-geometry --tests -v`を実行し、`solidcraft-io`が`Fresh`のままであることを確かめる。

この変更はupstreamに提案しない。upstreamのリポジトリではHEADがSolidCraftのコミットで、コミットごとに埋め直すのは意図した動作である。この変更は独自の`external-workspace`機能の上にあるので、提案するには、親workspaceの中でビルドする使い方そのものを提案する必要がある。upstreamがcrateを他のworkspaceの依存として扱うようになったら、提案するかを決め直す。upstreamが同じ目的の仕組みを持ったら、その更新を取り込むときにこの独自変更を外す。

将来キャッシュを利用する場合は、実際のサービス側の依存解決・ビルド条件・形状評価コードを識別できる方式を実装し、異なるビルドのキャッシュを誤採用しないことを確認してから有効にする。

## 更新手順

1. 現在の作業をコミットし、更新用のブランチを作る。
2. `pnpm upstream:check`で最新のmainと差分を取得する。表示されたコミットを対象に、利用クレート・Cargo設定・保存形式・描画・資産参照への影響を確認する。
3. `pnpm upstream:update <確認した40桁のSHA>`で取り込む。これはsubtreeのマージコミットを作る。競合したら独自変更の目的を保って解消し、マージを完了させる。
4. `solidcraft.json`の採用コミットと独自変更ファイル一覧を確認する。自動マージが競合で止まった場合、採用コミットの更新は手動で行う。
5. 依存関係が変わったらルートのCargo.lockを更新する。upstreamの`[patch]`・プロファイルも確認する。今のupstreamの`[patch.crates-io]`は、egui一式（`vendor/egui`）とwinitを差し替える。どちらもサービスの依存経路に入らないため、親には設定していない。
6. `pnpm check --full`を実行する。住宅機能の実装後は、計画5.5の保存・再編集・見た目・ジョブ復帰の確認も実施する。通過した結果、採用コミット、必要な調整を記録してコミットする。

問題が出た場合は、無関係な作業を巻き戻さず、更新用ブランチで修正・保留を判断する。公開ブランチの履歴を書き換えない。

`pnpm check`の全モードに含む配置検査は、採用版の全ファイルと取り込み領域を照合する。記録した独自変更以外の欠落・書換えや、upstreamアプリの自作workspaceへの混入を検出する。

参照：[Git subtree](https://raw.githubusercontent.com/git/git/master/contrib/subtree/git-subtree.adoc)、[Cargo workspace](https://doc.rust-lang.org/cargo/reference/workspaces.html)。
