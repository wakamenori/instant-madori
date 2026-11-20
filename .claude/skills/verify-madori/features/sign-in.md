# 本人確認

ローカルでは Vite のプロキシが Cloudflare Access の代わりになり、開発者として署名したトークンを API の要求に付ける。Worker は本番と同じ処理でトークンを確かめ、利用者を決める。トークンの無い要求と、許していない Origin からの書き込みは拒む。

## Sub-features

- `auth-health`：`/api/health` は認証なしで応答する。
- `auth-me`：`/api/me` が、署名した利用者を返す。
- `auth-reject`：トークンの無い要求は `401` になる。
- `auth-origin`：Origin の無い書き込みは `403` になる。
- `auth-routes`：未知のパスは `404`、許していないメソッドは `405` になる。
- `auth-other-user`：別のメールアドレスで起動すると、別の利用者として扱われ、前の利用者の案件は見えない。

## How to get to it (user POV)

- 画面から使う API は、5173 番のプロキシを通る。
- 8787 番の Worker へ直接送る要求には、トークンが付かない。

## Driving it with curl

Preconditions:

- 状態確認が通っている。
- `D="$EVIDENCE/sign-in"` と `J='content-type: application/json'` を設定し、`$D` がある。

- **health。** `curl -sS -o "$D/health.json" -w '%{http_code}\n' http://127.0.0.1:8787/api/health`。`200` で、本文が `{"status":"ok","service":"worker"}`。
- **me。** `curl -sS -o "$D/me.json" -w '%{http_code}\n' http://127.0.0.1:5173/api/me`。`200` で、`jq -r .user.email "$D/me.json"` が `dev@example.com`。
- **拒否。** `curl -sS -o "$D/reject.json" -w '%{http_code}\n' http://127.0.0.1:8787/api/me`。`401` で、本文が `{"error":"unauthenticated"}`。
- **Origin の無い書き込み。** `curl -sS -o "$D/no-origin.json" -w '%{http_code}\n' -X POST http://127.0.0.1:5173/api/projects -H "$J" -d "{\"requestId\":\"$(uuidgen)\"}"`。`403` で、本文が `{"error":"forbidden"}`。
- **経路。** `curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/api/health` が `405`。`curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5173/api/missing` が `404`。
- **別の利用者。** 先に [案件](./projects.md)の「作る」を済ませておく。片付けてから `MADORI_DEV_EMAIL=other@example.com` を付けて起動し直す。`curl -sS -o "$D/me-other.json" -w '%{http_code}\n' http://127.0.0.1:5173/api/me` の `user.email` が `other@example.com` で、`user.id` が `me.json` と違う。`/api/projects` の `projects` は、起動の確認がこの利用者に作る「起動確認」の案件だけで、前の利用者の案件を含まない。前の利用者の案件のパターン一覧 `/api/projects/<その id>/patterns` は `404`。

## Gotchas

- `/api/me` は、初めて来た利用者の行を作る。同じ利用者なら、何度呼んでも同じ行を返す。
- 同じ worktree で起動し直しても、ローカルの D1 の中身は残る。別の利用者に案件が見えないのは、無いからではなく、持ち主が違うから。
- `.local/access-key.json` と `apps/worker/.dev.vars` は `pnpm dev` が作る。ほかの方法で作った `.dev.vars` があると、上書きせずに止まる。
