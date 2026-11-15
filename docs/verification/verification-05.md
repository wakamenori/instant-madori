# 検証5：stagingでのContainerの休止停止

実施日：2026-11-15（UTCでは2026-11-14）。Issue #42 のマージ後の、stagingでの検証。[検証4](verification-04.md)でローカルだけを確かめた休止停止が、Cloudflare上でも設定どおりに動くことを確かめる。

## 構成

- 対象はstagingのWorker `instant-madori-staging` である。#42 は、PR #267 のマージコミット `82c911e9c682a9d01c29fcf3137c26690ef5d482` で入った。測定したのは、そのあとのマージコミット `bbd8460920d8fb19334b3004d8424dd400f9bb44` の `deploy-staging`（run 43652651038）が成功した後の版である。
- 休止時間は、`apps/worker/wrangler.jsonc` のstagingの `GEOMETRY_IDLE_TIMEOUT_MS` で 600,000 ms とした。
- 検証用の利用者（#34 のAccessのサービストークン）として、`GET /api/sample/display` を一度だけ送った。その後はstagingへ要求を送っていない。
- この要求の前に、stagingで二つの確認を行った。証拠には、そのうち次の三つの要求を残した。
  - デプロイの疎通の確認（23:26:19Z）の最後の要求 `GET /api/sample/display`。Containerを使う。
  - #36 の確認（23:27:13Z）の `POST /api/patterns/:patternId/messages` と `GET /api/patterns/:patternId/state`。Containerを使わない。
- 観測には、Workers Logsの検索（Workers Observabilityのクエリ API、`$metadata.service = instant-madori-staging`）を使った。

## 結果

| 時刻（UTC）  | 記録                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| 23:27:40.757 | `api.request`、`GET /api/sample/display`、200、`geometryStart: warm`、86 ms    |
| 23:37:40.919 | `container.idle_stopped`、`ms: 600164`                                          |

- 最後の要求から停止のログまでは、10分0.16秒だった。`ms` は休止時間の 600,000 ms 以上で、超えた分は164 msだった。
- 23:37:41Zから23:45:15Zまで、stagingのWorkerのログは0件だった。Containerのログも要求もない。
- Cloudflare側でContainerのインスタンスが終わったこと自体を、直接見る手段はない。DOのアラームが停止を記録したログと、その後にログが無いことで判断した。

## 費用の見積もりに使う値

- 最後の要求の後、Containerは休止時間の10分と、アラームの遅れの分だけ動き続ける。今回の遅れは164 msだった。plan 5.1 の設定は変えない。
- 観測は一回だけで、アラームの遅れのばらつきは測っていない。

## 証拠

- [Workers Logsの検索で得た記録](evidence/verification-05/workers-logs.jsonl)。
  - 要求と停止の行は、`at`、`event`、`route`、`status`、`ms`、`geometryStart` のうち、元の記録にあった欄を持つ。指揮役が加えた `note` を持つ行もある。
  - 最後の行は、停止の後の検索の範囲（`window`、`service`）と、その件数（`events`）である。
  - 利用者IDとトレースIDは含めていない。
