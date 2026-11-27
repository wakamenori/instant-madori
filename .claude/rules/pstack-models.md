# モデル割り当て

## 共通ルール

- このリポジトリでは、`~/.claude/rules/pstack-models.md` やスキルの既定値よりこのファイルを優先する。pstack に新しい役が追加されたら、使い始める変更でここにも足す。
- どの役も `medium` 未満には下げない（Codex の `reasoningEffort` も含む）。
- 起動のしかた：
  - `opus <effort>`：Claude の `Agent`（`model` / `effort`）。T3 のスレッド起動では `claude-opus-5-5`。
  - `gpt-* <effort>`：T3 では `delegate_task`（`providerInstanceId: "codex"`, `model`, `options.reasoningEffort`）。T3 外では `model` を省略して親のモデルで動かす。
  - `inherit-parent`：親と同じモデル（`model` を省略）。パネル内でも 1 枠として数える。

## 開発フロー（madori）

| 役割                | pstack の役名                                                   | モデル            | effort        | 備考                                                                                    |
| ------------------- | --------------------------------------------------------------- | ----------------- | ------------- | --------------------------------------------------------------------------------------- |
| 担当                | `madori-owner`                                                  | `claude-opus-5-5` | 基準 `high`   | 「PRで決めること」がある Issue・`--full` 対象経路は `xhigh`、機械的な Issue は `medium` |
| 実装                | `feature, refactoring` / `bug-fix` / `perf-issue` / `hillclimb` | `gpt-6.2-sol`     | `medium` 固定 | 上げ下げしない                                                                          |
| 検証（Codex 差分）  | `madori-verifier`                                               | `claude-opus-5-5` | `high` 固定   | 差分の大部分を書いた系統と別系統を使う                                                  |
| 検証（Claude 差分） | `madori-verifier`                                               | `gpt-6.2-sol`     | `high` 固定   | 同上                                                                                    |

## 設計・レビューの並列パネル

| pstack の役名            | 構成                                |
| ------------------------ | ----------------------------------- |
| `architect runners`      | `opus medium`, `gpt-6.2-sol medium` |
| `interrogate reviewers`  | `opus high`, `gpt-6.2-sol high`     |
| `arena runners`          | `opus xhigh`, `gpt-6.2-sol xhigh`   |
| `arena cross-judge pool` | `opus xhigh`, `gpt-6.2-sol xhigh`   |

## その他の pstack の役（フォールバック防止）

| pstack の役名                                                                                                             | モデル・effort   |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `judgment and prose` / `hardest tasks` / `how explainer` / `why synthesizer` / `reflect judgment, divergent, synthesizer` | `opus xhigh`     |
| `how explorer` / `why investigators` / `reflect tooling` / `swarm workers`                                                | `inherit-parent` |
