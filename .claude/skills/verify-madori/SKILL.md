---
name: verify-madori
description: instant-madori を利用者と同じ経路で動かし、振る舞いの証拠を残す。127.0.0.1:5173 の画面（WebGPU で描くサンプル）を T3 のプレビューで操作し、Vite のプロキシ経由で Worker API を呼び、その奥の形状 Container まで通す。マージの後は staging を確かめる。変更を本物のアプリで確かめるとき、PR の head を検証するとき、テストでは見えない振る舞いを確かめるときに使う。
---

# instant-madori を確かめる

機能ごとの手順は [features/README.md](features/README.md) にある。このファイルには、どの機能にも共通する準備、起動、状態確認、操作、証拠、片付けを書く。

## 一度に一つだけ動かす

`pnpm dev` は 8787 番と 5173 番を固定で使うので、このマシンで同時に動かせるのは一つだけ。自分で起動していないインスタンスは操作しない。起動の前に次を実行し、何か出たら止まって、起動した人に聞く。

```sh
lsof -nP -iTCP:8787 -iTCP:5173 -sTCP:LISTEN
```

## このマシンのシェル

Bash ツールは利用者の zsh の設定で動く。

- `noclobber` が有効なので、`>` は既にあるファイルを上書きせずに失敗し、`>>` は無いファイルを作れない。上書きには `>|`、無いファイルへの追記には `>>|` を使う。
- `cp` は `cp -i` の別名で、上書きの前に確認を求める。ファイルを戻すときは `git checkout -- <path>` か `command cp -f` を使う。
- 複合コマンドの `cd` は `cd X || exit 1` の形で書く。失敗したまま、別のチェックアウトで続けないため。
- 変数は語に分けられない。`set -- $var` は一つの引数になる。分けるときは `${=var}` と書く。
- 引用符の外の `?` と `==` は、展開されて失敗することがある。引用符で囲む。
- 込み入った処理は bash のスクリプトに書き、`bash <ファイル>` で実行する。
- pnpm に `CI=1` を渡さない。依存の確認で止まり、`pnpm install` を求められる。

## 準備

自分の worktree で動かす。メインのチェックアウトでは動かさない。メインの `apps/worker/.wrangler/state` には、開発者のローカルのデータがある。新しい worktree なら、ローカルの D1 は空から始まる。

PR の head を確かめるときは、その SHA を detached で取り出す。検査の前ごとに一致を確かめ、終えるときに PR の head が動いていないことも確かめる。

```sh
git fetch origin "pull/$PR/head"
git checkout --detach "$HEAD_SHA"
test "$(git rev-parse HEAD)" = "$HEAD_SHA" || exit 1
gh pr view "$PR" --json headRefOid --jq .headRefOid
```

`pnpm setup` は、worktree に `target` と `.tools` が無ければ、メインのチェックアウトのものを copy-on-write で複製し、自作の crate だけをこの worktree でビルドし直す（README「開発を始める」）。worktree ごとに `target` を持つので、ほかの worktree と同時に cargo を使ってよい。Git のフックはメインのチェックアウトでだけ登録されるので、入れ直さない。

```sh
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
export CARGO_INCREMENTAL=0
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm setup
```

ディスクの空きを 20 GiB 以上に保つ（`df -h /`）。複製した `target` は、`du` では複製元と同じ大きさに見える。空きは `df` で確かめる。

## 起動

証拠の置き場を worktree の外に作る。worktree の中に置いた未追跡のファイルは、`pnpm check` の整形と lint に巻き込まれる。Claude Code ならシステムプロンプトにあるスクラッチパッドの下、それ以外なら `$TMPDIR` の下にする。名前は `pr-<番号>-<head の先頭7文字>` か `<ブランチ>-<head の先頭7文字>` にする。

```sh
EVIDENCE="<スクラッチパッド>/verify-madori/<名前>"
mkdir -p "$EVIDENCE"
docker ps -a --format '{{.Names}}' | grep '^workerd-' | sort >| "$EVIDENCE/containers-before.txt"
```

Bash ツールの `run_in_background` で、新しいプロセスグループとして起動する。片付けでは、このグループに Ctrl-C と同じ SIGINT を送るので、グループの番号を残す。`set -m` はこの zsh では使えない。

