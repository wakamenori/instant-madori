---
name: verify-madori
description: instant-madori を利用者と同じ経路で動かし、振る舞いの証拠を残す。自分の worktree で、ほかの worktree と重ならないポートに起動した画面（WebGPU で描くサンプル）を T3 のプレビューで操作し、Vite のプロキシ経由で Worker API を呼び、その奥の形状 Container まで通す。マージの後は staging を確かめる。変更を本物のアプリで確かめるとき、PR の head を検証するとき、テストでは見えない振る舞いを確かめるときに使う。
---

# instant-madori を確かめる

機能ごとの手順は [features/README.md](features/README.md) にある。このファイルには、どの機能にも共通する準備、起動、状態確認、操作、証拠、片付けを書く。

## 自分のポートで動かす

このスキルでは、`pnpm dev` を `MADORI_DEV_PORTS=auto` を付けて起動する。`pnpm dev` が画面（Vite）と Worker のポートを 20000〜32767 番の空いている番号から選ぶので、ほかの worktree の担当や検証役と同時に動かせる。何も指定しないときの 5173 番と 8787 番は、利用者のために空けておく。選んだポートは `dev.log` の `Web: http://127.0.0.1:<画面のポート> | Worker: http://127.0.0.1:<Worker のポート>` の行に出る。起動の確認がこの行を `$EVIDENCE/dev.env` に書き、以後の手順はそこからポートを読む。自分で起動していないインスタンスは操作しない。

同じ worktree では、`pnpm dev` は同時に一つしか起動できない。二つ目は `pnpm dev is already running in this checkout (pid <pid>)` で止まる。起動し直すときは、先に片付ける。

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
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm setup
```

ディスクの空きを 20 GiB 以上に保つ（`df -h /`）。複製した `target` は、`du` では複製元と同じ大きさに見える。空きは `df` で確かめる。

## 起動

証拠の置き場を worktree の外に作る。worktree の中に置いた未追跡のファイルは、`pnpm check` の整形と lint に巻き込まれる。Claude Code ならシステムプロンプトにあるスクラッチパッドの下、それ以外なら `$TMPDIR` の下にする。名前は `pr-<番号>-<head の先頭7文字>` か `<ブランチ>-<head の先頭7文字>` にする。

```sh
EVIDENCE="<スクラッチパッド>/verify-madori/<名前>"
mkdir -p "$EVIDENCE"
```

検証する機能がすべて Container 不要なら、次の `perl` の行の先頭に `MADORI_DEV_CONTAINERS=0 ` を足して起動する。この起動は Docker の枠を取らないので、ほかの担当の `pnpm check --full` や実 Container の試験がこの起動のために待たずに済む。`dev.log` に `[docker-slot]` の行は出ない。`node scripts/shared/docker-slots.ts status` にも、この worktree が使う枠は出ない。

Bash ツールの `run_in_background` で、新しいプロセスグループとして起動する。片付けでは、このグループに Ctrl-C と同じ SIGINT を送るので、グループの番号を残す。`set -m` はこの zsh では使えない。

```sh
MADORI_DEV_PORTS=auto perl -e 'setpgrp(0, 0); exec @ARGV or die "exec: $!"' mise exec -- pnpm dev >| "$EVIDENCE/dev.log" 2>&1 &
echo $! >| "$EVIDENCE/dev.pgid"
wait
```

`pnpm dev` は Wasm と Web をビルドしてから、ポートを選んで `Web: … | Worker: …` の行を出し、ローカルの D1 にマイグレーションを当てる。Container を有効にしていれば、マシン全体で共有する Docker の枠（AGENTS.md「検査と引き継ぎ」）を取ってから、選んだポートで Worker と Vite を起動する。枠が埋まっている間は、`dev.log` に `[docker-slot] <時刻> waiting …` の行を一分ごとに出して待ち、取れたら `[docker-slot] <時刻> acquired …` を出す。待つのは正常な動作なので、止めずに待つ。初回は amd64 イメージのビルドに数分かかる。Container が有効なら、次の二つが通れば使える。

一つ目の繰り返しは、`Web: … | Worker: …` の行から `$EVIDENCE/dev.env` を作り直し、`WEB_PORT`・`WORKER_PORT`・`API`・`O` を読む。自分の `dev.log` に、Worker の `Ready on http://127.0.0.1:<Worker のポート>` と Vite の `Local:   http://127.0.0.1:<画面のポート>/` が出るまでは、`curl` を送らない。どちらの行も、そのポートを取れたときだけ出る。ほかの回が先に同じポートを取っていれば、自分の Vite か Worker が起動に失敗して `pnpm dev` が終わり、繰り返しはログの末尾を出して止まる。`curl` だけで待つと、ほかの回のアプリの応答で通ってしまう。枠を待っている間（`waiting` の行があり、`acquired` の行がまだ無い間）の試行は数えない。

