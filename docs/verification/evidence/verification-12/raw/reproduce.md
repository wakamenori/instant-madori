# 書き出した表示メッシュで日差しを計測する

リポジトリのルートで実行する。書き出しには開発用の SolidCraft ビルドと mbx が必要。以降はコミットした場面だけで実行できる。

```sh
s=crates/modeling/src/model/sun_probe/standalone
raw=docs/verification/evidence/verification-12/raw
df -h /
bash crates/modeling/src/model/sun_probe/bench/export.sh
# Optional: emit every failed pair and select the first observed input.
SUN_METHOD=E-kernel SUN_DIAG=1 "$(find target/debug/deps -type f -name 'madori_modeling-*' -perm -100 | head -1)" sun_probe_measure --nocapture | awk '/^failed cut/ && !seen++'
df -h /
command rm -r -- target
df -h /
export CARGO_TARGET_DIR="$PWD/target/sunbench"
mise exec -- cargo build --release --manifest-path "$s/Cargo.toml"
mise exec -- cargo build --release --manifest-path "$s/Cargo.toml" --target wasm32-unknown-unknown --lib
python3 "$s/compare.py"
python3 "$s/measure.py" macos
mise exec -- python3 "$s/measure.py" wasm
mise exec -- node scripts/shared/docker-slots.ts run -- docker buildx build --platform linux/amd64 --load -t sunbench-203 -f "$s/Dockerfile" .
mise exec -- node scripts/shared/docker-slots.ts run -- python3 "$s/measure.py" linux
python3 "$s/summarize.py"
df -h /
command rm -r -- target/sunbench
df -h /
```

各 scene は空白区切り。SUN1 に続けて頂点数と f32 の xyz、三角形数と各三角形の頂点番号3個・ガラスフラグ、受光面数と各面の名前・役割（0 床、1 壁、2 天井）・法線・平面上の点・三角形数と番号、開口数と各開口の8頂点、条件数と各条件の名前・太陽方向・役割別の解析解（m²、未定義は -1）を格納する。slit.scene は共通の形状に太陽方向4個を持つ。

各 JSONL の counts は、光線数、R1 バイト数、R2 バイト数、影の候補数、外接矩形が重なり切り取りを行った凸片と影の対の数、各影の処理後の片数の累計、外接矩形を比較した対の数、面単位の片数の最大値の順。各条件の面積は床・壁・天井の順に m² で格納する。face_candidates は scene の順に並ぶ。太陽が地平線より下なら全ての面で計算を省く。

## 照合と kernel の診断

既存の dev.jsonl で G・A・Q・E-convex を比較できる120行（360個の役割別面積）を確認した。G・A・Q の最小セル数の差はゼロ。E はすべて 1e-6 m² 以内。家一軒の SolidCraft dev の E の役割別面積は、3月正午が床 0.6764972801167239 m²、6月正午が床 0.28066188659561403 m²、それ以外はすべてゼロ。書き出しテストが各条件の参照値を出力する。

kernel の Cut（許容差 1e-7 mm）は、直角三角形から、内部に収まる三角形、同一三角形、境界を横切る三角形を引く例で順に1、0、1領域を返した。床の場面で最初に失敗した呼び出しの両オペランドは kernel-cut.txt に保存した。1個の四角形から1個の投影済み四角形を引く演算で status 1001（SM_ERR）。影の最短辺は約 1.56e-7 mm で、受光面の辺と影の辺が部分的に重なる。どちらが直接の失敗原因かは特定できていない。

## 時間に効いた処理

12月15時は、追加家具がないと候補2,700枚（1面あたり最大337）、切り取り7,483回、同時に持った片は最大40個、累計23,059個だった。全8室に各16個の円柱を加えると候補77,669枚になった。冬のこの条件では、元の遮蔽物だけで光が届かなくなるため、後から追加した家具の影を引く前に片が尽きる。切り取り回数と片数が全く同じなのに Wasm は 2.81 ms から 23.77 ms に増えた。全遮蔽三角形の手前側の切断、投影、候補収集のコストが規模とともに増える。残る光がある3月正午は片と候補の外接矩形の比較も3,415回から210,784回に増えた。各段階の時間比率は測定していない。

12月9時の格子方式では G 25、G 10、A 5 の順に約47万、292万、650万本の光線を判定した。A の投影矩形は複数の開口から成り、屋内の面の大きな範囲を覆う。Wasm の G では基準計測の試行間の時間差が大きく、家具を加えると速くなると解釈できる結果ではない。固定例の答えと時間の対応を確認し、他の機械の速度への換算はしていない。

## 実行環境とディスク

2026-11-26、macOS arm64、Apple M4 Pro（12コア）、Linux は arm64 Docker 上の amd64 エミュレーション。方式ごとに連続5回測定し、初回を含めた。空き容量（df -h /）は開始11 GiB、場面の書き出し開始・完了12 GiB、kernel の診断後と target 削除後12 GiB、standalone ビルド開始12 GiB・完了9.3 GiB、macOS 計測完了17 GiB、Wasm 計測完了15 GiB、Docker ビルド開始16 GiB・完了26 GiB、Linux 計測完了24 GiB、集計後の target/sunbench 削除前後24 GiB。ディスクは他の作業と共用している。

初回の Wasm ビルドでは時計と出力関数の import module 指定が不足していた。最初の実行では入力用配列の要素型が i32 と推論され、解放時に停止した。env の import と u8 配列を明示した後の完走分だけを採用した。3環境の基準計測と、2環境の家具数掃引で各条件の役割別面積を照合した。
