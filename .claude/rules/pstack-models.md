# pstack model configuration for this repository. One line per role.

# Every pstack role has a line here, so this repository never falls back to ~/.claude/rules/pstack-models.md or to the skill defaults. When pstack adds a role, add its line here in the same change that starts using it.

# In this repository, these lines take precedence over ~/.claude/rules/pstack-models.md.

# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit Task `model`). Alias entries in a panel list still count toward its fan-out.

# `<model> <effort>` such as `opus xhigh`: spawn with Agent `model` and `effort`.

# A `gpt-*` value runs on Codex. In T3, start it with `delegate_task`: `target.providerInstanceId` "codex", `target.model` the slug, and `target.options.reasoningEffort` the effort. Outside T3, omit `model` so the role runs on the session model.

feature, refactoring: gpt-6.2-astra medium
bug-fix: gpt-6.2-astra medium
perf-issue: gpt-6.2-astra medium
hillclimb: gpt-6.2-astra medium
judgment and prose: opus xhigh
hardest tasks: opus xhigh
how explorer: inherit-parent
how explainer: opus xhigh
why investigators: inherit-parent
why synthesizer: opus xhigh
reflect tooling: inherit-parent
reflect judgment, divergent, synthesizer: opus xhigh
arena runners: opus xhigh, inherit-parent
arena cross-judge pool: opus xhigh, inherit-parent
swarm workers: inherit-parent
architect runners: opus xhigh, inherit-parent
interrogate reviewers: opus xhigh, inherit-parent
