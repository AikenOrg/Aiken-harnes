# 15. Web UI (`ui-web`)

2026-11-08 時点。`ui-web` は `ui` ロールの builtin モジュールで、ハーネスを HTTP + WebSocket で操作・観察する最小の画面を提供する。コアは UI の知識を持たない。

## 1. 構成

| 項目 | 内容 |
|---|---|
| モジュール | `src/modules/ui-web` |
| ロール | `ui` |
| builtin | `true`（モジュール承認を省略） |
| サーバー | `Bun.serve` |
| クライアント | 素の TypeScript + `@material/web@2.5.0` |
| 配色 | `@material/material-color-utilities@0.4.0` |
| バンドル | 初回 `/app.js` 要求時に `Bun.build`（成果物はコミットしない） |

設定:

```json
{
  "use": "../src/modules/ui-web",
  "config": {
    "host": "127.0.0.1",
    "port": 8787,
    "seedColor": "#6750A4",
    "approvalTimeoutMs": 300000,
    "historyLimit": 200
  }
}
```

`host` の既定は `127.0.0.1`、`port` の既定は `8787`。`seedColor` は M3 のシード色で、ライト / ダーク両方の `--md-sys-color-*` を生成する。

## 2. `ui` ロールに追加した API

`ui` は「人間の操作」として全セッションを扱える。ただし必ずコアの `ctx` API を通す。

| API | 権限 | 内容 |
|---|---|---|
| `ctx.session.list()` | `session.manage` | 全セッション（木構造の材料） |
| `ctx.session.models()` | `session.manage` | 新規作成に使えるモデル一覧 |
| `ctx.session.send(id, text)` | `session.input` + `ui` | ユーザー入力 |
| `ctx.session.cancel(id)` | `session.input` + `ui` | 現在のターンのキャンセル |
| `ctx.jobs.list(sessionId, status?)` | `job.read` + `ui` | セッションが起動したジョブ |
| `ctx.jobs.read(jobId, {offset, limit})` | `job.read` + `ui` | ジョブ結果 |
| `ctx.jobs.cancel(jobId)` | `job.cancel` + `ui` | 実行中ジョブのキャンセル |

- `ctx.session.close` / `delete` は Harness の完全な後始末（ターン中断、エージェントジョブ、キュー、プロンプト断片）に委譲する。
- `delete` は `closed` のセッションだけを許可する。
- `user` によるキャンセルは `user.cancel` イベントを発行する。
- ジョブの参照・キャンセルは `ui` ロールに限定する。AI のツールには付与しない。

## 3. WebSocket プロトコル

接続先は `ws://<host>:<port>/ws`。JSON のテキストフレームだけを使う。

### 3.1 サーバー → クライアント

| type | 内容 |
|---|---|
| `snapshot` | 接続直後と再接続後。セッション、選択中セッションの履歴、ジョブ、復元候補、モデル、未応答の承認 |
| `event` | コアのイベントをそのまま。`model.delta` は 40ms ごとにまとめて送る |
| `approval.request` | モジュール承認の要求 |
| `approval.resolved` | 承認の解決（別クライアントの画面を閉じるため） |

`snapshot` の形:

```ts
type Snapshot = {
  type: "snapshot";
  sessions: Session[];
  selectedSessionId?: string;
  messages: Message[];
  messageCount: number;
  jobs: Job[];
  restorable: Session[];
  models: ModelInfo[];
  approvals: Array<{ id: string; request: ApprovalRequest }>;
};
```

### 3.2 クライアント → サーバー

```ts
type Command = { id: string; type: string; payload?: unknown };
type Response =
  | { id: string; ok: true; result?: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };
```

