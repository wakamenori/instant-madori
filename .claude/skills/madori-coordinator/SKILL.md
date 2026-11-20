---
name: madori-coordinator
description: instant-madori の計画を指揮役として進める。計画を Issue に分け、次の Issue を選び、T3 で担当と検証役を立て、マージを決めて、Issue と PR に記録する。1時間ごとの見回りと milestone の閉じ方も含む。指揮役のスレッドで計画を進めるとき、見回りのとき（引数「見回り」）、指揮役のセッションを引き継ぐときに使う。
---

# 指揮役として計画を進める

pstack の poteto-mode の Orchestrate に従い、各 PR は Autopilot-full の形で進める。このファイルには、このリポジトリと T3 で違うところだけを書く。担当の手順は [madori-owner](../madori-owner/SKILL.md)、アプリの確かめ方は [verify-madori](../verify-madori/SKILL.md) にある。

引数が「見回り」なら、「見回り」の節だけを行う。

## pstack と違うところ

- 指揮役は、メインのチェックアウトで動く Claude Code の T3 スレッド一つ。コードも PR も作らない。
- プログラムの状態は GitHub に置き、milestone、Issue、PR から読み直す。Orchestrate の `notes.md` と store は作らない。show-me-your-work の判断の記録は、Issue と PR のコメントに書く。
- 担当は T3 のスレッドとして、検証役は指揮役のスレッドの子として立てる。cloud VM の代わりに、このマシンの worktree を使う。
- 同時に動かす担当は五人まで。担当はこのマシンで、Rust の `target`、`pnpm dev` の固定のポート、CPU とメモリ、ディスクを共有するため。
- cargo を使うのは、担当と検証役を合わせて同時に一人まで。全 worktree が Rust の `target` を共有し、同時にビルドすると別の worktree の Wasm を使うおそれがあるため。#292 が取り違えを防ぐ仕組みを入れたら、この決まりを外す。
  - cargo を使う操作には、`pnpm setup`、`pnpm dev`、`pnpm check`（どのモードも）、`pnpm build` を含める。検証役は verify-madori の準備で cargo を使うので、数に入れる。
  - 担当は、報告を送ったら cargo の枠を空ける。直しで cargo が要る担当には、もう一度頼ませる。検証役は、判定を出したら枠を空ける。
  - cargo を使わない担当は、madori-owner の「準備」の cargo を使わない準備で進め、cargo を使う検査を runner の `check` に任せる。
- 検証は、head ごとに検証役一人で行う。Autopilot-full の swarm にはしない。
- マージするかは指揮役が決める。コマンドも指揮役が打ってよい。
- 着手する Issue の順は [scripts/rank-ready.mjs](scripts/rank-ready.mjs) で出す。依存の鎖の長さは手で数えられないため。ほかのスクリプトとポーリングのループは使わない。
- Autopilot-full の `/loop 1h` は、T3 の定期タスクに置き換える。プロンプトは `/madori-coordinator 見回り` の一行だけにする。

## 始めるとき

指揮役のセッションを新しく始めたら、まずメインのチェックアウトを `git pull --ff-only` で main に合わせる。このスキルとスクリプトは、そこから読み込まれる。引き継ぎのメモは探さずに、状態を次から読み直す。

- 開いている PR と、それぞれの head と `check`（`gh pr list --state open`、`gh pr checks <番号>`）
- T3 のスレッドの一覧（`t3_thread_list`）。担当のスレッドの題は `#<番号> <Issue の題>` にしてある
- 定期タスク（`list_scheduled_tasks`）。指揮役のスレッドが変わったら、見回りの紐付けを新しいスレッドへ移す
- 直近のデプロイ（`gh run list --workflow deploy-staging.yml --limit 5`）

## 計画を Issue に分ける

- milestone は plan.md 6章の段階に一つずつ作る。名前に節の番号を付けない（例：サービス基盤）。milestone の番号は、6章の節と同じ順にする。
- 計画にある作業は、着手する前にすべて Issue にする。plan.md にだけ書かれた作業を残さない。
- Issue は一つの PR で終わる作業にし、[テンプレート](../../../.github/ISSUE_TEMPLATE/unit.md)の欄をすべて埋める。

段階を Issue に分けるときは、次の順に進める。

