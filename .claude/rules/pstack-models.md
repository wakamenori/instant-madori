# pstack model configuration for this repository. One line per role. Delete a line to fall back to the skill default.

# In this repository, these lines take precedence over ~/.claude/rules/pstack-models.md.

# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit Task `model`). Alias entries in a panel list still count toward its fan-out.

# A `gpt-*` value runs on Codex. In T3, start it with `delegate_task`: `target.providerInstanceId` "codex", `target.model` the slug, and `target.options.reasoningEffort` the effort. Outside T3, omit `model` so the role runs on the session model.

feature, refactoring: gpt-6.2-astra medium
bug-fix: gpt-6.2-astra medium
perf-issue: gpt-6.2-astra medium
hillclimb: gpt-6.2-astra medium