```sh
perl -e 'setpgrp(0, 0); exec @ARGV or die "exec: $!"' mise exec -- pnpm dev >| "$EVIDENCE/dev.log" 2>&1 &
echo $! >| "$EVIDENCE/dev.pgid"
wait
```

`pnpm dev` は Wasm と Web をビルドし、ローカルの D1 にマイグレーションを当ててから、Worker（8787）と Vite（5173）を起動する。初回は amd64 イメージのビルドに数分かかる。次の二つが通れば使える。

```sh
for i in $(seq 1 120); do curl -fsS http://127.0.0.1:5173/api/me >/dev/null 2>&1 && break; sleep 5; done
(
  set -eu
  api=http://127.0.0.1:5173/api
  headers=(-H 'origin: http://127.0.0.1:5173' -H 'content-type: application/json')
  project=$(curl -fsS "${headers[@]}" "$api/projects" -d '{"requestId":"a2e54e37-3687-4dbd-a8cd-b2813b114d69","name":"起動確認"}')
  pattern=$(jq -er '.pattern.id' <<< "$project")
  accepted=$(curl -fsS "${headers[@]}" "$api/patterns/$pattern/messages" \
    -d "{\"requestId\":\"$(uuidgen)\",\"body\":\"起動確認\"}")
  job=$(jq -er '.job.jobId' <<< "$accepted")
  for i in {1..210}; do
    state=$(curl -fsS "$api/patterns/$pattern/state")
    if jq -e --arg job "$job" '.lastFinishedJob.jobId == $job' <<< "$state" >/dev/null; then
      revision=$(jq -er '.lastFinishedJob | select(.state == "completed") | .revision.id' <<< "$state")
      curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$api/revisions/$revision/view"
      exit
    fi
    sleep 2
  done
  echo "Job $job timed out" >&2
  exit 1
)
```

二つ目が `200 application/vnd.madori.display; version=1` なら、5173 番で受け付けた指示がジョブとしてパターンの Durable Object と Container まで届き、確定した案の表示データを取得できた。Container の起動待ちは最大 60 秒。`$EVIDENCE/dev.log` に `Container image(s) ready` と `Ready on http://127.0.0.1:8787` が出ないまま 10 分過ぎたら、ログの末尾を報告して止まる。

## 状態確認

おかしいと思ったら、まず次を実行する。読むだけで、何も変えない。ただし `/api/me` は、初めて来た利用者の行を作る。

```sh
kill -0 -- "-$(cat "$EVIDENCE/dev.pgid")" && echo "dev: running" || echo "dev: stopped"
lsof -nP -iTCP:8787 -iTCP:5173 -sTCP:LISTEN | tail -n +2 | tr -s ' ' | cut -d ' ' -f 1,2,9
curl -sS http://127.0.0.1:8787/api/health; echo
curl -sS http://127.0.0.1:5173/api/me; echo
git rev-parse HEAD
```

期待する結果は次のとおり。`dev: running`。`node` が 5173 番、`workerd` が 8787 番で LISTEN。`{"status":"ok","service":"worker"}`。`user.email` が `dev@example.com` の応答。確かめたい head。

## 操作

- 画面は T3 のプレビューで操作する。`preview_open` に `target: { kind: "environment-port", port: 5173 }`、`open: false`、`reuseExistingTab: false` を渡し、返った `tabId` だけを操作する。このプレビューの Chromium は WebGPU を使える。
- 要素の ref は、`save` を付けない `preview_snapshot` の `accessibilityTree` から取る。新しい snapshot を撮ると、`save: true` でも前の ref は無効になる。操作の直前に ref を取り直す。
- API は 5173 番のプロキシへ `curl` で送る。プロキシが、開発者として署名したトークンを付ける。8787 番へ直接送ると、認証が要る経路は 401 になる。`/api/health` は認証なしで応答し、未知の経路は 404、許していないメソッドは 405 になる。
- GET 以外の要求には `origin: http://127.0.0.1:5173` を付ける。付けないと、CSRF の防御で `403 forbidden` になる。
- 書き込みを伴う要求の `requestId` は `uuidgen` で作る。
- 別の利用者として試すときは、片付けてから `MADORI_DEV_EMAIL=other@example.com` を付けて起動し直す。同じ worktree なら、ローカルの D1 の中身は残る。
- Rust と Wasm を変えたら、片付けてから起動し直す。TypeScript の変更は動いたまま反映される。