1. 下書きを `.issues/<id>.md` に書く。このフォルダーは Git で追跡しない。本文はテンプレートと同じ見出しにする。frontmatter には `id`、`title`、`milestone`、`blockedBy` を書く。`blockedBy` には、先に閉じる必要がある下書きの `id` か、既存の Issue の `#<番号>` をカンマ区切りで書く。`#` を含む値は引用符で囲む。YAML では、値の先頭か空白の直後にある、引用符の外の `#` から後ろがコメントになる。依存の欄では、番号のない下書きを `#<id>` で指し、`blockedBy` と同じものだけを並べる。
2. 下書きを書いたのとは別のエージェントに、下書きを plan.md とコードに照らして確かめさせる。見るのは、計画の抜けと重複、下書き同士の食い違い、終わった証拠を実行できるか、依存の向き、人の判断が要る項目。plan.md がコードや決めたことと食い違っていれば、正しい内容を決めて下書きをそれに合わせ、plan.md を直す Issue も作る。指摘を直してから次へ進む。
3. 依存の先から順に Issue を作り、依存の欄の `#<id>` を実際の番号に置き換える。`blockedBy` の組は、GitHub の Issue の依存関係（blocked by）にも登録する。作った後は Issue を正とし、下書きを消す。

## 次の Issue を選ぶ

着手できる Issue を、milestone の番号、後ろに続く依存の鎖の長さ、Issue の番号の順に並べる。開いた Issue に塞がれていないものだけが出る。

```sh
node .claude/skills/madori-coordinator/scripts/rank-ready.mjs
```

1. 開いている milestone のうち、最も前の段階から選ぶ。その段階に、担当のいない着手できる Issue が無いときだけ、次の段階から選ぶ。
2. 同じ段階の中では、実環境での確認や試作のように、危険を早く明らかにする Issue を先に選ぶ。次に鎖の長い Issue を、それでも決まらなければ番号の小さい Issue を選ぶ。
3. 次の二つがそろうときは、次の段階の、設計を決めるための確かめの Issue を先に選んでよい。
   - 最も前の段階で着手できる Issue が、どれも後ろに依存の続かない Issue である。
   - その段階で最も長い依存の鎖には、もう担当が付いている。

## 担当を立てる

- Issue の「人の判断」が決まっていなければ、担当を立てずにユーザーに聞く。
- Issue 一つにつき、担当のスレッドを一つ立てる。`t3_thread_launch` で worktree を origin/main から作る。題は `#<番号> <Issue の題>` にする。
- `modelSelection` を `{instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{id: "effort", value: <effort>}]}` にし、effort を省かない。effort は次で決める。
  - 基準は high。
  - 「PRで決めること」がある Issue と、AGENTS.md が Docker での `pnpm check --full` を求める経路（Container・表示データ）を触る Issue は xhigh。
  - 判断がほとんど要らない機械的な Issue は medium。
- その担当に cargo を使わせるかを決める。ほかに cargo を使っている担当か検証役がいれば、使わせない。
- 応答の `modelSelection` に選んだ effort が返ったことを確かめ、その effort と理由、cargo を使わせるかを Issue にコメントする。
- 最初の指示は次の一行にする。`<threadId>` は指揮役のスレッドの ID で、担当はそこへ報告する。

  ```text
  /madori-owner #<番号> 報告先 <threadId>
  ```

  スラッシュコマンドとして読まれなければ、「madori-owner スキルで #<番号> を進める。報告先は <threadId>。」と送り直す。

- スレッドは一つの目的にだけ使う。手の空いたスレッドを、別の Issue に使い回さない。
- 担当の PR は担当のスレッドに紐付く。紐付いた PR がマージされると、そのスレッドは自動で settled になる。指揮役のスレッドには PR を紐付けない。紐付いていたら外し、`list_thread_pull_requests` で外れたことを確かめる。

## 検証役を立てる

担当から報告が来たら、PR の今の状態を `gh pr view` と `gh pr checks` で確かめてから、検証役を立てる。ほかに cargo を使っている担当か検証役がいれば、空くまで立てない。

- 検証役は、差分の大部分を書いた系統と別の系統のモデルにする。実装は Codex が書くので、普段は Claude Code の Opus にする。差分の大部分を Claude が書いた PR は、Codex に確かめさせる。
- `delegate_task` の `target` で、モデルと effort を明示する。effort は xhigh に固定し、Issue によって変えない。poteto-mode が検証を上げ下げの例外にしているため。
  - Opus：`{providerInstanceId: "claudeAgent", model: "claude-opus-5-5", options: {effort: "xhigh"}}`
  - Codex：`{providerInstanceId: "codex", model: <モデル>, options: {reasoningEffort: "xhigh"}}`。モデルは [pstack-models.md](../../rules/pstack-models.md) の、PR の playbook の行から取る。該当する playbook の行が無いときは、`feature, refactoring` の行を使う。
- `delegate_task` に `isolation: "worktree"` を付けて、指揮役のスレッドの子として立てる。指示は [verifier-brief.md](verifier-brief.md) の `{…}` を埋めて渡す。
- 検証役のスレッドには PR を紐付けない。
- 判定を PR に書いたら、検証役のスレッドを `t3_thread_organize`（`action: "settle"`）で settled にする。見回りの片付けは、settled でないスレッドの worktree を残すため。

