# 検証3：stagingでのContainerの計測

実施日：2026-11-14。[実装計画](../plan.md)6.1bの単位3として、stagingのCloudflare上で、サンプルの表示経路（Worker → DO → Container → Wasmビューア）の起動時間・処理時間・メモリ・転送サイズと、休止後の停止を測った。本文は実施時点の記録であり、現在の仕様と実装順は実装計画を参照する。

## この結果からの判断

**Container上のSolidCraftは、standard-1の資源の範囲で余裕をもって動く。4.1の構成（Containerで形状処理を行い、表示データをWasmへ渡す）を変える理由は見つからなかったので、単位4へ進む。**

| 設定 | 決定 | 根拠 |
| --- | --- | --- |
| `GEOMETRY_INSTANCE_TYPE` | standard-1のまま | サンプルではメモリの最大値が約46 MiBで、liteとstandard-1の処理時間に差が出なかった。サンプルは家一軒より軽いので、種類は6.2で住宅の形状処理を測って決め直す |
| `GEOMETRY_IDLE_TIMEOUT_MS` | 600000（10分）のまま | 下の「休止後の停止」のとおり、再デプロイを挟まなかった各1回では、休止時間を10分にしても60秒にしても、止まった時刻はほぼ同じだった。休止時間どおりに止める仕組みは単位5で作る（実装計画6.1b） |
| `routeTimeouts` | 変えない（health 2秒、sampleDisplay 30秒） | 準備完了後の処理は最大でも0.6秒だった |
| readinessの期限 | 60秒のまま | 新しいイメージで最初に起動した回は38.2秒かかり、期限までの余裕は約22秒だった（1回の観測）。期限を延ばすと、本当に起動できないときの待ち時間が延びるため、6.2でイメージを小さくする方法を検討する |
| 同時に動かすContainerの上限 | 単位5で決める | 現在はサンプル用のDO一つ（`sample`）に一台だけで、複数台を動かす経路がまだない |

## 構成と手順

- stagingは `instant-madori-staging.firpmnfiywl.workers.dev` で公開した。管理するドメインがないため、workers.devを有効にし、Worker宛先（`destinations: [{type: "worker"}]`）のAccessアプリで守った。ログインせずに `/`、`/api/me`、静的ファイルへcurlで要求し、どれもAccessのログイン画面への302になることを確かめた。
- `observability` を有効にし、Container内の標準出力もWorkers Logsに集めた。`wrangler tail --format json` を動かしながら要求したときは、Workerのログだけが流れ、Containerのログは出なかった。
- Container内のRustは、起動時にcgroupのCPUとメモリの上限を `geometry.limits` としてログに出す。Containerの設定（`wrangler containers info`）にはインスタンスの種類が表示されないため、実際に適用された資源をこのログで確かめた。
- ログはWorkers Logsの検索API（`/workers/observability/telemetry/query`、`Workers Observability Write` の権限）から取得した。手順は[記録フォルダ](evidence/verification-03/)のスクリプトにある。
  - `fetch-logs.sh`：指定した時間帯のログを1行1件のJSONで出力する。
  - `summarize.sh`：コールドスタート、処理時間、メモリ、資源の上限、Containerの起動・停止を集計する。中央値は件数が偶数のとき小さいほうの値を採る。
  - `force-cold.sh`：インスタンスの種類を設定して再デプロイし、直前のContainerが停止したことをログで確かめるまで待つ。
- 要求はAccessでログインしたブラウザ（T3のプレビュー、Chromium）から送った。AccessのクッキーはHttpOnlyで、ページのJavaScriptからは読めない。クッキーを手で写してcurlから送る方法はとらなかった。
- 計測した時間帯（05:29〜07:00 UTC）のログを [events.jsonl](evidence/verification-03/events.jsonl) に保存した。アカウントIDは `<account-id>` に置き換えている。`./summarize.sh events.jsonl` で、コールドスタート、温まった後の処理時間（全体とContainerごと）、メモリ、資源の上限、件数、起動と停止の時刻を再現できる。停止の表の経過時間は、その起動と停止の時刻から計算した。
- `force-cold.sh` で停止をログで待つ形にしたのは06:14:46の切り替えからで、それより前は `wrangler containers list` で待っていた（下の「再デプロイとContainer」）。デプロイの出力の扱いは、06:41:18の切り替えの後に直した。

### デプロイと設定の経過

インスタンスの種類と休止時間はログに出ないため、各デプロイの版の設定を `wrangler versions view <版> --env staging` で読み、次の表と一致することを確かめた。時刻はUTC。その前の05:29:00のデプロイ（234bd794）もstandard-1・10分だった。このデプロイの出力は、DOの `GeometryContainer` を新しく作成し、公開経路がない（No targets deployed）ことを示した。`wrangler containers info` でも、Containerのアプリケーションの作成時刻は05:29:03である。そのため、05:29:00がこのWorkerとContainerを作ったデプロイだと判断した。Workers Logsにも05:30:40より前の記録はない。