## 証拠

- 利用者の操作と、その結果の状態を両方残す。最後の画面だけでは足りない。
- 画面は、操作の前後で `preview_snapshot` に `save: true` を付けて撮り、返った `screenshotPath` を `$EVIDENCE/<機能>/` に写す。変化は二枚の `shasum -a 256` の違いで示し、絵は Read で開いて目で確かめる。ページのスクロールでもハッシュは変わるので、絵を見ずに変化を報告しない。
- Issue、PR、検証記録に画面を貼るときは、AGENTS.md「Issue と PR の画像」のとおり、`$EVIDENCE` の画像を `pnpm images:upload` で `images` に上げ、出力された Markdown を貼る。
- API は、状態コードと応答本文をファイルに残す（`curl -sS -o "$EVIDENCE/<機能>/<手順>.json" -w '%{http_code}\n'`）。
- 書き込みは、別の読み出し（一覧や状態）でもう一度確かめる。
- テスト専用の入口や内部の関数ではなく、利用者が通る経路で確かめる。合成したイベントで確かめたものは、そう書く。
- 通れなかった経路は、試したコマンドと欠けていた前提を報告する。別の経路で確かめたものを、その経路で確かめたと書かない。

## 片付け

自分が起動したものだけを止める。プロセス名で kill しない。証拠は消さない。

```sh
kill -INT -- "-$(cat "$EVIDENCE/dev.pgid")"
for i in $(seq 1 60); do lsof -nP -iTCP:8787 -iTCP:5173 -sTCP:LISTEN >/dev/null || break; sleep 1; done
sleep 3
docker ps -a --format '{{.Names}}' | grep '^workerd-' | sort >| "$EVIDENCE/containers-after.txt"
comm -13 "$EVIDENCE/containers-before.txt" "$EVIDENCE/containers-after.txt" | xargs -r docker rm --force
```

Wrangler は終了時に形状の Container を消すが、この回の `-proxy` の Container を残す。最後の行は、起動の前に無かった Container だけを消す。片付けの後、二つのポートが空き、`kill -0` がグループを見つけないことを確かめる。開いたプレビューのタブは `t3_preview_close` で閉じる。終わったら `$EVIDENCE` の場所を報告する。

## マージの後に staging を確かめる

main へマージすると、staging へ自動でデプロイされる。ブランチを試すときに workflow を手で実行する方法は、README「stagingへデプロイする」にある。マージの後は、まずデプロイの実行を確かめる。

```sh
gh run list --workflow deploy-staging.yml --commit "$MERGE_SHA" --json status,conclusion,url
```

同じ疎通の確認を手元から行うときは、メインのチェックアウトの `.env` を渡す。値は表示しない。

```sh
mise exec -- node --env-file="$MAIN/.env" scripts/check/staging-smoke.ts
```

`Staging smoke passed: <Origin>` が出れば通っている。staging の画面は Access のログインが要り、このスキルにはまだその手順が無い。画面の確認が要るときは、確かめられなかったこととして報告する。

### 検証用の利用者で指示を止める

staging の `JOB_TEST_HOLD` は `before_render:180` なので、検証用の利用者（`staging:verifier`）のジョブは、実行権を取った後、描画の前に180秒待つ。ほかの利用者のジョブは待たない。検証用の利用者で指示の結果まで確かめる手順は、終わるまでに3分以上かかる。

この待ちの間に止めて、案が増えないことと、state の `lastFinishedJob` が `cancelled` を返すことを確かめる。service token の値を表示せず、コマンドの引数にもファイルにも出さないよう、ヘッダーはシェルの変数に持ち、組み込みの `printf` から curl の `-H @-` へ標準入力で渡す。シェルの関数と変数は、道具の呼び出しをまたいで残らないことがあるので、下の各手順は一つのスクリプトで続けて実行する。案件は、疎通の確認と同じ作成の要求を送り直して得る。疎通の確認は検証用の利用者の案件が一件であることを確かめるので、新しい案件は作らない。

