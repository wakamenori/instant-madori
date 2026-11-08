# Prettier・Biomeの実測比較

検証日：2026-11-08。対象：instant-madori の `7df462fe0`。採用設定は変更していない。

## 結論と推奨（未採用）

整形をBiome 2.6.6へ移し、型付きESLintとReact Hooksの検査を維持する構成を推奨する。実ファイルで整形時間の短縮を確認できた。一方、Biomeだけに統合すると、現在検出できる問題の一部を今回の試験で検出できなくなった。

これは現時点の小さなサービス側コードに対する結果であり、任意のコードでの整形互換性やlint全体の検出率を示すものではない。Rustの整形・静的解析は比較対象に含めない。

## 環境と比較条件

- macOS 27.2 arm64、Node.js 24.22.1。
- Prettier 3.9.10、ESLint 10.14.0、typescript-eslint 8.72.1、TypeScript 6.0.3、eslint-plugin-react-hooks 7.1.1。
- Biome 2.6.6は一時ディレクトリへ固定版でインストールした。npmメタデータのライセンスはMIT OR Apache-2.0。リポジトリのpackage.json・lockfileは変更していない。
- 自作ファイルのコピーで検証した。SolidCraft本体、過去の検証資料、依存・ビルド生成物を整形対象から除外した。型の解決には既存のnode_modulesと生成済みWorker・Wasm宣言を使った。
- [入力ファイル一覧](evidence/tooling-2026-11-08/files.json)は42ファイル、127,215 bytes。TS・TSX・MJS・JSON・JSONC・CSS・HTML・Markdown・YAMLを含む。lintの速度比較はそのうち14ファイル。
- インデント2空白、幅100、MarkdownのproseWrapはpreserve。HTMLの実験的formatterを明示的に有効にした。
- lint移行は`biome migrate eslint --write --include-inspired --include-nursery`で実施した。実験的ルールを除いた比較にはしていない。

## 整形結果

42ファイルすべてを処理できた。38ファイルはPrettierの出力と一致した。差分があった4ファイルは次のとおり。

| ファイル | 差分 |
| --- | --- |
| `.github/dependabot.yml` | YAMLの配列の角括弧の内側に空白 |
| `.github/workflows/ci.yml` | 同上 |
| `.github/workflows/security.yml` | 同上 |
| `apps/worker/wrangler.jsonc` | JSONCの末尾カンマを除去 |

[実際の差分](evidence/tooling-2026-11-08/format-changes.json)を保存した。TS・TSX・Markdownを含む残りのファイルには差分がない。整形後のGitHub Actionsはactionlintを通過した。

自動移行された`.prettierignore`では、末尾が`/`のディレクトリ除外が期待どおりに効かなかった。`biome format .`で、SolidCraft・過去の検証資料・target・Wasm生成物の下に置いた意図的な構文エラーが検出された。ファイル単体で除外したWorkerの型宣言は除外された。

これを`files.includes`の`!!`によるディレクトリ除外と、対象ファイルの明示除外へ変更して再検査した。5か所すべてが読み飛ばされ、`--write`後も内容のハッシュは変わらなかった。[結果](evidence/tooling-2026-11-08/scope-results.json)と[整形専用の候補設定](evidence/tooling-2026-11-08/biome-formatter-candidate.json)を保存した。この設定は本体には適用していない。

## 速度

同じファイル一覧を明示して実行した。各ツールで整形済みの入力を作り、両方とも検査成功の状態で測定した。毎回CLIプロセスを起動し、起動時間を含めた。pnpmなどの起動ラッパーとBiome daemonは使わず、キャッシュを消す操作もしていない。

2回のウォームアップ後、実行順を交互に入れ替えながら10回測定した。以下は除外設定を修正した、整形専用の候補設定による最終測定。

| 整形チェック | 中央値 | 最小〜最大 |
| --- | --- | --- |
| Prettier | 337.1 ms | 333.8〜342.6 ms |
| Biome | 49.1 ms | 47.2〜51.3 ms |

今回の条件では約6.9倍、1回あたり約288msの短縮。CI全体が同じ倍率で速くなるという意味ではない。ほかのプロジェクト規模やマシン、ファイルシステムが冷えた状態では未計測。[全測定値](evidence/tooling-2026-11-08/formatter-benchmark-final.json)。