| type | payload | 内容 |
|---|---|---|
| `snapshot` | `{selectedSessionId?}` | 状態の再取得 |
| `session.select` | `{sessionId}` | 履歴・ジョブを含む選択結果 |
| `session.create` | `{model?}` | 新規セッション |
| `session.restore` | `{sessionId}` | SQLite から復元 |
| `session.close` | `{sessionId}` | 再帰的に閉じる |
| `session.delete` | `{sessionId}` | `closed` のみ |
| `session.send` | `{sessionId, text}` | 入力をキューへ積む |
| `session.cancel` | `{sessionId}` | 現在のターンを中断 |
| `history.read` | `{sessionId, limit?, before?}` | 履歴のページング |
| `job.list` | `{sessionId}` | ジョブ一覧 |
| `job.cancel` | `{jobId}` | 実行中ジョブのキャンセル |
| `job.read` | `{jobId, offset?, limit?}` | 結果の取得 |
| `approval.respond` | `{approvalId, approved, reason?}` | 承認 / 拒否 |

- 状態を変える操作はすべて WebSocket 経由。HTTP は `GET` / `HEAD` の静的配信だけ。
- 再接続時はイベントを再送せず、必ず `snapshot` を取り直す。
- `model.delta` は 40ms のバッファで結合する。`turn.ended` など同じターンの終端イベントの前にフラッシュする。
- 承認は接続前でもキューに残り、`snapshot` に含まれる。タイムアウトは既定 5 分で拒否（fail closed）。

## 4. 安全要件

ローカルの WebSocket は「PC のコマンド実行口」になり得るため、次を必須とする。

1. **bind は `127.0.0.1` のみ（既定）。** `0.0.0.0` は config で明示した場合だけ。警告を出す。
2. **WebSocket の `Origin` を検証する。** 許可するのは `http://127.0.0.1:PORT` と `http://localhost:PORT` だけ。`Origin` が無い非ブラウザ接続は許可する（同一マシンのクライアント）。
3. **`Host` を検証する。** `127.0.0.1:PORT` と `localhost:PORT` だけ。DNS rebinding を防ぐ。
4. **状態変更は WebSocket のみ。** HTTP は `GET` / `HEAD` の静的配信だけで、`POST` などは 405。
5. **CORS を許可しない。** `Access-Control-Allow-Origin` を返さない。
6. **トークン認証は採用しない（ユーザー判断）。** 同一マシンの他プロセス・他ユーザーは接続できる。共有マシンでは使わない。

追加ヘッダー: `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、CSP。

### 4.1 `0.0.0.0` の扱い

M5 では `0.0.0.0` を指定しても、`Origin` / `Host` は loopback のまま固定する。したがって LAN のブラウザからは接続できない。外部公開が必要になった時点で、許可 Origin/Host の設定と認証をまとめて設計する（M6 以降）。

## 5. 画面

1 ページ。左がセッションの木、中央が会話、右がジョブ / イベントのタブ。

- 左: 親子の入れ子、状態チップ、新規・復元・閉じる・削除。
- 中央: メッセージ、ツール呼び出し / 結果の折りたたみ、`interrupted` 表示、ストリーミング、入力欄、キャンセル。
- 右: ジョブ（状態、ツール、経過時間、キャンセル、結果）とイベント（種別フィルタ、新しい順、`model.delta` を除く）。
- モーダル: モジュール承認（権限、変更、警告、承認 / 拒否）。

## 6. Material Design 3

- `@material/web` は `src/modules/ui-web/client/components.ts` の薄いラッパーだけから使う。画面コードに `<md-*>` を直接書かない。
- 使用部品: `md-list` / `md-list-item`、`md-tabs` / `md-primary-tab`、`md-filled-button` / `md-outlined-button` / `md-text-button`、`md-outlined-text-field`、`md-dialog`、`md-linear-progress`。
- `@material/web` に適切な部品がないセッションの木、カード、状態チップ、トーストは M3 トークンに従って自前で作る。
- 色は `--md-sys-color-*` を使い、`prefers-color-scheme` でライト / ダークを切り替える。
- MUI は使わない。

## 7. 制限

- スマホ向けの最適化、複数ユーザー、リモートアクセスは対象外。
- 履歴の編集、ファイルビューア、ログ検索は対象外。
- チーム固有の画面は対象外。
- `0.0.0.0` の実質的なリモート利用はできない（4.1）。