| デプロイ | 版 | 種類 | 休止時間 | 目的 |
| --- | --- | --- | --- | --- |
| 05:29:31 | 24154f05 | standard-1 | 10分 | Accessの設定を反映して公開 |
| 05:48:09 | fc2c475a | standard-1 | 60秒 | 休止時間を変えた停止の観察 |
| 06:06:46 | a2fd7078 | lite | 60秒 | liteの計測 |
| 06:07:04 | c335a427 | standard-1 | 60秒 | 再デプロイでContainerを止める試み |
| 06:07:23 | e07bc0d8 | lite | 60秒 | 同上 |
| 06:14:17 | 8e80c2fb | standard-1 | 60秒 | standard-1の連続要求 |
| 06:14:46 | d12ddb6f | lite | 60秒 | liteの連続要求 |
| 06:23:10 | b9a4f335 | standard-1 | 10分 | 設定を戻す |
| 06:39:48 | 2400fd85 | standard-1 | 10分 | `geometry.limits` を加えた新しいイメージ |
| 06:41:18 | e41e9690 | lite | 10分 | liteの資源の確認 |
| 06:58:15 | 4b8093b3 | standard-1 | 10分 | 設定を戻す（現在の版） |

## 結果

### 実際に適用された資源

| 起動 | 種類の設定 | `cgroupMemoryMax` | `cgroupCpuMax` | `parallelism` |
| --- | --- | --- | --- | --- |
| 06:39:55 | standard-1 | 4,294,967,296 B（4 GiB） | `max 100000` | 1 |
| 06:56:51 | lite | 268,435,456 B（256 MiB） | `max 100000` | 1 |

メモリの上限は、どちらも設定した種類の仕様（standard-1は4 GiB、liteは256 MiB）と一致した。起動時に渡す `instance` が適用されていることを、メモリの上限で確かめた。CPUの上限はcgroupには設定されておらず（`max`）、仕様の割り当て（standard-1は1/2 vCPU、liteは1/16 vCPU）がどこで制限されているかは、Container内からは確かめられない。

`geometry.limits` を加える前の5回の起動にはこのログがない。そのため、05:30〜06:21の各回の種類は、上の経過表の設定から判断している。

### 起動時間（コールドスタート）

`container.ready` の `ms` は、Containerの起動要求から `/healthz` が応答するまでの時間。要求全体の `geometryMs` は、それに起動後最初の表示データの処理（Container内で174〜188 ms）を加えた時間。

| 起動 | 種類 | イメージ | `container.ready` | 要求全体の `geometryMs` |
| --- | --- | --- | --- | --- |
| 05:30:40 | standard-1 | 最初のイメージ | 8,078 ms | 8,261 ms |
| 05:48:15 | standard-1 | 同上 | 339 ms | 518 ms |
| 06:06:53 | lite | 同上 | 347 ms | 538 ms |
| 06:14:26 | standard-1 | 同上 | 377 ms | 566 ms |
| 06:21:18 | lite | 同上 | 347 ms | 536 ms |
| 06:39:55 | standard-1 | 新しいイメージ | 38,247 ms | 38,434 ms |
| 06:56:51 | lite | 同上 | 356 ms | 532 ms |

- イメージを変えた後の最初の起動だけが遅かった（8.1秒と38.2秒）。それ以外の5回は339〜377 msだった。05:30:40は、Workerを作った05:29:00以降で最初の起動である。
- 遅かった2回では、Rustの起動の行（`Geometry service`）が `container.started` の8秒後と38秒後に出ている。遅れはプロセスが待ち受けを始める前に生じており、readinessの確認の間ではない。Containerのホストへイメージ（圧縮時79.8 MB、展開後325 MB、ローカルのDockerでの値）を取得する時間と推測している。ホストとイメージの取得はログに出ないため、この推測は確かめられない。確かめるには、取得の有無がわかる記録（Cloudflareのダッシュボードの起動の詳細など）と照らし合わせる必要がある。
- 38.2秒はreadinessの期限（60秒）に近い。新しいイメージの最初の起動が期限を超えると、その要求は失敗する。

### 処理時間（温まった後）

コールドスタート直後の最初の要求を除いた値。

| 値 | 件数 | 最小 | 中央値 | 最大 |
| --- | --- | --- | --- | --- |
| Workerの `geometryMs` | 103 | 28 ms | 33 ms | 560 ms |
| Container内の処理（`geometry.request` の `ms`） | 102 | 25 ms | 29 ms | 557 ms |

Containerごとの内訳（Container内の処理）：

| 起動 | 種類 | 件数 | 最小 | 中央値 | 最大 |
| --- | --- | --- | --- | --- | --- |
| 05:30:40 | standard-1 | 5 | 26 ms | 27 ms | 30 ms |
| 06:06:53 | lite | 8 | 25 ms | 29 ms | 557 ms |
| 06:14:26 | standard-1 | 29 | 27 ms | 30 ms | 34 ms |
| 06:21:18 | lite | 29 | 27 ms | 30 ms | 32 ms |
| 06:39:55 | standard-1 | 2 | 28 ms | 28 ms | 30 ms |
| 06:56:51 | lite | 29 | 25 ms | 28 ms | 31 ms |

