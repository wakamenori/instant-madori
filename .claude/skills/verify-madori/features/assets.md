# 画像を登録する

利用者は、家具や素材の参考にする画像を登録する。PNG か JPEG で、7,499,997 バイト（約 7.5 MB）以下、幅と高さがそれぞれ 2,576 px 以下の画像だけが登録でき、登録した画像は送った利用者の資産になる。応答の資産 ID を、後で指示に添える。同じ要求を送り直しても資産は増えない。形式が違う画像、壊れた画像、大きすぎる画像は、理由ごとのエラーで拒まれ、何も残らない。登録した画像は、登録した利用者だけが、登録したバイト列のまま読み出せる。ほかの利用者には、存在しない資産と同じ `404` が返る。保存した内容が登録時のハッシュと合わなければ、画像を返さずに `500` になる。

## Sub-features

- `asset-png`：PNG を送ると `201` で、資産の ID・メディア型・バイト数・幅と高さ・SHA-256 が返る。値は送ったファイルと一致する。
- `asset-jpeg`：JPEG でも同じ。
- `asset-stored`：登録すると、ローカルの D1 に行が一件、R2 にオブジェクトが一件でき、どちらのバイト数と SHA-256 も送ったファイルと一致する。
- `asset-replay`：同じ `requestId` と同じ画像を送り直すと、最初と同じ応答が返り、行もオブジェクトも増えない。
- `asset-reuse`：同じ `requestId` で別の画像を送ると `422` で `request_id_reused`。
- `asset-unsupported`：`content-type` が PNG と JPEG 以外だと `415` で `unsupported_media_type`。
- `asset-mismatch`：`content-type` と中身の形式が違うと `422` で `invalid_image`。
- `asset-bytes`：7,499,997 バイトを超えると `413` で `payload_too_large`。
- `asset-dimensions`：幅か高さが 2,576 px を超えると `422` で `image_dimensions_too_large`。
- `asset-origin`：自分の画面の Origin を付けないと `403` で `forbidden`。
- `asset-read`：`GET /api/assets/<ID>` で、登録した利用者は `200` で送ったファイルと同じバイト列を受け取る。`content-type` は登録したメディア型、`x-content-type-options: nosniff`、`cache-control: no-store` が付く。
- `asset-read-hidden`：存在しない ID と、別の利用者の資産は、どちらも `404` で、本文が同じ `{"error":"not_found"}`。
- `asset-read-damaged`：R2 のオブジェクトを書き換えると、登録した利用者にも `500` で `{"error":"internal_error"}` が返り、画像のバイト列は返らない。
- `asset-staging`：staging で、検証用の利用者として PNG を登録し、読み出せる。

## How to get to it (user POV)

- 画面からはまだ登録できない。`POST /api/assets?requestId=<UUID>` に、画像のバイト列を本文にして送る。`content-type` は `image/png` か `image/jpeg`。
- 画面からはまだ読み出せない。`GET /api/assets/<ID>` で、登録した利用者として読み出す。保存された行とオブジェクトは、ローカルの D1 と R2 を直接読んで確かめる。

## Driving it with curl

Preconditions:

- Container は不要。Container の要る地図と同じ回で確かめないなら、[SKILL.md の「起動」](../SKILL.md#起動)の手順で `MADORI_DEV_CONTAINERS=0` を付けて起動する。
- 状態確認が通っている。
- `. "$EVIDENCE/dev.env"` で `API` と `O` を読み込み、`D="$EVIDENCE/assets"` を設定し、`$D` がある。
- macOS の `sips` で画像を用意する。`command cp -f docs/verification/evidence/verification-01/02-customized-3d.png "$D/sample.png"`、`sips -s format jpeg "$D/sample.png" --out "$D/sample.jpg"`、`sips -z 100 2577 "$D/sample.png" --out "$D/wide.png"`。`sips -g pixelWidth -g pixelHeight` で、`sample.png` と `sample.jpg` が 1400×1000、`wide.png` が 2577×100。
- 送る関数を定義している。`up() { curl -sS -o "$D/${1}.json" -w '%{http_code}\n' -X POST "$API/assets?requestId=${2}" -H "$O" -H "content-type: ${3}" -H 'Expect:' --data-binary @"${4}"; }`

- **PNG を登録する。** `RID=$(uuidgen)` を設定し、`up png "$RID" image/png "$D/sample.png"`。`201`。`jq -c '.asset | [.mediaType, .bytes, .width, .height, .sha256]' "$D/png.json"` が `["image/png",<バイト数>,1400,1000,"<SHA-256>"]` で、バイト数は `wc -c < "$D/sample.png"`、SHA-256 は `shasum -a 256 "$D/sample.png"` と一致する。
- **JPEG を登録する。** `up jpeg "$(uuidgen)" image/jpeg "$D/sample.jpg"`。`201`。同じ比べ方で、`image/jpeg`、1400×1000、バイト数と SHA-256 が `sample.jpg` と一致する。
- **保存された行とオブジェクトを読む。** `ID=$(jq -r .asset.id "$D/png.json")` を設定する。`(cd apps/worker || exit 1; mise exec -- pnpm exec wrangler d1 execute DB --local --json --command "SELECT object_key, media_type, bytes, width, height, sha256 FROM assets WHERE id = '$ID'") >| "$D/row.json"`。`jq '.[0].results'` が一行で、`bytes` と `sha256` が `png.json` と同じ、`object_key` が `owners/<利用者 ID>/assets/$ID`。`(cd apps/worker || exit 1; mise exec -- pnpm exec wrangler r2 object get "instant-madori-local/$(jq -r '.[0].results[0].object_key' "$D/row.json")" --local --file "$D/object.png")` で取り出したファイルが、`cmp "$D/sample.png" "$D/object.png"` で何も出さない。
- **送り直す。** 同じ `RID` で `up png-replay "$RID" image/png "$D/sample.png"`。`201` で、`cmp "$D/png.json" "$D/png-replay.json"` が何も出さない。`assets` の行の数（`SELECT count(*) AS n FROM assets`）は変わらない。
- **別の画像で送り直す。** 同じ `RID` で `up reuse "$RID" image/jpeg "$D/sample.jpg"`。`422` で、本文が `{"error":"request_id_reused"}`。
- **受け付けない形式。** `up webp "$(uuidgen)" image/webp "$D/sample.png"`。`415` で、本文が `{"error":"unsupported_media_type"}`。
- **形式の食い違い。** `up mismatch "$(uuidgen)" image/png "$D/sample.jpg"`。`422` で、本文が `{"error":"invalid_image"}`。
- **大きすぎるファイル。** `{ cat "$D/sample.png"; head -c 7000000 /dev/zero; } >| "$D/big.png"` で 7,499,997 バイトを超えるファイルを作り、`up bytes "$(uuidgen)" image/png "$D/big.png"`。`413` で、本文が `{"error":"payload_too_large"}`。
- **幅が大きすぎる画像。** `up dimensions "$(uuidgen)" image/png "$D/wide.png"`。`422` で、本文が `{"error":"image_dimensions_too_large"}`。
- **Origin なし。** `curl -sS -o "$D/no-origin.json" -w '%{http_code}\n' -X POST "$API/assets?requestId=$(uuidgen)" -H 'content-type: image/png' --data-binary @"$D/sample.png"`。`403` で、本文が `{"error":"forbidden"}`。
- **拒んだ要求は何も残さない。** `assets` の行の数が、PNG と JPEG の登録の後と同じ（2件増えただけ）。
- **読み出す。** 読み出す関数 `down() { curl -sS -o "$D/${1}" -D "$D/${1}.headers" -w '%{http_code}\n' "$API/assets/${2}"; }` を定義する。`down read.png "$ID"`。`200` で、`cmp "$D/sample.png" "$D/read.png"` が何も出さない。`grep -iE '^(content-type|x-content-type-options|cache-control):' "$D/read.png.headers"` が `content-type: image/png`、`x-content-type-options: nosniff`、`cache-control: no-store` の三行を出す。JPEG も `down read.jpg "$(jq -r .asset.id "$D/jpeg.json")"` で `200`、`cmp "$D/sample.jpg" "$D/read.jpg"` が何も出さず、`content-type: image/jpeg`。
- **存在しない ID。** `down unknown.json "$(uuidgen | tr A-F a-f)"`。`404` で、本文が `{"error":"not_found"}`。
- **書き換えたオブジェクト。** 書き換え用に `up damaged "$(uuidgen)" image/png "$D/sample.png"` で `201`。`DID=$(jq -r .asset.id "$D/damaged.json")` を設定し、`(cd apps/worker || exit 1; mise exec -- pnpm exec wrangler r2 object put "instant-madori-local/owners/$(curl -fsS "$API/me" | jq -r .user.id)/assets/$DID" --local --file "$D/sample.jpg")` で中身を別の画像に替える。`down damaged-read.json "$DID"`。`500` で、本文が `{"error":"internal_error"}`。`dev.log` に、`"event":"api.unexpected_error"` で `asset hash` を含む行が一行出る。
- **別の利用者。** [SKILL.md の「片付け」](../SKILL.md#片付け)で止め、`MADORI_DEV_EMAIL=other@example.com` を付けて起動し直し、起動の確認で `dev.env` を作り直す（[本人確認](./sign-in.md)の「別の利用者」）。`down other-read.json "$ID"` と `down other-damaged.json "$DID"`。どちらも `404` で、`cmp "$D/unknown.json" "$D/other-read.json"` と `cmp "$D/unknown.json" "$D/other-damaged.json"` が何も出さない。
- **staging で登録する。** デプロイが終わった staging で、[SKILL.md の「検証用の利用者で指示を止める」](../SKILL.md#検証用の利用者で指示を止める)のとおりに `STG`・`HDRS`・`c` を設定する。`D="$EVIDENCE/staging-assets"; mkdir -p "$D"` にし、上の前提と同じく `sample.png` を `$D` に写す。`SRID=$(uuidgen)` を設定し、`c -o "$D/png.json" -w '%{http_code}\n' -X POST "$STG/api/assets?requestId=$SRID" -H "origin: $STG" -H 'content-type: image/png' --data-binary @"$D/sample.png"`。`201` で、ローカルと同じ比べ方で、`image/png`、1400×1000、バイト数と SHA-256 が `sample.png` と一致する。同じ `SRID` で出力先を `"$D/png-replay.json"` にして送り直すと `201` で、`cmp "$D/png.json" "$D/png-replay.json"` が何も出さない。`c -o "$D/read.png" -w '%{http_code}\n' "$STG/api/assets/$(jq -r .asset.id "$D/png.json")"` が `200` で、`cmp "$D/sample.png" "$D/read.png"` が何も出さない。

## Gotchas

- `curl --data-binary` は、`-H 'content-type: …'` を付けないと `application/x-www-form-urlencoded` を送るので、`415` になる。
- curl は 1 MB を超える本文に `Expect: 100-continue` を付ける。画面のポートのプロキシは、この見出しが付いた要求に開発者の認証を付けられず、Worker が `401 unauthenticated` を返す。`up` は `-H 'Expect:'` でこの見出しを外している。自分で curl を書くときも、1 MB を超える本文には付ける。ブラウザはこの見出しを送らない。
- `requestId` は query で送る。本文は画像そのものなので、JSON は送らない。`requestId` が無い、UUID でない、二つある、ほかの parameter がある場合は `400 invalid_request`。
- `image/jpg` は受け付けない。`image/jpeg` と書く。
- 幅と高さは、ファイルのヘッダーに書かれた値で、EXIF の向きを当てる前の値。縦長の写真が横長の値で返っても誤りではない。
- 画面を通さずに送った画像は、EXIF（位置情報を含む）を持ったまま保存される。画面は送る前に縮小と符号化し直しを行う予定で、その経路はまだ無い。
- 読み出しは、所有者の行が見つかってから R2 のオブジェクトを読み通してハッシュを確かめ、同じ版をもう一度読んで返す。オブジェクトを書き換えても、別の利用者には `404` のままで、`500` にはならない。
- 一覧用の縮小画像は無い。読み出しはいつも登録したバイト列そのもので、応答はキャッシュされない。
- staging で登録した資産は、未参照のアップロードの回収ができるまで残る。staging の確認は、一回の登録と一回の再送にとどめる。