```sh
tries=0
while :; do
  kill -0 -- "-$(cat "$EVIDENCE/dev.pgid")" 2>/dev/null || { echo "pnpm dev exited" >&2; tail -n 30 "$EVIDENCE/dev.log" >&2; exit 1; }
  sed -nE 's#^Web: http://127\.0\.0\.1:([0-9]+) \| Worker: http://127\.0\.0\.1:([0-9]+)$#WEB_PORT=\1 WORKER_PORT=\2 API=http://127.0.0.1:\1/api O="origin: http://127.0.0.1:\1"#p' "$EVIDENCE/dev.log" | head -n 1 >| "$EVIDENCE/dev.env"
  if [ -s "$EVIDENCE/dev.env" ]; then
    . "$EVIDENCE/dev.env"
    if grep -qE "Ready on http://127\.0\.0\.1:$WORKER_PORT([^0-9]|\$)" "$EVIDENCE/dev.log" && grep -qE "Local: +http://127\.0\.0\.1:$WEB_PORT/" "$EVIDENCE/dev.log" && curl -fsS "$API/me" >/dev/null 2>&1; then break; fi
  fi
  [ "$tries" -ge 120 ] && { echo "not ready" >&2; tail -n 30 "$EVIDENCE/dev.log" >&2; exit 1; }
  if grep -q '\[docker-slot\] [0-9:]* waiting ' "$EVIDENCE/dev.log" && ! grep -q '\[docker-slot\] [0-9:]* acquired ' "$EVIDENCE/dev.log"; then :; else tries=$((tries + 1)); fi
  sleep 5
done
cat "$EVIDENCE/dev.env"
(
  set -eu
  api=$API
  headers=(-H "$O" -H 'content-type: application/json')
  project=$(curl -fsS "${headers[@]}" "$api/projects" -d '{"requestId":"a2e54e37-3687-4dbd-a8cd-b2813b114d69","name":"起動確認"}')
  pattern=$(jq -er '.pattern.id' <<< "$project")
  accepted=$(curl -fsS "${headers[@]}" "$api/patterns/$pattern/messages" \
    -d "{\"requestId\":\"$(uuidgen)\",\"body\":\"起動確認\"}")
  job=$(jq -er '.job.jobId' <<< "$accepted")
  for i in {1..210}; do
    state=$(curl -fsS "$api/patterns/$pattern/state")
    if jq -e --arg job "$job" '.lastFinishedJob.jobId == $job' <<< "$state" >/dev/null; then
      job_state=$(jq -r '.lastFinishedJob.state' <<< "$state")
      if [ "$job_state" != completed ]; then
        echo "Job $job $job_state" >&2
        grep -F "\"jobId\":\"$job\"" "$EVIDENCE/dev.log" | grep -F '"event":"job.finished"' | tail -n 1 >&2
        exit 1
      fi
      revision=$(jq -er '.lastFinishedJob.revision.id' <<< "$state")
      curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$api/revisions/$revision/view"
      exit
    fi
    sleep 2
  done
  echo "Job $job timed out" >&2
  exit 1
)
```