- 失敗した要求（200以外）は0件で、`api.request` の `bytes` は110件すべてが14,976だった。
- liteとstandard-1で、温まった後の処理時間に差は出なかった。サンプルの処理はContainer内で約30 msと短く、CPUの割り当ての差が表に出ない大きさである。
- 06:06:53のliteのContainerで、06:07:14〜17の5回だけが遅かった（Workerの `geometryMs` は340、560、552、546、452 ms）。直前の06:07:04に再デプロイしており、このContainerは `warm` のまま応答していた。06:21と06:56のliteのContainerでは、30回続けても遅くならなかった。原因は確かめられない。確かめるには、再デプロイの直後に同じContainerへ要求する条件を繰り返し作り、遅くなるかを比べる必要がある。
- Workers Logsで1行のログが2件に分かれて記録されたものが2件あり（06:07:16の449 ms、06:21:18の186 ms）、Container内の処理の集計から外れた。そのため、`api.request` は110件、Container内の表示データの処理は108件である。

### メモリ

Container内の `VmHWM` の最大値は47,012 KiB（約46 MiB）。起動直後の `/healthz` の時点では約9 MiBだった。liteの上限256 MiBに対しても余裕がある。

### 転送サイズ

05:32にブラウザのResource Timingで測った。この値はログには残っていない。

| 対象 | 転送時（圧縮後） | 展開後 |
| --- | --- | --- |
| Wasm（`madori_viewer_bg`） | 587,457 B | 3,884,599 B |
| JavaScript | 111,965 B | 358,316 B |
| 表示データ（`/api/sample/display`） | 14,976 B（圧縮なし） | 14,976 B |

表示データは `content-encoding` なしで返る。サンプルでは小さいため問題にならない。住宅一軒分の表示データでの扱いは6.2で測る。

### 休止後の停止

観測した6回とも止まり、終了コードは0だった。06:56:51に起動した7回目は、ログの範囲内では止まっていない。止まった時刻は、休止時間の設定どおりにはならなかった。

| 起動 | 最後の要求 | 休止時間 | 起動後の再デプロイ | 停止 | 起動から |
| --- | --- | --- | --- | --- | --- |
| 05:30:40 | 05:32:13 | 10分 | なし | 05:47:02 | 16分22秒 |
| 05:48:15 | 05:48:16 | 60秒 | なし | 06:04:18 | 16分02秒 |
| 06:06:53 | 06:07:17 | 60秒 | 06:07:04、06:07:23 | 06:13:06 | 6分13秒（最後の再デプロイから5分43秒） |
| 06:14:26 | 06:14:29 | 60秒 | 06:14:46 | 06:20:46 | 6分20秒（再デプロイから6分00秒） |
| 06:21:18 | 06:21:20 | 60秒 | 06:23:10 | 06:29:11 | 7分53秒（再デプロイから6分01秒） |
| 06:39:55 | 06:40:34 | 10分 | 06:41:18 | 06:56:19 | 16分24秒（再デプロイから15分01秒） |

- 再デプロイがなかった2回は、休止時間が10分でも60秒でも、起動から約16分で止まった。
- 接続用DOは、起動時に呼んだ `container.monitor()` を待ち続けている。Cloudflareの文書は、実行中の `monitor()` はDOのメモリからの退去を最長15分防ぎ、`setInactivityTimeout()` はDOが非アクティブになってからContainerを動かし続ける時間だと説明している（[Container API](https://developers.cloudflare.com/durable-objects/api/container/)、[DOのライフサイクル](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)）。休止60秒の回は、この説明（約15分で退去し、その後60秒で停止）と合う。休止10分の回は、この説明どおりなら約25分で止まるはずだが、16分22秒で止まった。したがって、停止の仕組みは推測にとどまる。DOが退去した時刻はログに出ず、`monitor()` が終わったときに出すはずの `container.exited` もどの回にも記録されていないため、確かめられない。確かめるには、退去の時刻を記録し、休止時間を15分より長くした回と比べる必要がある。
- 再デプロイした回のうち3回は、再デプロイの約6分後に止まった。06:39:55の回だけは、再デプロイの15分後に止まった。違いの原因は確かめられない。
- 現在の実装では、要求が一度だけのContainerも約16分動き続ける。standard-1（4 GiB）では、メモリだけで1回あたり約1 GiB時間になる。Workers Paidに含まれる月25 GiB時間の範囲では、月に約23回分にあたる（2026-11-14時点の[料金](https://developers.cloudflare.com/containers/platform/pricing/)からの計算。CPUとディスクは含めていない）。

### 再デプロイとContainer

- 再デプロイしても、実行中のDOとContainerはすぐには入れ替わらなかった。06:07:04の再デプロイ後も、06:07:14の要求は同じContainerが `warm` として処理した。
- `wrangler containers list` は、06:07:08にContainerが実行中0台と表示したが、そのContainerは06:07:14〜17にも応答し、06:13:06に止まった。停止の判定には使えないため、`force-cold.sh` はWorkers Logsの「Container exited」で判定している。
