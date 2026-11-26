# 試作の前に読んだ資料と制約

Issue #203。設計の候補を出す前に、計画とコードから読み取った制約をまとめる。

## 計画が決めていること

- 日差しは、地域・日時・方位から太陽方向を求め、開口・壁・家具・屋根・隣家の遮蔽を計算して3Dに表示する。表示から隠した屋根も遮蔽に含める。ガラスは光を通す（plan 4.8、2.3）。
- 結果は案IDと日時・地域・方位で識別してキャッシュし、計算中に条件が変わったら古い結果を採らない（4.8）。公開APIは `POST /api/revisions/:id/sunlight`（4.7）。後続のIssueは、Containerの `crates/modeling` で計算し（#205、#210）、内部APIのルート（#206）、公開API（#207）、R2のキャッシュ（#208）、画面からの要求（#211）、描画（#209）を前提に分かれている。
- 表示形式は `crates/display` が持つ。版1は `MDSP` ヘッダー、全体の長さ、8バイト境界のセクション表、必須セクション ELEM・BODY・POSN・NORM・TRIS・TFAC・FCOL、その後の任意セクション。WorkerとWebはバイト列を解釈せず、Wasmの復号で検証する。内部APIの上限は16 MiB（4.8）。
- 影を3Dに描くなら、viewport-gpuの不透明な面の描画に載せ、AOの前処理を手本に光の向きから深度を描いて照明に影の項を掛ける、という段落がある（4.8、検証11の案Bから）。これは日差しの計算結果の表示とは別の、描画の影の話として書かれている。
- 時刻は30分刻み、月は各月21日を代表日とする（2.3）。月と時刻は画面で変え、案の履歴を増やさない。
- `crates/viewer` は geom・viewport・viewport-gpu だけを使う（4.2）。

## コードから分かること

- `crates/modeling` は、要求ごとに住宅データからSolidCraftのSessionを作り直し、`display::export` で `session.world_state()` の各ボディの表示メッシュ（f64の `positions`、`normals`、`triangles`、三角形ごとのB-rep面番号 `tri_face`）を f32 にして `DisplayModel` を作る。
- SolidCraftの `solidcraft_engine::geom` は `MeshGeom::raycast`（全三角形の走査）と `MeshIndex::raycast`（BVH、同じ答え）を持つ。交差判定はWoopらの水密な方式で、二つの三角形が共有する辺や頂点を通る光線は少なくとも一方に当たり、すき間をすり抜けない。
- `solidcraft_engine::kernel` は `planar_regions_boolean`（直線・円弧・自由曲線で囲まれた平面の領域の正確なブール演算。線分は8,192本まで）と `brep_record`（ボディのB-repの記録）、`face_surface`（面の解析的な種類）を持つ。
- B-repの面に光線を当てる `face_hit_by_ray` は solidcore-ops にあり、`solidcraft_engine` からは呼べない。使うには modeling から solidcore-ops への直接の依存と、境界の表と plan 4.2 の変更が要る（#203 のコメント）。
- 試作用の道具として `crates/modeling/src/model/probe_kit.rs`（コマンドの実行、角柱、ブール演算、測定）がある。検証9・10の試作は、この道具を使うテスト専用のモジュールだった。
- Containerのイメージは `apps/geometry/Dockerfile`。`rust:1.99.1-bookworm` でLinux amd64向けにビルドし、`debian:bookworm-slim` で動かす。

## 検証2から引き継ぐこと

- 床だけを、窓の8隅の投影で絞った範囲で25 mm間隔に調べ、平面のB-repへの光線で判定した。200 mm間隔では夏の細い日だまりを見落とした。
- 二部屋の固定例で、サーバーの計算は約0.08〜2.36秒だった。家一軒での時間は分かっていない。
- 真南・高度30°の床の面積は、25 mm間隔で2.04 m²（解析解2.046307 m²、許容差0.05 m²）。