`cat` が出す `WEB_PORT` と `WORKER_PORT` が、この回のポートである。二つ目が `200 application/vnd.madori.display; version=1` なら、自分の画面のポートで受け付けた指示がジョブとしてパターンの Durable Object と Container まで届き、確定した案の表示データを取得できた。Container の起動待ちは最大 60 秒。`$EVIDENCE/dev.log` に `Container image(s) ready` と `Ready on http://127.0.0.1:<Worker のポート>` が、枠を取ってから 10 分過ぎても出なければ、ログの末尾を報告して止まる。枠を待っている間は、`waiting` の行に枠を持つプロセスの目的、pid、経過時間、チェックアウトが出る。長く待つときは、その行を指揮役に伝える。

Container を無効にしても一つ目の確認は通る。二つ目は `Job <id> failed` と `"reason":"containers_disabled"` を含む `job.finished` の行を出し、終了コード 1 で終わる。これがこの起動の期待する結果である。理由が異なる場合や確認できない場合、または Container が有効なのに同じ出力が出た場合は、起動確認の失敗とする。

## 状態確認

おかしいと思ったら、まず次を実行する。読むだけで、何も変えない。ただし `/api/me` は、初めて来た利用者の行を作る。

```sh
. "$EVIDENCE/dev.env"
kill -0 -- "-$(cat "$EVIDENCE/dev.pgid")" && echo "dev: running" || echo "dev: stopped"
lsof -nP -iTCP:"$WEB_PORT" -iTCP:"$WORKER_PORT" -sTCP:LISTEN | tail -n +2 | tr -s ' ' | cut -d ' ' -f 1,2,9
curl -sS "http://127.0.0.1:$WORKER_PORT/api/health"; echo
curl -sS "$API/me"; echo
git rev-parse HEAD
```

期待する結果は次のとおり。`dev: running`。`node` が `127.0.0.1:$WEB_PORT`、`workerd` が `127.0.0.1:$WORKER_PORT` で LISTEN し、ほかのプロセスがこの二つのポートにいない。`{"status":"ok","service":"worker"}`。`user.email` が `dev@example.com` の応答。確かめたい head。

## 操作

- Bash の呼び出しごとに、初めに `. "$EVIDENCE/dev.env"` を実行して `WEB_PORT`・`WORKER_PORT`・`API`・`O` を読む。シェルの変数は、呼び出しをまたいで残らない。
- 画面は T3 のプレビューで操作する。`preview_open` に `target: { kind: "environment-port", port: <WEB_PORT> }`、`open: false`、`reuseExistingTab: false` を渡し、返った `tabId` だけを操作する。`<WEB_PORT>` には、起動の確認の `cat` が出した番号を書く。プレビューは `http://localhost:<WEB_PORT>` を開く。このプレビューの Chromium は WebGPU を使える。
- 要素の ref は、`save` を付けない `preview_snapshot` の `accessibilityTree` から取る。新しい snapshot を撮ると、`save: true` でも前の ref は無効になる。操作の直前に ref を取り直す。
- `preview_snapshot` が `The browser is not producing screenshot frames` で失敗するときは、T3 の窓が隠れているか最小化されている。`preview_evaluate` と `preview_act` はそのまま動く。要素は ref の代わりに、`preview_act` の `locator` へ `role=button[name="もう一度送る"]` の形で役割と名前を渡して指せる。スクリーンショットは撮れないので、利用者に窓を戻してもらうか、画面の絵を確かめられなかったこととして報告する。
- API は画面のポートのプロキシ（`$API`）へ `curl` で送る。プロキシが、開発者として署名したトークンを付ける。Worker のポート（`http://127.0.0.1:$WORKER_PORT`）へ直接送ると、認証が要る経路は 401 になる。`/api/health` は認証なしで応答し、未知の経路は 404、許していないメソッドは 405 になる。
- GET 以外の要求には `-H "$O"`（自分の画面の Origin）を付ける。付けないと、CSRF の防御で `403 forbidden` になる。Worker が受け付ける Origin は、この回の画面のポートを `127.0.0.1` と `localhost` で書いた二つだけで、ほかの回の画面の Origin も `403` になる。
- 書き込みを伴う要求の `requestId` は `uuidgen` で作る。
- 別の利用者として試すときは、片付けてから `MADORI_DEV_EMAIL=other@example.com` を付けて起動し直す。同じ worktree なら、ローカルの D1 の中身は残る。
- Rust と Wasm を変えたら、片付けてから起動し直す。TypeScript の変更は動いたまま反映される。
- 起動し直すとポートが変わる。起動し直したら、起動の確認をもう一度実行して `dev.env` を作り直し、プレビューも新しい `WEB_PORT` で開き直す。

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