```sh
STG=https://instant-madori-staging.firpmnfiywl.workers.dev
J='content-type: application/json'
D="$EVIDENCE/staging-stop"; mkdir -p "$D"
HDRS=$(mise exec -- node --env-file="$MAIN/.env" -e 'process.stdout.write(`CF-Access-Client-Id: ${process.env.STAGING_ACCESS_CLIENT_ID}\nCF-Access-Client-Secret: ${process.env.STAGING_ACCESS_CLIENT_SECRET}\n`)')
c() { printf '%s\n' "$HDRS" | curl -sS -H @- "$@"; }
```

- **案件を得る。** `c -o "$D/project.json" -w '%{http_code}\n' -X POST "$STG/api/projects" -H "$J" -H "origin: $STG" -d '{"requestId":"7e54d9ae-4fd0-4c26-8c90-3c18ce1c64d5","name":"Staging smoke"}'`。`201`。`PID=$(jq -r .project.id "$D/project.json")` を設定する。
- **パターンを足す。** `body=$(printf '{"requestId":"%s","name":"%s"}' "$(uuidgen)" "停止の確認")` で `c -o "$D/pattern.json" -w '%{http_code}\n' -X POST "$STG/api/projects/$PID/patterns" -H "$J" -H "origin: $STG" -d "$body"`。`201`。`PAT=$(jq -r .pattern.id "$D/pattern.json")` を設定する。
- **送る。** `body=$(printf '{"requestId":"%s","body":"%s"}' "$(uuidgen)" "停止の確認")` で `c -o "$D/accept.json" -w '%{http_code}\n' -X POST "$STG/api/patterns/$PAT/messages" -H "$J" -H "origin: $STG" -d "$body"`。`202`。`JOB=$(jq -r .job.jobId "$D/accept.json")` を設定する。
- **待ちに入るのを待つ。** `for i in $(seq 1 60); do c -o "$D/state-0.json" "$STG/api/patterns/$PAT/state"; jq -e --arg j "$JOB" '.runningJob.jobId == $j' "$D/state-0.json" >/dev/null && break; sleep 1; done`。`runningJob.jobId` が `$JOB`。
- **止める。** `body=$(printf '{"requestId":"%s"}' "$(uuidgen)")` で `c -o "$D/stop.json" -w '%{http_code}\n' -X POST "$STG/api/jobs/$JOB/stop" -H "$J" -H "origin: $STG" -d "$body"`。`200` で、`outcome` が `stopped`、`job.state` が `cancelled`。同じ `$body` で出力先を `"$D/stop-replay.json"` にして送り直すと `200` で、`cmp "$D/stop.json" "$D/stop-replay.json"` が何も出さない。
- **state を読む。** `c -o "$D/state-1.json" "$STG/api/patterns/$PAT/state"`。`runningJob` と `currentRevision` が `null`、`lastFinishedJob.jobId` が `$JOB` で、`lastFinishedJob.state` が `cancelled`。
- **待ちが明けた後に読む。** 200秒おいて、state を `"$D/state-2.json"` に読み直し、`c -o "$D/revisions.json" -w '%{http_code}\n' "$STG/api/patterns/$PAT/revisions"` を実行する。state は `state-1` と同じで、`revisions` が `[]`。

### 検証用の利用者で待機列の保留を確かめる

実行中の指示を止めたときに待機中の指示があれば、待機列は保留になる。待ちの間に一件目を止め、二件目が動かないことを確かめてから再開し、二件目が完了して案が一件増えることを確かめる。二件目も描画の前に180秒待つので、終わるまでに4分ほどかかる。前の節と同じく、ヘッダーはシェルの変数に持ち、下の各手順は一つのスクリプトで続けて実行する。`STG`・`J`・`HDRS`・`c` は前の節のとおりに設定し、`D="$EVIDENCE/staging-hold"; mkdir -p "$D"` にする。

