# 検証4：接続用DOのアラームによるContainerの休止停止

実施日：2026-11-15。Issue #42 のローカル検証。設定値から費用を見積もれるよう、最後の操作の完了から休止時間が過ぎたContainerをDOのアラームで止める。

## 構成と入口

- miseで固定したNode.js、pnpm、Rust、Wranglerを使う。全コマンドに `CARGO_INCREMENTAL=0` を渡す。
- `pnpm install --frozen-lockfile`、`pnpm setup` の後に検査する。
- `node --test apps/worker/tests/container-gateway.test.ts` は時刻・ストレージ・アラームを差し替えたゲートウェイを使う。
- `node --test apps/worker/tests/container.e2e.ts` はWranglerのローカルWorker、DO、DockerのLinux amd64 Container、releaseのWasmを接続する。休止時間だけ60秒へ変更し、インスタンスの種類や内部ルートの期限は変えない。
- `container.started` のイメージ文字列と一致する `docker ps --no-trunc` の行を一つに絞り、そのIDの停止を確かめる。他のセッションのContainerは操作しない。

## ローカルで確かめたこと

最初の実Container試験では、`container.idle_stopped` の `ms` は60,478 msだった。ログの出現と対象Containerの停止を確かめ、次の要求がcold startで成功した。観測用の待機開始から次の要求の完了までの時間には、ログの転送・ポーリング・再起動も含むため、停止時間には使わない。停止時間にはDOの `ms` を使う。

単体テストでは、期限の延長、早いアラームの置き直し、停止後の記録の削除とログ、再配信、本文待機中の保護、重なった操作の完了順、DOの再起動、未来の時刻の補正、停止失敗後の記録の保持、失敗が続いた場合の再予約、停止中に来る次の要求の記録を確かめる。

## 反証で決めた設定

指揮役のinterrogateでは、DOだけを落として、アラームが新しいDOを起こす経路を比較した。同じ休止時間を `setInactivityTimeout` に渡すと、実行環境が先にContainerを止め、`container.idle_stopped` が出なかった。60秒の余裕を足すとアラームによる停止を観測した。この比較は指揮役から受け取った結果であり、このownerによる再計測ではない。

本番にDOを落とす試験用の入口は追加しない。起動時と `resume` 時の双方で休止時間 + 60,000 msを渡すことを単体テストで固定し、同じ値に戻す変異をその入口で検出する。実Containerの変異試験はアラームを無効にした場合を使う。

## 変異試験と復元

- `GeometryContainer.alarm()` を何もしない形にして `node --test apps/worker/tests/container.e2e.ts` を実行した。同じidle停止のassertionで失敗した。[失敗の出力](evidence/verification-04/disabled-alarm-mutant.txt)。
- 起動時と `resume` 時の `setInactivityTimeout` から60秒の余裕を消して `node --test apps/worker/tests/container-gateway.test.ts` を実行した。期待する `[120000, 120000]` に対して `[60000, 60000]` が渡り、失敗した。[失敗の出力](evidence/verification-04/equal-timeout-mutant.txt)。
- 両方の変更を復元した。通常の実Container試験の[停止ログ](evidence/verification-04/container-idle.jsonl)を保存した。コミット後にDockerを起動した状態で `pnpm check --full` を実行し、そのheadと結果をPRと指揮役への報告に残す。

## stagingで残る確認

このPRのマージ後、検証用ユーザーとしてContainerを一度起動し、以降は要求を送らず、Workers Logsで最後の操作から約10分後の `container.idle_stopped` と、それ以降に同じContainerのログが無いことを確認する。ownerはデプロイせず、この項目は未実施として指揮役へ引き継ぐ。ローカルのamd64エミュレーションの結果からCloudflare上の停止時間を断定しない。

マージ後に指揮役が確かめた結果は、[検証5](verification-05.md)に書いた。
