---
name: madori-owner
description: instant-madori の Issue 一つを担当として進める。自分の worktree で Issue を読み、設計を決め、実装を Codex に任せ、本物のアプリで確かめて PR を出し、指揮役に報告する。指揮役から `/madori-owner #<番号> 報告先 <threadId>` で呼ばれたときに使う。
---

# Issue の担当として進める

pstack の poteto-mode に従い、Issue に合う playbook で進める。多くは Feature か Bug fix になる。このファイルには、このリポジトリと T3 で違うところと、指揮役との受け渡しだけを書く。

poteto-mode は Skill ツールでは起動できない。Skill ツールを試さず、ほかの作業の前に、次のコマンドが出す `SKILL.md` を全部読んで従う。このコマンドは、Claude Code が `installed_plugins.json` に記録した pstack のうち、このリポジトリ（worktree か本体）に入れた `local`、`project` の版を、無ければ `user` の版を選ぶ。見つからなければ0以外で終わるので、そのときは指揮役に報告して止まる。

```sh
node .claude/skills/madori-coordinator/scripts/poteto-mode.mjs
```

引数は、Issue の番号と、報告先である指揮役のスレッドの ID。

## 準備

1. T3 が origin/main から作った、自分の worktree で作業する。ほかのブランチや Issue に触らない。
2. Issue をコメントまで読み（`gh issue view <番号> --json title,body,comments`）、それが指す plan.md の節を読む。依存の欄の Issue がすべて閉じているか確かめる。開いていれば、指揮役に報告して止まる。
3. [verify-madori](../verify-madori/SKILL.md) の「準備」のとおりに準備する。ディスクが足りずにビルドが失敗したら、worktree の外を消さずに指揮役に報告する。

## シェルで止まらない

シェルのコマンドの承認は T3 の画面からしか出せず、出るまで止まる。次の書き方を守る。

- 一行に一つのパスがあり空行の無い一覧を、パスごとに一つの引数として渡すときは、`tr '\n' '\0' < <一覧> | xargs -0 <コマンド>` を使う。オプションを取るコマンドでは、`tr '\n' '\0' < <一覧> | xargs -0 wc -l --` のようにパスの前に `--` を置き、`-` で始まるパスをオプションとして読ませない。`$(cat <一覧>)` と `-0` の無い `xargs` は、空白や引用符を含むパスを分ける。zsh のフラグ付きの展開（`${(f)…}`、`${(s.:.)…}`）を書かない。Claude Code はこのコマンドを読み切れないとして、拒むか承認を求める。拒まれたら、何も消さないコマンドは、bash と zsh の両方で読める書き方に直して送り直す。
- 消すときは `command rm -r -- <パス>` を使う。Claude Code の Bash では `rm` が `rm -i` の別名で、何も消さずに続く。Codex は `-f` の付いた `rm` で承認を求めるので、`rm -f` と `rm -rf` を使わない。
- 長い検査を裏で動かしたら、`t3_background_wait` にその ID を渡し、結果を読んでからターンを終える。

## 設計を決める

Issue の範囲に「PRで決めること」があれば、コードを書く前に設計を決める。

- poteto-mode のとおりに architect で案を出し、`/pstack:interrogate` にかけて決める。指揮役の返事は待たない。
- 決めた設計、比べた案、選んだ理由を、PR の本文の Tradeoffs に書く。

## subagent の worktree を消す

Agent ツールに `isolation: "worktree"` を付けて立てた subagent（interrogate の反対役、architect の arena の候補）の worktree は、メインのチェックアウトの `.claude/worktrees/agent-<id>` にできる。subagent が再現のファイルなどの変更を残すと、Claude Code はこの worktree を消さない。見回りの片付けも、作られてから24時間を過ぎたものしか消さない。立てた担当が、使い終えたときに消す。

- subagent の終わりの通知に `<worktreePath>` があれば、そのパスを控える。無ければ、Claude Code がもう消している。
- interrogate では Verify を、architect では arena の Phase F を終えてから消す。全員の結果を使い終えるまで、先に終わった subagent の worktree も残す。残したい再現は、消す前に自分の worktree へ移す。
- 控えたパスごとに、パスを書き込んだ次のコマンドを打つ。

  ```sh
  node .claude/skills/madori-coordinator/scripts/worktrees.mjs agent <パス>
  ```

  - 0で終われば、worktree は消えたか、もう無い。捨てた未コミットの変更は、標準エラーに `discard` の行で出る。
  - 1で終わったら、理由が出て、worktree は残る。subagent がまだ動いている（`running`）なら、終わりの通知を待ってから打ち直す。ほかの理由なら、指揮役への報告に書く。

- 自分の通知に出たパスだけを渡す。ほかの担当は、終わった subagent の worktree をまだ使っているかもしれない。

## 実装を Codex に任せる

- コードは Codex に書かせる。`delegate_task` の `target` を `{providerInstanceId: "codex", model: <モデル>, options: {reasoningEffort: <effort>}}` にし、`reasoningEffort` を省かない。自分の worktree で書かせ、`isolation` は付けない。
- モデルと基準の effort は、[pstack-models.md](../../rules/pstack-models.md) のうち、進めている playbook の行（`feature, refactoring`、`bug-fix`、`perf-issue`、`hillclimb`）から取る。該当する playbook の行が無いときは、`feature, refactoring` の行を使う。そこから poteto-mode の「Match the model to the job」で上げ下げする。込み入った設計、並行処理、微妙なアルゴリズムは一段上げ、定型の機械的な変更は下げる。ただし、どの役も medium より下げない。
- 指示には、Issue の番号、範囲、触ってよいパス、決めたデータの形、終わった証拠を書く。「シェルで止まらない」の、消すときの書き方も書く。長い検査は、裏で動かさずに終わるまで待たせる。
- 書き終わったら、差分を自分で読む。範囲の外の変更は戻させる。

