# 検証8：完了条件の障害の試験

実施日：2026-11-21（UTCでは2026-11-20）。Issue #47 の検証。計画6.1bの完了条件のうち「停止と確定の競合、同じ要求の再送、R2保存後のDB失敗、Worker・Containerの停止を試し、以前の確定案と履歴が壊れない」を、項目ごとに、試した場所、コマンド、結果でまとめる。stagingで起こせる試験は、繰り返し実行できるスクリプト `scripts/check/staging-faults/main.ts` で行った。

## 構成

- stagingの版は main `6febc4a24` である。試験の再デプロイには、指揮役が起動した deploy-staging の run [44825758357](https://github.com/wakamenori/instant-madori/actions/runs/44825758357)（`workflow_dispatch`、成功）を使った。staging の `JOB_TEST_HOLD` は `before_render:180` のままにした。
- スクリプトは commit `fd9f5ea30` のものを、次のコマンドで実行した。スクリプトはデプロイを起こさず、指揮役が起動した run を受け取る。

  ```sh
  CLOUDFLARE_ACCOUNT_ID=4a67230af28ec94d9c70ca48572d8e9f mise exec -- node --env-file="$MAIN/.env" \
    scripts/check/staging-faults/main.ts --deploy-run 44825758357 --evidence docs/verification/evidence/verification-08
  ```

- 試験の対象は、検証用の利用者の案件にあるパターン「障害試験」（`acb8c0b1-9f47-4ed5-8a45-db4d69362db7`）である。今回が最初の実行で、案0件から始まった。スクリプトはこのパターンを、固定のrequest IDで作成を再送して得る。次の実行も同じパターンを使い、それまでの実行で確定した案をすべて照合し直す。
- 各試験の前後で、状態、案の一覧の全ページ、各案の表示データ（`GET /api/revisions/:id/view`）のSHA-256を読んだ。判定は、前の案がすべて同じ記録と同じハッシュで残っていること、増えた案の数が期待どおりであること（0件か1件）、1件増えたときはその案が現在の案で、番号が前の最大より1大きく、編集元が前の現在の案で、その試験のジョブが確定した案であること、試験の後に実行中・待機中・保留のジョブがないことである。
- ローカルの試験は、このブランチの commit `fd9f5ea30` で `node --test --test-reporter=spec <ファイル>` を実行した。

## 結果

スクリプトは終了コード0で終わった。22:04:38Zに始め、22:17:13Zに終えた。

| 完了条件の項目 | 試験 | 場所 | 結果 |
| --- | --- | --- | --- |
| 同じ要求の再送 | 指示を同じrequest IDで再送する。同じIDを別の本文と、そのジョブの停止に使い回す | staging | 再送は202で、本文がバイト単位で一致した。使い回しは二つとも422 `request_id_reused` で、ジョブは止まらなかった。案は0件から1件 |
| 同じ要求の再送 | 停止と再開を同じrequest IDで再送する。停止のIDを別のジョブの停止に使い回す | staging | 再送の本文が一致し、使い回しは422だった |
| 停止と確定の競合 | 確定の後に止める | staging | 200 `already_finished`、`completed` で、確定した案のIDを返した。停止の再送と、確定した指示の再送も同じ本文を返し、ジョブは増えなかった。案は1件のまま |
| 停止と確定の競合 | 待たせている間に止める | staging | 200 `stopped`、`cancelled`。案は1件のまま。ジョブは待ちに入った後に止まり、その Workflow は待ちが明けた後に `cancelled` で終わった（Workers Logs） |
| 停止と確定の競合 | 停止と確定を並行に送る、確定の段階の中で止める、R2保存後・確定の前に止める | ローカル | 成功（下の「stagingで行っていない試験」） |
| R2保存後のDB失敗 | D1の確定のbatchを失敗させ、同じ実行権で再試行する | ローカル | 成功（同上） |
| Workerの停止 | 待たせている間に同じmainの版を再デプロイする | staging | ジョブは `completed` で終わり、案は1件から2件に、一件だけ増えた |
| Containerの停止 | 準備の後の停止、起動の途中の停止 | ローカル | 成功（同上）。stagingでは行っていない |
| 待機列の保留と再開（#40） | 実行中の指示を止め、待機中の指示が動かないことを確かめてから再開する | staging | 止めた後、`queueHold` が止めたジョブを指し、待機中の一件が30秒動かなかった。再開はその一件を返し、再送も同じ本文を返した。その指示は `completed` で、案は2件から3件 |
| 以前の確定案と履歴 | 上の各試験の前後と、最後の照合 | staging | 各試験の後、前の案はすべて同じ記録と同じ表示データのSHA-256で残った。止めた二件の Workflow が `cancelled` で終わった後の照合でも、案は3件のまま変わらなかった |

再デプロイをまたいだ試験の、このパターンのWorkers Logsは次のとおり（時刻はUTC）。

| 時刻 | 版 | 行 |
| --- | --- | --- |
| 22:08:19〜22:08:32 | なし | deploy-stagingの「Migrate and deploy」 |
| 22:08:22.363 | `04c13901`（古い） | 待たせるジョブの `pattern.advanced` claimed |
| 22:08:23.731 | `04c13901` | `job.step` check test hold before render: hold |
| 22:08:52.357〜22:11:19.971 | `a6a70806`（新しい） | `pattern.advanced` running（`instanceStatus: running`）を30秒ごとに6回 |
| 22:10:49.898 | `04c13901` | 待ちの間に止めたジョブの `job.finished` cancelled |
| 22:11:23.875 | `a6a70806` | `container.adopted`、`container.ready`（`mode: adopted`） |
| 22:11:24.577〜22:11:24.748 | `04c13901` | `job.step` render snapshot: saved、commit revision: committed、`job.finished` committed |
| 22:11:24.801 | `a6a70806` | `pattern.advanced` idle |

- **WorkerとパターンDOの再起動。** パターンDOの照合は、待ちの間に古い版から新しい版に変わった。新しい版のDOは動いているWorkflowに触れず、完了の後は `idle` で照合を止めた。照合の失敗（`pattern.advance_failed`、`failed`・`stalled` の `pattern.advanced`）は、試験の間に一件もなかった。
- **Workflowの継続。** 待ちはデプロイの前に始まった。描画、確定、起こしは、デプロイの後に古い版のコードで進んだ。動いているインスタンスは、再デプロイの後も、作られたときの版のコードで続く。[#41 の確認](https://github.com/wakamenori/instant-madori/issues/41#issuecomment-7042478247)と同じ結果である。
- **Container。** 待たせたジョブの描画では、新しい版の接続用DOが、前の描画から217秒動いていたContainerを引き継いだ（`container.adopted`）。同じmainの再デプロイでは、Containerは止まらず、置き換わらなかった。
- **表示データのハッシュ。** サンプルの表示データには入力がないので、三つの案のSHA-256は同じ値になった。判定は案のIDごとにハッシュを比べるので、案の消失、記録の変化、表示データの変化は見つかる。同じバイト列の案どうしの取り違えは、ハッシュでは見つからない。

「Migrate and deploy」は、runの作成から4分19秒後に始まった。runner がすぐに空き、`pnpm check --full` が4分で終わったためである。先の三つの試験は約3分16秒かかり、その段階が始まるまでの余裕は約20秒だった。間に合わなければ、スクリプトは待たせるジョブを送らずに、終了コード2で終わる。

## stagingで行っていない試験

- **R2保存後のDB失敗。** stagingのD1を外から失敗させる手段がない。ローカルの `apps/worker/tests/rpc/job-execution.test.ts` の「R2 survives check rollback and the same right retries once」「R2 survives revision collision rollback and the same right retries once」「R2 survives completion update rollback and the same right retries once」が、ローカルのD1とR2でこれを確かめる。三つとも成功した（[出力](evidence/verification-08/local-job-execution.txt)）。
- **R2保存後、確定の前の停止と、段階の途中の停止。** stagingの待ちは `before_render` だけで、`before_commit` に切り替えるにはデプロイが要る。描画や確定の段階の途中に停止を当てる手段もない。ローカルの `apps/worker/tests/rpc/job-run.test.ts` の「stop during before_commit ends cancelled and wakes without a revision」「a stop during geometry discards the arriving result」「a stop inside completion still ends cancelled」と、`apps/worker/tests/rpc/job-stop.test.ts` の「a store whose R2 head runs the stop first refuses the commit batch」「parallel stop and commit choose one terminal result」が成功した（[出力](evidence/verification-08/local-job-run.txt)、[出力](evidence/verification-08/local-job-stop.txt)）。
- **Containerの停止（準備の後と、起動の途中の両方）。** stagingでは起こせない。stagingのContainerは `scheduling_policy: "durable_object"` で動く。この方式のContainerは、デプロイしても入れ替わらない（[Cloudflareの文書](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)）。一つのContainerを外から止めるREST APIとwranglerのコマンドもない。イメージを変えたブランチをデプロイすると、次の要求で接続用DOが古いイメージのContainerを `destroy()` で置き換える（`container.replaced` の `stale_image`）。これは接続用DO自身が止める経路で、外からの停止ではない。起動の途中の停止も、同じ理由で外から起こせない。ローカルでは、準備の後の停止を `apps/worker/tests/container.e2e.ts` の「a Container killed outside the gateway is replaced by the next job」で、起動の途中の停止を `apps/worker/tests/container-gateway.test.ts` の「exit during readiness clears the lifetime when the probe answers throw」「… answers healthy」で確かめる。前者は、試験の再デプロイに使った run 44825758357 の `pnpm check --full`（self-hosted runnerで、ローカルのWorkerとDockerのContainerを使う）で成功した（[出力](evidence/verification-08/deploy-run-container-tests.txt)）。後者は、このブランチでも成功した（[出力](evidence/verification-08/local-container-gateway.txt)）。Cloudflare上で起動の途中にContainerが止まったときの扱いは、確かめていない。確かめるには、stagingの検証用の利用者だけに効く、起動の途中で止める試験用の設定が要る。

## 証拠

証拠は[記録フォルダ](evidence/verification-08/)に置いた。利用者ID、service token、APIトークンは含めていない。

- [stdout.txt](evidence/verification-08/stdout.txt)：スクリプトの出力。各試験の `PASS` の行と、最後の `PASS staging fault journey`、終了コード。
- [journey.jsonl](evidence/verification-08/journey.jsonl)：各試験の前後の案の一覧、表示データのSHA-256、判定、ジョブのID、時刻。最後の行はWorkers Logsの判定である。この実行のスクリプトは、行にパターンのIDを書いていない。PRで書くように足した。
- [logs.jsonl](evidence/verification-08/logs.jsonl)：このパターンのWorkers Logsの行を、版つきで時刻順に並べたもの。
- [container.jsonl](evidence/verification-08/container.jsonl)：待たせたジョブの描画の、接続用DOの `container.*` の行。
- [deploy-run.json](evidence/verification-08/deploy-run.json)：再デプロイのrunと、「Migrate and deploy」の開始・終了の時刻。
- `local-*.txt`：ローカルの試験の出力。`local-tests-head.txt` は、そのときのcommitである。
- [deploy-run-container-tests.txt](evidence/verification-08/deploy-run-container-tests.txt)：run 44825758357 の `pnpm check --full` のうち、Containerの停止に関わる試験の行。

## 次に実行するとき

指揮役にstagingの占有と main の再デプロイ（`gh workflow run deploy-staging.yml --ref main`）を頼み、run のIDを受け取ったら、その run の `pnpm check --full` が終わる前に上のコマンドを実行する。終了コードは、合格が0、DOの切り替えを観測できなかったときが2、それ以外の失敗が1である。2なら再デプロイをもう一度頼んで実行し直す。6.2でジョブの中身をAIに置き換えた後も、同じコマンドで同じ性質を確かめる。
