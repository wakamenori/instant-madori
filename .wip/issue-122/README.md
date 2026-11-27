# #122 の中断時の試作（レビュー前）

#122 を中断したときに、architect の候補を作っていた二つの runner が残した、未完成の試作の差分。どちらも設計の文書を書く前に止まった。内容は確かめていない。

- 基にした commit：`50fbb14798b31adcdcea69dac27682904d98184b`
- `architect-runner-1.patch`：`crates/housing` の `check.rs`、`check/walls.rs`、`joint.rs`、`layout.rs`、`measure.rs`、`planform.rs` の変更と、probe の試験（`acceptance_probe`、`convex_oracle`、`nofloor45`、`polygon_layout_probe`、`rot_dump`、`rotation_fidelity`、`sweep_cases_probe`）
- `architect-runner-2.patch`：`check.rs`、`joint.rs`、`layout.rs`、`measure.rs`、`planform.rs` の変更と、probe の試験（`probe_accept`、`probe_poly`）

再開するときに読み、使わなければこのフォルダーごと消す。main へは入れない。