- **案件を得る。** 前の節と同じ要求で `PID` を設定する。
- **パターンを足す。** 前の節と同じ要求を、名前を `保留の確認`、出力先を `"$D/pattern.json"` にして送る。`201`。`PAT` を設定する。
- **二つ送る。** 前の節の「送る」を、本文を `保留の確認1` と `保留の確認2`、出力先を `"$D/accept-a.json"` と `"$D/accept-b.json"` にして続けて送る。どちらも `202`。`A=$(jq -r .job.jobId "$D/accept-a.json")` と `B=$(jq -r .job.jobId "$D/accept-b.json")` を設定する。
- **待ちに入るのを待つ。** 前の節と同じ繰り返しで、`runningJob.jobId` が `$A` になるのを待つ。出力先は `"$D/state-0.json"`。
- **止める。** 前の節と同じ要求を `$A` へ送り、出力先を `"$D/stop.json"` にする。`200` で、`outcome` が `stopped`。
- **保留を読む。** `c -o "$D/hold-1.json" "$STG/api/patterns/$PAT/state"`。`runningJob` が `null`、`queuedJobs` が `$B` の一件、`queueHold.job.jobId` が `$A` で `queueHold.job.state` が `cancelled`。
- **二件目が動かないことを確かめる。** 30秒おいて、state を `"$D/hold-2.json"` に読み直す。`runningJob`・`queuedJobs`・`queueHold` が `hold-1` と同じ。
- **再開する。** `body=$(printf '{"requestId":"%s","heldBy":"%s"}' "$(uuidgen)" "$A")` で `c -o "$D/resume.json" -w '%{http_code}\n' -X POST "$STG/api/patterns/$PAT/queue/resume" -H "$J" -H "origin: $STG" -d "$body"`。`200` で、`jobs` が `$B` の一件。同じ `$body` で出力先を `"$D/resume-replay.json"` にして送り直すと `200` で、`cmp "$D/resume.json" "$D/resume-replay.json"` が何も出さない。
- **二件目の完了を待つ。** `for i in $(seq 1 300); do c -o "$D/state-3.json" "$STG/api/patterns/$PAT/state"; jq -e --arg j "$B" '.lastFinishedJob.jobId == $j and .runningJob == null' "$D/state-3.json" >/dev/null && break; sleep 1; done`。`lastFinishedJob.state` が `completed`、`queueHold` が `null`、`queuedJobs` が `[]`。`c -o "$D/revisions.json" -w '%{http_code}\n' "$STG/api/patterns/$PAT/revisions"` は `200` で、`revisions` が一件、その `id` が `lastFinishedJob.revision.id`。

### 検証用の利用者で再デプロイをまたいで指示を完了させる

Worker と DO が再起動しても、待たせている指示は完了し、案は一件だけ増える。待ちの180秒の内に staging のデプロイが入るよう、同じ main の版を deploy-staging で起動し直し、その「Migrate and deploy」の段階が始まったときに送る。この段階は16〜31秒で終わった（2026-11 の15回の実行）。再デプロイの後も、動いている Workflow のインスタンスは作られたときの版のコードで続き、パターンの DO だけが新しい版で動き直す。前の節と同じく、ヘッダーはシェルの変数に持ち、下の各手順は一つのスクリプトで続けて実行する。`STG`・`J`・`HDRS`・`c` は前の節のとおりに設定し、`D="$EVIDENCE/staging-redeploy"; mkdir -p "$D"` にする。