## ブランチを staging で試す

担当は staging へブランチを自分でデプロイしない。終わった証拠がマージの前の staging での確認を求めるときは、担当が指揮役に頼む。

- 頼まれたら `gh workflow run deploy-staging.yml --ref <ブランチ>` で staging にデプロイし、終わったら担当に知らせる。
- 担当が確かめ終わるまで、ほかの PR をマージしない。main へのデプロイが、ブランチを上書きするため。
- ブランチのマイグレーションは、この時点で staging の D1 に入る。入れてよいかを、頼まれたときに判断する。

## マージを決める

次のすべてがそろったら、マージする。

- 検証役が、PR の今の head で合格を出した。
- self-hosted runner の `check` が、同じ head で成功した。ブランチ保護が無いので、`gh pr checks` で自分で確かめる。
- 自分で差分を読んだ。
- D1 のマイグレーションを加える PR なら、今の main のマイグレーションと番号が衝突しない。PR の `check` は分岐点と比べるので、先に main へ入った同じ番号には、マージ後の main の `check` で初めて気づく。

```sh
gh pr merge <番号> --merge --match-head-commit <head>
```

## マージの後

- main に入ると、staging へ自動でデプロイされる。結果は見回りで読む。
- デプロイか疎通の確認が失敗したら、原因を確かめる。環境の問題なら `gh run rerun <run> --failed` でやり直す。コードの問題なら、直す担当をすぐに立てる。
- Issue の終わった証拠に staging での確認があれば、その Issue の担当が確かめて、記録が要るなら記録の PR を作る。

## 記録と、見つかった問題の行き先

- 判断と結果は、その Issue か PR にコメントで書く。誰の判定か、どの head か、何で確かめたかを書く。検証役の判定とマージは PR に書く。
- 画像は、AGENTS.md「Issue と PR の画像」のとおり `images` に置いたリンクで貼る。検証役の報告にある画像の Markdown は、判定のコメントにそのまま貼る。
- 担当や検証役が範囲の外で見つけた問題は、根拠を確かめてから行き先を決める。関係する Issue があれば、そこに書き足す。無ければテンプレートで新しい Issue を作り、該当する milestone に入れて、依存を登録する。

## 見回り

T3 の定期タスクが、1時間ごとに `/madori-coordinator 見回り` を送る。次を順に行う。何も変わっていなければ、ユーザーへ報告せずに終える。

1. メインのチェックアウトを `git pull --ff-only` で main に合わせる。
2. `df -h /` で空きを確かめる。20 GiB を切っていたら、次を片付けてから進む。空きが戻るまで、新しいスレッドを立てない。
   - `~/.t3/worktrees/instant-madori/` のうち、HEAD が main に入っていて、未コミットの変更が無い worktree。ただし、settled でないスレッドの worktree は残す。作ったばかりの担当の worktree も、HEAD が main に入っていて変更が無いため。
     - settled でないスレッドは、`t3_thread_list` に `settled: false` を付けて最後のページまで出す。
     - 各スレッドの worktree は、`t3_thread_read` が返す `thread.worktreePath` で調べる。`creationSource` が `provider` のスレッドは読まない。Claude Code や Codex が自分で立てた subagent で、親のスレッドと同じ `worktreePath` を返す。
     - `t3_worktree_list` は使わない。検証役が PR の head を detached で取り出した worktree を返さない。
   - 使っていない Docker のイメージ（`docker image prune -a -f`）
3. 担当ごとに、コミット、push、PR、`check` の動きを確かめる。報告の来た PR と、報告は無いが `check` の通った PR には、検証役を立てる。止まった担当は、新しい担当に入れ替える。
4. 終わった検証役の判定を読み、「マージを決める」に進む。
5. マージの後のデプロイを `gh run list --workflow deploy-staging.yml --limit 5` で確かめ、「マージの後」のとおりに扱う。
6. 動いている担当が五人より少なければ、「次の Issue を選ぶ」で選んで担当を立てる。

## milestone を閉じる

- milestone は、その Issue がすべて閉じたときに閉じる。Issue が一つも無い milestone は閉じない。
- 段階の受け入れを確かめる Issue は、記録に失敗や未確認の項目が一つでも残る間は閉じない。直した後に確かめ直す。
- 閉じる前に、次の二つを行う。
  - `/pstack:reflect` で、その段階の進め方を振り返る。見つかった改善は Issue にするか、このスキルや madori-owner を直す担当を立てる。
  - 担当を一人立て、`/pstack:maintain-verification-skill` で verify-madori の地図を点検させる。直すところは一つの PR にまとめさせる。
