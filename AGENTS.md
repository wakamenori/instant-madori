# instant-madori：エージェント向けの指示

このリポジトリでは、SolidCraftを使って、ブラウザで動く住宅相談サービスを開発する。最初に[README.md](README.md)と[実装計画](docs/plan.md)を読む。振る舞いを変える前に、計画の該当する節を読む。

## 進め方

作業の進め方、設計、レビュー、コミットとPRの書き方は、pstackの poteto-mode に従う。poteto-mode は Skill ツールでは起動できないので、タスクの最初に、Claude Code が入れた pstack プラグインの `skills/poteto-mode/SKILL.md` を読んで従う。その探し方は [madori-owner](.claude/skills/madori-owner/SKILL.md) の冒頭にある。モデルの割り当ては、[.claude/rules/pstack-models.md](.claude/rules/pstack-models.md) に従う。計画のmilestoneとIssueを進めるときは、指揮役は `/madori-coordinator`、Issueの担当は `/madori-owner` を使う。アプリの振る舞いは `/verify-madori` で確かめる。このファイルには、このリポジトリ固有の構成・検査・安全の決まりだけを書く。

- ユーザーの作業を失わない。リポジトリを変更する前にGitの作業状態と履歴を確認し、関係のない変更を巻き戻さない。
- プロダクトの文書と議論は日本語でよい。コードの識別子とコメントは英語で書く。
- コミット、push、マージ、デプロイ、Cloudflareリソースの作成は許可なしで行ってよい。招待した利用者が使い始めたら、本番のデプロイの扱いを決め直す。

## 構成と境界

- `apps/web` と `apps/worker` はTypeScript、`apps/geometry` と `crates/*` はRustで書く。`packages/contracts` には、WebとAPIが共有するスキーマと、Rustの内部API契約から生成したTypeScript定義を置く。
- `metrics/` には、Software Factoryの計測（取り込み、変換、viewer）をTypeScriptで置く。サービスのコードとは互いにimportせず、`scripts/` もimportしない。設計は [metrics/README.md](metrics/README.md) にある。
- `crates/display` は依存を持たず、表示データの不変条件と版付きバイナリ形式を受け持つ。内部APIは `crates/geometry-api` を編集し、`packages/contracts/src/generated/` の内部API定数・JSON Schema・Zodと型はそこから `pnpm generate:geometry` で生成し、生成ファイルを手で編集しない。内部APIの各ボディはルートの要求・応答スロットから方向を導出する。要求はDeserialize契約で生成し、未知フィールド拒否を生成時に検査する。応答はSerialize契約で生成し、未知フィールド拒否をスキーマから再帰的に除いて追加フィールドを許容する。エラー本文のスキーマ・メディア型・上限は、全ルートが使うプロトコル共通の定数として定義する。
- `crates/housing` は、HTTP、ブラウザ、Cloudflare、CADのいずれにも依存しない。`crates/modeling` は住宅データをSolidCraftにつなぐ。`crates/viewer` はSolidCraftの描画の層だけを使う。
- 層・アプリ・クレートの間で依存してよい向きは、`scripts/check/boundaries.ts` の表で検査する。境界の規則を加える・変えるときは、計画の該当する規則とそれを検査する表の行を一緒に変更し、違反と許可の例をテストに加える。検査を通すことだけを目的に表の行を緩めない。
- `third_party/solidcraft` には、upstreamのソース、資産、ライセンス、エージェント向けの指示をそのまま保持する。このコードを修正するときは、upstreamの技術上の制約に従う。一方、upstreamの「すべてRustで書く」「製品名の扱い」「文書は英語」「UI」に関するルールは、その外側にあるこのサービスには適用しない。upstreamへ貢献するための手順（着手の宣言、ドラフトPR、upstreamのCI一式）は、upstreamに貢献するときのものである。このリポジトリ内で組み込みのために行う修正では、その修正に関係する検査と、このファイルに書いたサービスの検査を使う。`third_party/solidcraft/.agents/skills` の開発用skill（`.claude/skills` はそこへのリンク）も、upstreamへ貢献するためのものなので、このリポジトリでは使わない。Claude Codeは、`third_party/solidcraft/` のファイルを読むと、これらのskillを使える状態にする。
- 使っていないupstreamの構成要素を削除しない。更新は[third_party/solidcraft.md](third_party/solidcraft.md)の手順どおりgit subtreeで行い、upstreamをリポジトリのルートへマージしない。
- upstreamの更新は原則として取り込む。このサービスと両立するかを確認し、両立しない場合は、サービス側を合わせるか、その更新を保留する理由を具体的に記録する。upstreamの変更とサービスの変更は分けておく。
- 第三者の著作権表示とライセンスを保持する。GPL、LGPL、AGPLの依存を追加しない。他の製品のコードや資産を写さない。
- ローカルの検査とテストに、本番の認証情報を持ち込まない。秘密の値を表示しない。