止める前に、指示を流したパターンに実行中の指示が残っていないことを確かめる。ローカルの `wrangler dev` では、止めた時点で動いていた Workflow は起動し直しても再開しない。その指示は `running` のまま残り、同じパターンへの後の指示はすべて待機中のまま動かない。残っていたら、終わるまで待つか、[指示を止める](features/stop.md)の手順で止めてから片付ける。

```sh
kill -INT -- "-$(cat "$EVIDENCE/dev.pgid")"
for i in $(seq 1 60); do kill -0 -- "-$(cat "$EVIDENCE/dev.pgid")" 2>/dev/null || break; sleep 1; done
sed -nE 's#^Web: http://127\.0\.0\.1:([0-9]+) \| Worker: http://127\.0\.0\.1:([0-9]+)$#WEB_PORT=\1 WORKER_PORT=\2 API=http://127.0.0.1:\1/api O="origin: http://127.0.0.1:\1"#p' "$EVIDENCE/dev.log" | head -n 1 >| "$EVIDENCE/dev.env"
if [ -s "$EVIDENCE/dev.env" ]; then
  . "$EVIDENCE/dev.env"
  for i in $(seq 1 60); do lsof -nP -iTCP:"$WEB_PORT" -iTCP:"$WORKER_PORT" -sTCP:LISTEN >/dev/null || break; sleep 1; done
fi
sleep 3
grep -oE 'containerName = workerd-[0-9a-f]{16}-' "$EVIDENCE/dev.log" | sed -E 's/^containerName = workerd-//; s/-$//' | sort -u >| "$EVIDENCE/container-sessions.txt"
case $(wc -l < "$EVIDENCE/container-sessions.txt" | tr -d ' ') in
  0) ;;
  1) docker ps -aq --filter "label=dev.workerd.session=$(cat "$EVIDENCE/container-sessions.txt")" | xargs -r docker rm --force ;;
  *) echo "Several Container sessions in dev.log; removed nothing:" >&2; cat "$EVIDENCE/container-sessions.txt" >&2 ;;
esac
```

workerd は Container を作るたびに、`dev.log` へ `containerName = workerd-<ID>-instant-madori-GeometryContainer-…` の警告を書く。`<ID>` はこの回の `pnpm dev` のセッションの ID で、その Container と `-proxy` には `dev.workerd.session=<ID>` のラベルが付く。Wrangler は終了時にこのラベルの Container を消す。最後の `case` は、ID が一つのときだけその消し残しを消す。TypeScript の変更で Worker を読み込み直しても、ID は変わらない。ID が二つ以上出たら、`dev.log` にほかのセッションの行が混ざったか、Container の設定が変わって Wrangler が別のセッションを始めたので、何も消さずに候補を報告して止まる。片付けは、プロセスグループが消えるのを待ってから、`dev.log` の `Web: … | Worker: …` の行からこの回のポートを読み直す。起動の確認を一度も通していなくても、自分のポートを確かめられる。この行が無ければ、`pnpm dev` はポートを選ぶ前に止まっていて、何も待ち受けていない。片付けの後、`dev.env` の二つのポートが空き、`kill -0` がグループを見つけないことを確かめる。開いたプレビューのタブは `t3_preview_close` で閉じる。終わったら `$EVIDENCE` の場所を報告する。

