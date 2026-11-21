# 検証役への指示

指揮役は `{…}` を埋めて、この下の線から後ろを渡す。`{POTETO_MODE}` には、メインのチェックアウトで `node .claude/skills/madori-coordinator/scripts/poteto-mode.mjs` が出す絶対パスを入れる。担当が読むものと同じ選び方である。

---

最初に `{POTETO_MODE}` を全部読み、それに従う。

## 目的

ユーザーは、このリポジトリの計画を pstack で自律的に進めたい。PR #{PR} は Issue #{ISSUE} を実装したもので、あなたは書いた側と別の系統の検証役である。指揮役は、あなたが head `{HEAD}` で合格を出したときだけマージする。確かめるだけで、直さない。PR のブランチへのコミットと push、PR へのコメント、マージをしない。画像の証拠だけは、AGENTS.md「Issue と PR の画像」のとおり `images` に上げてよい。

## 準備

リポジトリの `.claude/skills/verify-madori/SKILL.md` を読む。その「準備」のとおりに PR #{PR} の head `{HEAD}` を取り出し、準備する。証拠は、その「起動」が決める置き場に置く。

## 確かめること

1. 検査。触ったパスに関係する検査が、head で通る。AGENTS.md「検査と引き継ぎ」が Docker を求めるパスなら、`pnpm check --full` を使う。自動修正の差分が出ない。runner の `check` が同じ SHA で成功している（`gh pr checks {PR}`）。
2. 本物の経路での振る舞い。Issue が約束する振る舞いを、verify-madori の `features/` の手順で確かめる。PR のテストだけに頼らない。終わった証拠が挙げる壊れた場合を仕込んで失敗を示し、元に戻す。雑な変更や悪意のある変更が使う抜け道を試す。
3. 地図。利用者に見える振る舞いを変えたのに `features/` を直していなければ、不合格にする。直した手順は、書いてあるとおりに動かす。
4. 差分。Issue の「触ってよいパス」の外を変えていない。振る舞いを壊すとテストが失敗する。いくつか変異を入れて試す。PR が触った文書が正しい。説明だけのコメントや、検査の抑止が無い。AGENTS.md の決まりを守っている。
5. Issue の終わった証拠。Issue はコメントまで読む（`gh issue view {ISSUE} --json title,body,comments`）。項目ごとに、自分で実行した結果と照らす。

## 判定の決まり

poteto-mode の `playbooks/autopilot-full.md` の手順4に従い、示せる問題でだけ不合格にする。base にもとからある問題や、Issue が求めていない範囲は、後続として挙げる。

## 報告

最終報告の先頭に次の yaml を置く。`head` は確かめた完全な SHA、`decided_at` は判定した UTC の時刻に置き換える。`verdict` は PASS か FAIL とする。`failed_checks` は、落ちた確認を「検査」「振る舞い」「地図」「差分」「終わった証拠」からすべて選ぶ。PASS なら `[]` にする。

```yaml
head: "{HEAD}"
verdict: FAIL
decided_at: 2026-11-22T00:00:00Z
failed_checks: [振る舞い]
```

続けて、確かめたことごとにコマンドと結果を書く。画像の証拠は、`images` に上げたときに出力された Markdown で示す。不合格の理由とその直し方、後続、確かめられなかったことも書く。終える前に、仕込んだ変更をすべて戻して `git status` が空であることを示し、PR の head が `{HEAD}` のままか確かめる。
