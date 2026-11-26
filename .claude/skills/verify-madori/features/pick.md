# 選んだ候補を確かめる

利用者が案の壁・部屋・開口を選ぶと、画面は選んだ要素の住宅要素IDを Worker に送る。3D なら、当たった点と面の法線も添える。Worker はその案の住宅データで候補を確かめ、要素の種類と寸法を返す。壁なら、選んだ面がどの部屋の側か外側かと、両側の部屋名も返す。返った `target` は、後で指示に添える対象になる。住宅データを持たない案（manifest の版1）は選べない。

## Sub-features

- `pick-old-format`：住宅データを持たない案に送ると `409` で `not_selectable` が返る。
- `pick-missing`：存在しない案は `404` で `not_found` が返る。
- `pick-origin`：自分の画面の Origin を付けないと `403` で `forbidden` が返る。
- `pick-invalid`：知らない欄や長さ0の法線を送ると `400` で `invalid_request` が返る。
- `pick-wall`：住宅データを持つ案の壁に送ると、長さ・厚さ・高さ、選んだ面の役割、両側の部屋名が返る。
- `pick-unknown`：案の住宅データに無い要素は `404` で `not_found` が返る。

## How to get to it (user POV)

- 画面からはまだ選べない。`POST /api/revisions/<案の ID>/pick` を使う。案の ID は、パターンの状態の `currentRevision.id` で得る（[指示を送る](./instructions.md)）。

## Driving it with curl

Preconditions:

- Container が必要。案を作るために、指示を一件確定させる。
- [指示を送る](./instructions.md)の「送る」と「終わるまで待つ」を済ませ、`REV1=$(jq -r .currentRevision.id "$EVIDENCE/instructions/state-1.json")` を設定している。
- `. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`J='content-type: application/json'` と `D="$EVIDENCE/pick"` を設定し、`$D` がある。

- **壁を選ぶ。** 平面図の階を `STOREY=$(tr -d '\r' < "$EVIDENCE/instructions/view-1.headers" | sed -nE 's/^x-floor-plan-storeys: *//Ip')` で読み、`curl -sS -o "$D/floor-plan.svg" -w '%{http_code} %{content_type}\n' "$API/revisions/$REV1/floor-plan?storey=$STOREY"`。`200 image/svg+xml`。壁の ID を `WALL=$(grep -oE '<path class="wall" data-element-id="[^"]+"' "$D/floor-plan.svg" | head -n 1 | sed -E 's/.*data-element-id="([^"]+)"/\1/')` で取る。要素 ID は仕事ごとに変わるので、決め打ちしない。`curl -sS -o "$D/wall.json" -w '%{http_code}\n' -X POST "$API/revisions/$REV1/pick" -H "$J" -H "$O" -d "{\"element\":\"$WALL\"}"`。`200` で、`element` が `kind` `wall`、`length` `4000`、`thickness` `200`、`height` `2800`、`faces` が `[{"kind":"room","room":<部屋の ID>,"roomName":"LDK"},{"kind":"exterior"}]`。`target.face` は `null`。
- **面を選ぶ。** 既定の台本の最初の壁は、y が 0 の線の上にあり、部屋は北側にある。`-d "{\"element\":\"$WALL\",\"hit\":{\"point\":{\"x\":2000,\"y\":100,\"z\":1200},\"normal\":{\"x\":0,\"y\":1,\"z\":0}}}"` を送り、出力先を `"$D/wall-inside.json"` にする。`200` で、`target.face` が `{"kind":"room","room":<部屋の ID>}`。点の `y` を `-100`、法線の `y` を `-1` にして出力先を `"$D/wall-outside.json"` にすると、`target.face` が `{"kind":"exterior"}`。
- **知らない要素。** `-d '{"element":"mid"}'` を送り、出力先を `"$D/unknown-element.json"` にする。`404` で、本文が `{"error":"not_found"}`。
- **無い案。** 案の ID を `00000000-0000-4000-8000-000000000000` に変え、出力先を `"$D/missing.json"` にして、壁を選ぶ本文を送る。`404` で、本文が `{"error":"not_found"}`。
- **Origin なし。** `-H "$O"` を外し、出力先を `"$D/no-origin.json"` にして、`$REV1` へ同じ本文を送る。`403` で、本文が `{"error":"forbidden"}`。
- **知らない欄。** `-d '{"element":"mid","side":"left"}'` を送り、出力先を `"$D/unknown-field.json"` にする。`400` で、本文が `{"error":"invalid_request"}`。
- **長さ0の法線。** `-d '{"element":"mid","hit":{"point":{"x":0,"y":0,"z":0},"normal":{"x":0,"y":0,"z":0}}}'` を送り、出力先を `"$D/zero-normal.json"` にする。`400` で、本文が `{"error":"invalid_request"}`。

## Gotchas

- 仕事が作る案は住宅データを持つ版2の案なので、手元の新しい D1 には版1の案ができず、`pick-old-format` は本物のアプリでは通れない。`apps/worker/tests/pick.test.ts` が版1の案を作って確かめている。アプリで確かめたと書かない。staging には、サンプルの時期に作った版1の案が残っている。
- 版1の判定は要素の検査より先に行うので、版1の案には、存在しない要素の ID を送っても `409` になる。
- このルートは何も記録しないので、`requestId` を送らない。送ると知らない欄として `400` になる。
- `hit` の点と法線は住宅の座標（mm、x が東、y が北、z が上）で書く。表示データの座標はこの座標のままである。2D の選択は `hit` を送らない。
