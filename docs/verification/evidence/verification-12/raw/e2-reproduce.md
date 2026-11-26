# E2 の再計測

リポジトリのルートで実行する。入力は既存の SUN1 の場面。両方の release ビルドに SolidCraft は不要。

```sh
git apply docs/verification/evidence/verification-12/prototype.patch
s=crates/modeling/src/model/sun_probe/standalone
export PYTHONDONTWRITEBYTECODE=1 CARGO_TARGET_DIR="$PWD/target/sunbench"
mise exec -- cargo build --release --manifest-path "$s/Cargo.toml"
mise exec -- cargo build --release --manifest-path "$s/Cargo.toml" --target wasm32-unknown-unknown --lib
python3 "$s/e2_scenes.py"
python3 "$s/e2_cases.py"
python3 "$s/e2_measure.py" macos
mise exec -- python3 "$s/e2_measure.py" wasm
mise exec -- node scripts/shared/docker-slots.ts run -- docker buildx build --platform linux/amd64 --load -t sunbench-e2 -f "$s/Dockerfile" .
mise exec -- node scripts/shared/docker-slots.ts run -- env PYTHONDONTWRITEBYTECODE=1 python3 "$s/e2_measure.py" linux
```

SUN2 は SUN1 の条件列の後に部屋数を足す。各室は下端・上端の z と、反時計回りに並べた底面4点の xy を持つ。長さは mm。面候補の元データは SUN1 が保存した面に限られる。書き出し時の重心判定ですでに失われた面の復元は試していない。製品側でこの入力を作るには、室内と重なる可能性のある面を、重心で捨てる前に渡す必要がある。固定例の床は水平で各階の下端にあり、この条件で屋根上面を除いた。

受ける面を部屋ごとに切り、面自身の三角形を番号で除く。内積が 0.01 以下ならその面を省く。手前側の切断位置を一律 0.01 mm ずらす試行では、勾配天井に幅のある光が残り 1.086864189 m² となった。採用した試行では、面からの距離の絶対値が 0.01 mm 以下の頂点を境界と分類する。正側の頂点が一つもなければ捨て、正側の頂点があれば境界まで影を引く。勾配天井は 1.086706464 m²。部屋の辺の内外判定では距離 0.001 mm までを辺上と扱った。

格子は各時刻に一度作る。太陽方向に垂直な正規直交基底に三角形を写し、外接矩形が触れる全セルに番号を登録する。部屋ごとに切った面の投影外接矩形から番号を集め、番号順に整列して重複を消す。主計測のセル辺長は 1,000 mm（約4 m の部屋の幅の1/4）。家一軒で 500・2,000 mm も比較した。基準の12月15時の Wasm 中央値は小さい順に 3.48、2.96、2.74 ms。セルを大きくすると候補は増えるが、同じ三角形を複数セルに登録する仕事は減る。

計測の ms は各時刻の格子作成から面積集計まで。準備（文字列の読込み、部屋による切断）は prep に別記した。最大 RSS は各場面の6条件×5回を通したプロセス全体の最高値。Wasm では Node を含む RSS と線形メモリの末尾容量を併記した。macOS arm64、Apple M4 Pro、12コア。開始時のロードアベレージは 8.37。家具0個、地下三角形0枚はともに baseline。既存の家具配置は1室16個までに使い、32、64個は半径200 mm の全円柱が室内に入るよう 8 列・行間 480 mm で配置した。16個と32個では家具の位置も変わる。

候補数だけで 50 ms を保証できない。例えば地下40万枚・12月15時は組数 10,279 のまま Wasm が 2.96 から 15.11 ms に増えた。格子作成には全三角形が入る。家具32個・6月正午は 220,075 組でも 248.65 ms で、片の比較が 6,765,653 回に達した。家具64個・12月9時は 841,543 組でも 46.36 ms。今回の条件で 50 ms を超えた最少組数は 220,075。20万組は中断を考える暫定目安だが、製品で時間を制限するには登録三角形数、比較回数、片の増加、経過時間も監視する必要がある。地下40万枚の RSS は Node を含むので、Wasm 線形メモリと区別する。

空き容量は開始とパッチ適用後 11 GiB、release ビルド前後 9.1 → 9.0 GiB、精度試験のやり直しと本計測開始前後 9.2 → 9.8 GiB、macOS 後 9.1 GiB、Wasm 後 8.2 GiB。Linux のビルドは Docker 枠の開始条件（空き 12 GiB）に対し 8.4 GiB で拒否されたため未計測。集計時は一時 7.2 GiB、target/sunbench 削除前後はともに 8.0 GiB。空き容量は他の作業と共有する。