## マージの後に staging を確かめる

main へマージすると、staging へ自動でデプロイされる。ただし、変えたファイルがすべて `deploy-staging.yml` の `paths-ignore`（`.claude/` や `docs/` の下など）に入るマージでは、デプロイは起きない。staging は前にデプロイしたコミットのまま残る。ブランチを試すときに workflow を手で実行する方法は、README「stagingへデプロイする」にある。マージの後は、まずデプロイの実行を確かめる。

```sh
gh run list --workflow deploy-staging.yml --commit "$MERGE_SHA" --json status,conclusion,url
```

`[]` が返ったら、そのマージはデプロイを起こしていない。staging で確かめるのは、前にデプロイした版の振る舞いになる。

計画6.1bの障害の試験（再送、確定の後と待ちの間の停止、再デプロイをまたぐ指示、保留と再開）をまとめて行うときは、下の節を一つずつ動かさず、README「stagingへデプロイする」の `scripts/check/staging-faults/main.ts` を使う。このスクリプトは、指揮役が起動した再デプロイの run を受け取って動く。

同じ疎通の確認を手元から行うときは、メインのチェックアウトの `.env` を渡す。値は表示しない。

```sh
mise exec -- node --env-file="$MAIN/.env" scripts/check/staging-smoke.ts
```

`Staging smoke passed: <Origin>` が出れば通っている。staging の画面は Access のログインが要り、このスキルにはまだその手順が無い。画面の確認が要るときは、確かめられなかったこととして報告する。

### 冷えた起動の Container のログを確かめる

接続用 DO の呼び出しは、操作が終わると閉じる。Workers Logs は、呼び出しのログを呼び出しが終わってから載せる。そのため、冷えた起動の `container.started` と `container.ready` は、その描画が終わってから1分ほどで検索できる。休止（10分）の後まで見えなければ、呼び出しが閉じていない。

パターンごとに接続用 DO と Container が分かれるので、新しいパターンへの最初の指示は必ず冷えた起動になる。検証用の利用者のジョブは描画の前に180秒待つので、終わるまでに4分ほどかかる。ログは Workers Logs の検索 API で読む。メインのチェックアウトの `.env` の `CLOUDFLARE_API_TOKEN` で読める。値は表示しない。下の各手順は一つのスクリプトで続けて実行する。

```sh
STG=https://instant-madori-staging.firpmnfiywl.workers.dev
ACCOUNT=4a67230af28ec94d9c70ca48572d8e9f
J='content-type: application/json'
D="$EVIDENCE/staging-cold-logs"; mkdir -p "$D"
HDRS=$(mise exec -- node --env-file="$MAIN/.env" -e 'process.stdout.write(`CF-Access-Client-Id: ${process.env.STAGING_ACCESS_CLIENT_ID}\nCF-Access-Client-Secret: ${process.env.STAGING_ACCESS_CLIENT_SECRET}\n`)')
AUTH=$(mise exec -- node --env-file="$MAIN/.env" -e 'process.stdout.write(`Authorization: Bearer ${process.env.CLOUDFLARE_API_TOKEN}\n`)')
c() { printf '%s\n' "$HDRS" | curl -sS -H @- "$@"; }
logs() {
  body=$(jq -n --arg k "${1}" --arg v "${2}" --argjson from "$(( (SENT - 60) * 1000 ))" --argjson to "$(( $(date +%s) * 1000 ))" \
    '{queryId: "adhoc", dry: true, view: "events", limit: 100, timeframe: {from: $from, to: $to},
      parameters: {filters: [{key: "$metadata.service", operation: "eq", type: "string", value: "instant-madori-staging"},
        {key: $k, operation: "eq", type: "string", value: $v}]}}')
  printf '%s\n' "$AUTH" | curl -sS -H @- -H 'content-type: application/json' -X POST \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/observability/telemetry/query" -d "$body"
}
```