## 確かめる

- 実 Container の試験や Docker のビルドを `pnpm check --full` と `pnpm dev` の外で直接動かすときは、`node scripts/shared/docker-slots.ts run -- <コマンド>` で包んで Docker の枠を取る。反対役など、試験を動かさせる相手への指示にも、この包み方を書く。
- Issue の終わった証拠をすべて実行する。壊れた場合で失敗することを求める証拠は、本当の入口で壊れた場合を仕込んで失敗を示し、元に戻す。
- 触ったパスに関係する検査を、コミットした head で実行する。どれを実行するかは AGENTS.md「検査と引き継ぎ」に従う。
- 住宅相談サービスの利用者の画面と経路（`apps/web`、`apps/worker` と、その奥の形状 Container。ローカルと staging の両方）の振る舞いは、verify-madori で本物のアプリを動かして確かめる。開発の仕組みの画面（計測の viewer など）は、Issue の終わった証拠が決める入口（生成コマンドとブラウザなど）で確かめる。
- 住宅相談サービスの利用者の画面と経路の振る舞いを変えたら、同じ PR で verify-madori の `features/` も直し、直した手順を書いたとおりに動かす。検証役は地図の手順で確かめ、地図が古ければ不合格にする。開発の仕組みの画面だけを変えたら地図は直さず、検証役も地図の変更を求めない。

## PR を出す

- 範囲の外で見つけた問題は、PR に入れない。最初に見つけた時点と、それを判断した根拠を報告に書く。時点は原因になった作業のマージを基準にする。ほかの Issue が入れた問題を作業中に見つけたら「マージの後」である。
- コミットは英語の Conventional Commits にする。PR は poteto-mode の Opening a PR のとおりに日本語で書き、本文に `Closes #<番号>` を入れる。
- PR と Issue に貼る画像は、AGENTS.md「Issue と PR の画像」のとおり `images` ブランチに上げる。PR のブランチにも main にも画像を commit しない。
- PR を作ったら、このスレッドに紐付けて `watch_pull_request` で見張る。`check` が失敗したら、直して push する。
- staging へブランチを自分でデプロイしない。終わった証拠がマージの前の staging での確認を求めるときは、指揮役に頼む。

## 指揮役に報告する

`check` が最新の head で成功したら、報告先のスレッドへ `t3_thread_send` で一度だけ送る。送ったら、ターンを終えて待つ。

送る前に、自分の worktree の `target/` を消して、PR が開いている間のディスクを空ける。`delegate_task` で立てた Codex の子がすべて終わりを知らせていなければ、消さない。終わっていれば、worktree のルートで次を実行する。`target` が実体のディレクトリでない、Git が無視していないか追跡している、`target/` の中の Cargo のロックをプロセスが開いている、この worktree をルートとして `pnpm check` か `pnpm dev` が動いている、のどれかに当たると、消さずに理由を出す。

```sh
df -h / | tail -n 1
root=$(pwd -P)
keep=$(
  { test -d target && test ! -L target; } || echo "target is not a real directory"
  { test "$(git check-ignore target)" = target && test -z "$(git ls-files target)"; } || echo "git does not ignore target or tracks files in it"
  find target -maxdepth 3 -name '.cargo-*lock' -print0 2>/dev/null | xargs -0 lsof -t -- 2>/dev/null | sed 's/^/a Cargo lock in target is open: pid /'
  for pid in $(pgrep -f 'scripts/(check/check|dev/dev)\.ts'); do
    lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | grep -qFx "n$root" && echo "pnpm check or pnpm dev runs in this worktree: pid $pid"
  done
)
if [ -z "$keep" ]; then command rm -r -- target && df -h / | tail -n 1; else printf '%s\n' "$keep"; fi
```

- PR の URL と head の SHA
- 終わった証拠の項目ごとに、実行したコマンドと結果
- 設計を決めたなら、その結論
- Codex に使ったモデルと `reasoningEffort`、その effort にした理由
- 範囲の外で見つけたこと、最初に見つけた時点、その根拠
- `target/` を消す前と後の `df -h /` の空きを一行で。消さなかったなら、その理由

マージするかは指揮役が決める。頼まれたときだけマージする。直しを頼まれたら、同じブランチで直して push し、同じ形でもう一度報告する。ブランチが Rust の入力（`scripts/check/rust-inputs.ts`）に触れていれば、直した後の Rust の検査が `target/` を作り直す。mbx を使う既定では、外部のクレートはストアから使い回す。rebase も、頼まれたときだけ行う。

## マージの後

担当のスレッドは PR のマージで settled になり、PR の見張りも消える。Issue の終わった証拠にマージの後の staging での確認があれば、デプロイが終わったときに指揮役がこのスレッドへ知らせる。知らせを受けたら、verify-madori の「マージの後に staging を確かめる」で確かめる。記録が要る Issue では、記録の PR も作る。

PR の変更がすべて `deploy-staging.yml` の `paths-ignore` に入ると、マージしてもデプロイは動かず、知らせも来ない。`node .claude/skills/madori-coordinator/scripts/deploy-files.mjs before <PR の番号> <head の SHA>` が0で終わって何も出さなければ、その PR はデプロイを起こさない。そのような PR で staging での確認が要るなら、マージの後を待たずに、「PR を出す」のとおりマージの前の確認として指揮役に頼む。staging は前にデプロイした版のままで、マージはデプロイが読むファイルを変えないので、マージの前に確かめた結果がマージの後もそのまま当てはまる。