別途、移行したlint設定ではESLintが中央値1,252ms、Biomeが68msだった。ただし後述のとおり検査内容が異なるため、同等の検査を高速化できたとは扱わない。[初回の測定値](evidence/tooling-2026-11-08/benchmark-results.json)。

## lintの検出能力

現在の検査に関係する11種類の問題を用意した。正常例として、処理済みPromise、Zodで検証したJSON、網羅したswitch、正しいHooks・依存配列も確認した。

| 問題を含む例 | 現在のESLint | 移行したBiome |
| --- | --- | --- |
| fetchのPromiseの処理漏れ | 検出 | 検出 |
| 別ファイルからimportした関数のPromise処理漏れ | 検出 | 検出 |
| 未検証JSONのプロパティ利用・返却 | 検出 | 未検出 |
| 未検証JSONから得た値を関数として実行 | 検出 | 未検出 |
| 未検証JSONを型付き引数へ渡す | 検出 | 未検出 |
| addEventListenerへasync関数を直接渡す | 検出 | 未検出 |
| unionのswitchで分岐が欠落 | 検出 | 検出 |
| 条件付きのHook呼び出し | 検出 | 検出 |
| useEffectの依存配列が不足 | 検出 | 検出 |
| render中にref.currentを読む | 検出 | 未検出 |
| useEffect内で同期的にsetStateを呼ぶ | 検出 | 未検出 |

ESLintは11種類すべて、Biomeは5種類を検出した。これは選んだ例の結果であり、一般的な精度の割合ではない。正常例は両方とも通過した。[検証コード](evidence/tooling-2026-11-08/probe-sources.json)と[各ルールの検出結果](evidence/tooling-2026-11-08/probe-results.json)を保存した。

Biomeの`types`と`react`ドメインを`all`にした追加試験でも、上記6種類の未検出は変わらなかった。正常例を同じファイルへまとめたことへのコンポーネントexportのスタイル指摘は増えた。`noFloatingPromises`、`noMisusedPromises`、`useExhaustiveSwitchCases`は移行後の設定で有効になっていることを確認した。

[追加試験の結果](evidence/tooling-2026-11-08/additional-checks.json)も保存した。これらの例を含めたWebのTypeScript型チェックは成功した。したがって、この検出差は`tsc`を残すだけでは補えない。

また、既存のWorkerのasyncハンドラーにはBiomeの`useAwait`が指摘を出した。現在のESLintでは通過するため、自動移行後もルールの意味が完全に揃うわけではない。[移行ツールが未実装と報告した、現在有効なルール](evidence/tooling-2026-11-08/migration-gaps.json)も保存した。

## 再確認の方法

元の採用設定と検証対象コミットを維持したコピーで実行する。Biomeを本体の依存に追加する必要はない。

1. 対象コミットの自作ファイルを一時ディレクトリの`project`へコピーし、node_modulesとWorker・Wasmの生成済み宣言を解決できるようにする。
2. 別の`tooling`ディレクトリへ`@biomejs/biome@2.6.6`をインストールする。
3. 整形比較では`project`を`formatted`へコピーし、候補設定を`formatted/biome.json`へ置く。入力一覧だけをBiomeで整形する。
4. `project`でPrettierの`--check`、`formatted`でBiomeの`format`へ同じ一覧を渡す。各プロセスを2回ウォームアップし、順序を入れ替えながら10回ずつ時間を測る。
5. lint比較では[移行済み設定](evidence/tooling-2026-11-08/biome-migrated.json)を`project/biome.json`へ置く。検証コードを`apps/web/src/quality-probes`へ展開する。`support.ts`には`export function loadArea(): Promise<{ area: number }> { return Promise.resolve({ area: 42 }); }`を用意する。
6. ESLintは`--format json --max-warnings 0`、Biomeは`--reporter=json --max-diagnostics=none --error-on-warnings`で同じディレクトリを検査する。併せて`tsc -p apps/web/tsconfig.json`を実行する。

## 参照した公式資料

言語の対応状況は[Biome](https://biomejs.dev/introduction/language-support/)と[Prettier](https://prettier.io/docs/)を確認した。移行オプションは[Biomeの移行手順](https://biomejs.dev/installation/migrate-from-other-tools/)、型を使うルールは[noFloatingPromises](https://biomejs.dev/linter/rules/no-floating-promises/javascript/)と[domains](https://biomejs.dev/linter/domains/)を参照した。採用判断は公式の速度倍率ではなく、上記の実測と検出結果に基づく。