- 補助スクリプトは、目的に合う `scripts/check/`・`scripts/dev/`・`scripts/generate/`・`scripts/build/`・`scripts/upstream/`・`scripts/deploy/`・`scripts/measure/` に置く。複数の目的から使う部品だけを `scripts/shared/` に置き、テストは対象のファイルと同じフォルダーに置く。当てはまる目的がなければ、目的を表す名前のフォルダーを許可なしで足してよく、足したらこの一覧に加える。一度限りの検証スクリプトは `scripts/` に置かない。

## 検査と引き継ぎ

- miseで固定したツールと、READMEに書いたコマンドを使う。`pnpm check --fast` は、TypeScriptとRustを自動修正したうえで検査する。`pnpm check` は、それに加えて両方のテストを実行する。`pnpm check --docs` は、Markdownだけを変えたときの検査で、PRのrunnerはそのような変更にこのモードを選ぶ。Markdownの中身かファイル名を読む静的検査を足すときは、`scripts/check/check.ts` の `documentChecks` に置き、`--docs` でも動かす。手元の通常・軽い検査では、Rustの入力に変更がないとRustのコンパイルを省く。`--rust` でそのモードのRust検査をすべて実行できる。`pnpm check --full` は、ビルド、ローカルでの統合検査、依存関係の監査まで行う。コミットの前に、変更に関係する検査を手元で実行する。PRの検査と、マージの前に確かめることは、README「PRの検査（self-hosted runner）」にある。実行していない検査を、実行したと書かない。
- Dockerを起動した `pnpm check --full` が要るパスは、`scripts/check/ci-mode.ts` の表が決める。PRのrunnerも、同じ表で `--full` を選ぶ。変更したパスが表に当たれば、コミットの前に手元で `--full` を実行し、実Containerとの接続まで検査する。表は理由ごとに分けてある。形状のContainerと表示データの形式、実Containerで動かすジョブの実行（`apps/worker/src/workflows/` など）、releaseのWasmとupstream、Webのビルド、依存関係とツールの版の固定、CIの定義と `--full` だけが実行するスクリプトである。このファイルにパスの一覧を写さない。`scripts/check/check.ts` の `--full` に段階を足すときは、その段階だけが読む設定ファイルも表に足す。`--full` がnodeで実行するスクリプトと、それが相対パスでimportするファイルが表から漏れると、`scripts/check/ci-mode.ts` のテストが落ちる。
- `pnpm check --full` のDockerの段階と `pnpm dev` は、マシン全体で共有するDockerの枠（開発用に二つ、runner用に一つ）を取ってから動き、枠が埋まっていれば、枠を持つプロセスを `[docker-slot]` の行に示して待つ。枠はmacOSでだけ働き、Linuxでは枠を取らずに実行する。待つのは正常な動作なので、止めずに待つ。そのほかのDockerの重い作業（実Containerの試験を直接動かす、形状サービスのイメージをキャッシュなしでビルドするなど）は、`node scripts/shared/docker-slots.ts run -- <コマンド>` で実行する。`pnpm dev` は使い終わったら止める。枠を持つプロセスは、`kill -9` ではなく、Ctrl-Cか `kill` で止める。`kill -9` は子プロセスのDockerの作業を残したまま枠を空ける。
- 形状サービスのイメージを、`--no-cache` や `--no-cache-filter` を付けただけのコマンドでビルドしない。全worktreeとrunnerが共有するCargoのcache mountが空のものに置き換わり、ほかの全員の次のビルドが冷えた状態から始まって、実Containerの試験の起動待ちの期限（800秒）を超えうる。キャッシュなしのビルドは、README「開発を始める」にある一行のコマンドで、名前空間 `madori-nocache` のcache mountを使って行い、続けてその記録を消す。ビルドが途中で止まり、最後に `Total:` の行が出ていなければ、記録を消す後半だけを実行する。
- TypeScriptのアプリとスクリプトには、型情報を使うESLintと厳格な型検査を適用し続ける。信頼できないJSONは、外から受け取る箇所でパースして検証する。依存関係のカタログとツールのバージョン固定を、互いに食い違わない状態に保つ。ロックファイルの変更は内容を確認する。
- `pnpm check` は、`--docs` 以外のどのモードでもサービスのファイルを整形し、ESLintの自動修正を適用する。`--docs` はMarkdownだけを整形する。Rustをビルドする場合はClippyの自動修正も適用する。ステージする前に、その結果の差分を確認する。upstreamのソース、過去の検証記録、生成されたファイルを一括で整形しない。コミット前のフックは、ステージされたファイルを書き換えずに検査するだけで、プロジェクト全体の検査の代わりにはならない。
- テスト以外の新しいRustコードでは、`unsafe`、`unwrap`、`expect`、およびパニックに頼るエラー処理を使わない。外部からの入力は、受け取る箇所で検証する。
- 生成したWasmとビルドのキャッシュは、Gitの追跡対象にしない。
- 試験の失敗を判断する前に、`node scripts/check/test-history.ts` で失敗率を確認する。不安定と分かった試験は不具合のIssueにする。自動の再実行も手動の `gh run rerun <run> --failed` も、不安定なのか常に失敗するのかを見分けるためだけに使う。合格させるために再実行しない。試験を一時的に外すときは、外した箇所からそのIssueにリンクする。
- 要件または構成が変わったときは、`docs/plan.md` を更新する。plan.mdは変更履歴ではなく、その時点の計画として書く。plan.mdには仕様と設計だけを書き、進み具合、作業の一覧、完了の記録は書かない。今回の変更に含めない作業は、該当するmilestoneのIssueにする。PRは、対応するIssueを本文の `Closes #<番号>` で閉じる。実装が計画からずれたら、既存の記述を変更後の状態に書き直す。

## Issue と PR の画像

- Issue、PR、検証記録に貼る画像は、`images` ブランチに置く。`images` は main と履歴を共有しない orphan のブランチで、追記だけを行い、書き換えも削除もしない。
- 画像は `issue-<番号>/` の下に置く。PR の画像には、その PR が閉じる Issue の番号を使う。
- 画像は `pnpm images:upload --issue <番号> <ファイル>...` で上げ、出力された Markdown をそのまま貼る。この道具は、作業中のブランチと worktree を変えずに `images` へ commit して push する。保存する名前には中身のハッシュが付くので、同じ名前の別の画像も別のファイルとして残る。
- リンクは、画像を加えた commit の SHA に固定した `https://github.com/wakamenori/instant-madori/blob/<sha>/issue-<番号>/<ファイル>?raw=true` の形にする。private のリポジトリでも、権限のある人には表示される。
- 秘密の値が写った画像は上げない。上げた画像は消せない。