- **案件を得る。** 前の節と同じ要求で `PID` を設定する。
- **パターンを足す。** 前の節と同じ要求を、名前を `再デプロイの確認`、出力先を `"$D/pattern.json"` にして送る。`201`。`PAT` を設定する。
- **デプロイを起動する。** `T0=$(date +%s)000` を設定し、`gh workflow run deploy-staging.yml --ref main`。指揮役が打つときは、打つ前に `T0` を設定し、受け取った run の ID を `RUN` に設定して、次の `RUN=` の行を飛ばす。10秒おいて `RUN=$(gh run list --workflow deploy-staging.yml --event workflow_dispatch --limit 1 --json databaseId,createdAt --jq '.[0].databaseId')` を設定し、`gh run view "$RUN" --json headSha,createdAt` の `headSha` が main の先頭であることを確かめる。
- **段階が始まるのを待つ。** `for i in $(seq 1 900); do s=$(gh run view "$RUN" --json status,jobs --jq '[.status, ((.jobs[0].steps // [])[] | select(.name == "Migrate and deploy") | .status)] | join(" ")'); case "$s" in *" in_progress") break;; completed*) echo "run ended: $s"; break;; esac; sleep 2; done`。`in_progress` で抜ける。`run ended` で抜けたら、実行の失敗を報告して止まる。
- **送る。** 前の節の「送る」を、本文を `再デプロイの確認`、出力先を `"$D/accept.json"` にして送る。`202`。`JOB` を設定する。
- **完了を待つ。** `for i in $(seq 1 600); do c -o "$D/state-1.json" "$STG/api/patterns/$PAT/state"; jq -e --arg j "$JOB" '.lastFinishedJob.jobId == $j and .runningJob == null' "$D/state-1.json" >/dev/null && break; sleep 1; done`。`lastFinishedJob.state` が `completed`。`c -o "$D/revisions.json" -w '%{http_code}\n' "$STG/api/patterns/$PAT/revisions"` は `200` で、`revisions` が一件、その `id` が `lastFinishedJob.revision.id`。`gh run view "$RUN" --json conclusion` が `success`。終わりを確かめた時刻を `DONE=$(date +%s)` で残す。
- **Workers Logs を読む。** Workers Logs の検索 API から、`T0` から今までのこのパターンの行を版つきで取り出す。トークンの値は表示しない。行は数分遅れて出るので、1分おきに読み直し、読むたびに下の順で判断する。読み直しの期限は `DONE` から10分とする。ふつうは確定の数秒後に `job.finished` と DO の `idle` が書かれるが、`wake pattern` の段階が再試行を使い切るまでには約7分かかり、#41 の確認では Workers Logs の行が2〜3分遅れて出たためである。

  ```sh
  T0=$T0 PAT=$PAT mise exec -- node --env-file="$MAIN/.env" -e '
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts/4a67230af28ec94d9c70ca48572d8e9f/workers/observability/telemetry/query", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ queryId: "adhoc", dry: true, view: "events", limit: 2000,
        timeframe: { from: Number(process.env.T0), to: Date.now() }, parameters: {} }),
    });
    const body = await res.json();
    if (!body.success) { console.error(JSON.stringify(body.errors)); process.exit(1); }
    for (const e of body.result.events.events.sort((a, b) => a.timestamp - b.timestamp)) {
      const s = typeof e.source === "object" ? e.source : {};
      if (s.patternId !== process.env.PAT) continue;
      console.log(JSON.stringify({ t: e.timestamp, version: e.$workers?.scriptVersion?.id ?? null,
        event: s.event, step: s.step, outcome: s.outcome, instanceStatus: s.instanceStatus }));
    }' >| "$D/logs.jsonl"
  ```

  1. 失敗の行が一つでもあれば、ほかの条件は見ずに不合格とし、その行を記録して終える。失敗の行は、`pattern.advance_failed`、`outcome` が `failed` か `stalled` の `pattern.advanced`、`outcome` が `committed` でない `job.finished` である。照合はこれらの後も次のアラームを予約するので、照合が止まった証拠ではない。この確認が合格にならない証拠である。
  2. `job.finished` と、`outcome` が `idle` の `pattern.advanced`（版は問わない）の両方がそろうまで読み直す。二つのどちらが先に届くかは決まっていない。期限を過ぎてもそろわなければ、足りない行を記録して不合格とする。たとえば、確定の後に `wake pattern` が再試行を使い切ると、Workflow は `job.finished` を書かずに終わる。
  3. そろったら版を見る。`pattern.advanced` が一つの版だけなら、DO の版の切り替えを確かめられなかったので、新しいパターンでこの節をやり直す。動いている DO が新しい版に移るまでには、待ちの180秒より長くかかることがある。
  4. 二つの版があれば、次のすべてを満たすと合格、一つでも欠ければ不合格である。
  - 最初の `pattern.advanced` は古い版の `claimed`、最後は新しい版の `idle`。
  - 新しい版の `pattern.advanced` は `running` で `instanceStatus` を持ち、約30秒ごとに出る。
  - `job.step` の `check test hold before render` は、新しい版の最初の `pattern.advanced` より前にある。
  - `job.step` と `job.finished` は待ちを始めた古い版のままである。`idle` と `job.finished` の前後は問わない。