- **案件を得る。** 「検証用の利用者で指示を止める」と同じ作成の要求を、出力先を `"$D/project.json"` にして送る。`201`。`PID=$(jq -r .project.id "$D/project.json")` を設定する。
- **パターンを足す。** `body=$(printf '{"requestId":"%s","name":"%s"}' "$(uuidgen)" "冷えた起動の確認")` で `c -o "$D/pattern.json" -w '%{http_code}\n' -X POST "$STG/api/projects/$PID/patterns" -H "$J" -H "origin: $STG" -d "$body"`。`201`。`PAT=$(jq -r .pattern.id "$D/pattern.json")` を設定する。
- **送る。** `SENT=$(date +%s)` を設定し、`body=$(printf '{"requestId":"%s","body":"%s"}' "$(uuidgen)" "冷えた起動の確認")` で `c -o "$D/accept.json" -w '%{http_code}\n' -X POST "$STG/api/patterns/$PAT/messages" -H "$J" -H "origin: $STG" -d "$body"`。`202`。`JOB=$(jq -r .job.jobId "$D/accept.json")` を設定する。
- **ジョブの完了を待つ。** `for i in $(seq 1 360); do c -o "$D/state.json" "$STG/api/patterns/$PAT/state"; jq -e --arg j "$JOB" '.lastFinishedJob.jobId == $j and .runningJob == null' "$D/state.json" >/dev/null && break; sleep 1; done; DONE=$(date +%s)`。`lastFinishedJob.state` が `completed`。
- **ログが届くのを待つ。** `for i in $(seq 1 18); do logs traceId "$JOB" >| "$D/trace.json"; jq -e '[.result.events.events[] | select(.source.event? == "container.ready")] | length > 0' "$D/trace.json" >/dev/null && break; sleep 10; done; echo "$(( $(date +%s) - DONE )) s"`。3分以内に止まる。`jq -r '.result.events.events[] | [.source.event // "", .source.mode // ""] | @tsv' "$D/trace.json" | grep container` に、`container.started` と、`cold` の `container.ready` が出る。
- **呼び出しの長さを読む。** `RID=$(jq -r '[.result.events.events[] | select(.source.event? == "container.ready")][0]["$metadata"].requestId' "$D/trace.json")` を設定し、`logs '$metadata.requestId' "$RID" >| "$D/invocation.json"; jq '[.result.events.events[] | select(.["$metadata"].type == "cf-worker-event")][0]["$workers"].wallTimeMs' "$D/invocation.json"`。数千 ms で、30,000 や 600,000 ではない。

`container.ready` が3分で出なければ、描画の10分後より後にもう一度 `logs traceId "$JOB"` を読む。そこで初めて出て、呼び出しの `wallTimeMs` が休止時間に近ければ、呼び出しが Container の休止まで閉じていない。

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

Worker と DO が再起動しても、待たせている指示は完了し、案は一件だけ増える。待ちの180秒の内に staging のデプロイが入るよう、同じ main の版を deploy-staging で起動し直し、その「Migrate and deploy」の段階が始まったときに送る。この段階は十数秒から1分ほどで終わる（2026-11-20 の成功した5回で13〜56秒）。再デプロイの後も、動いている Workflow のインスタンスは作られたときの版のコードで続き、パターンの DO だけが新しい版で動き直す。前の節と同じく、ヘッダーはシェルの変数に持ち、下の各手順は一つのスクリプトで続けて実行する。`STG`・`J`・`HDRS`・`c` は前の節のとおりに設定し、`D="$EVIDENCE/staging-redeploy"; mkdir -p "$D"` にする。

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
  - 待ちの間（新しい版の最初の `pattern.advanced` から最後の `idle` の前まで）に、新しい版で `outcome` が `running` で `instanceStatus` を持つ `pattern.advanced` が約30秒ごとに出る。最後の `idle` の行は `instanceStatus` を持たない。
  - `job.step` の `check test hold before render` は、新しい版の最初の `pattern.advanced` より前にある。
  - `job.step` と `job.finished` は待ちを始めた古い版のままである。`idle` と `job.finished` の前後は問わない。
