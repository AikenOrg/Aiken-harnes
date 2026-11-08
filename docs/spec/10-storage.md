# 10. ストレージ

## 1. 方針

- **実行中の履歴の唯一の正はコアのメモリ。** ループは毎ターンそこから読む。
- `store-sqlite` は `history-store` / `session-store` / `result-store` を兼任する永続化モジュール。
- `bun:sqlite` を使い、DB への書き込みはこのモジュール内の 1 本のキューで直列化する。
- WAL モード。`journal_mode=WAL` / `synchronous=NORMAL` / `foreign_keys=ON` / `busy_timeout`。
- DB の既定置き場所はユーザーデータディレクトリ:
  - Linux: `$XDG_DATA_HOME/next-harness/harness.sqlite` (未設定なら `~/.local/share/...`)
  - Windows: `%APPDATA%\next-harness\harness.sqlite`
- config の `store-sqlite.config.path` で変更できる。

## 2. モジュール

`src/modules/store-sqlite`。

```jsonc
{
  "name": "store-sqlite",
  "roles": ["history-store", "session-store", "result-store"],
  "critical": true,
  "subscribes": [
    "message.appended", "history.rewritten", "session.*", "job.*",
    "tool.completed", "turn.ended", "core.stopping"
  ],
  "permissions": [
    { "cap": "history.read" },
    { "cap": "history.restore" },
    { "cap": "fs.write", "paths": ["."] }
  ]
}
```

- `critical: true`。DB を開けない、または `schema_version` が未知なら起動エラー。
- `message.appended` は `messageId` だけを持つため、`ctx.history.get` で本文を取得して保存する。
- `history.rewritten` は `ctx.history.read` で全文を取得し、1 トランザクションで置き換える。
- `core.stopping` で書き込みキューを flush する。`dispose` でも flush してから close する。

## 3. スキーマ

`schema_version(version)` で管理する。現在は `1`。

```sql
CREATE TABLE schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  state       TEXT NOT NULL,              -- restoring / active / idle / closed / error
  model       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  meta_json   TEXT
);

CREATE TABLE messages (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  id           TEXT NOT NULL,
  role         TEXT NOT NULL,
  content_json TEXT NOT NULL,              -- Block[] を JSON で保存
  interrupted  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE job_results (
  job_id      TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  call_id     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  status      TEXT NOT NULL,               -- running / done / failed / cancelled
  notified    INTEGER NOT NULL DEFAULT 0,
  summary     TEXT,
  size        INTEGER,
  result      BLOB,
  error_code  TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
```

- `messages.seq` はセッション内の順序。追記時に `MAX(seq)+1`、rewrite 時は 1..N を振り直す。
- `job_results` はジョブのメタデータと結果本体を兼ねる。
- `session.deleted` で `sessions` を削除すると、`messages` / `job_results` は外部キーのカスケードで消える。

## 4. ロール API

コアは `ModuleHost.callRole(role, method, args)` で呼ぶ。

### 4.1 session-store

| メソッド | 引数 | 返り値 |
|---|---|---|
| `listRestorable()` | — | `Session[]` (`closed` 以外、updated_at 降順) |
| `latestRestorable()` | — | `Session \| undefined`。`parent_id IS NULL` の最上位のみ |
| `load(id)` | sessionId | `Session \| undefined` |

`meta_json` には `autoWake` / `lastInputTokens` を保存できる。

### 4.2 history-store

| メソッド | 引数 | 返り値 |
|---|---|---|
| `loadMessages(sessionId)` | sessionId | `Message[]` (seq 昇順) |

### 4.3 result-store

| メソッド | 引数 | 返り値 |
|---|---|---|
| `put(job, result?)` | Job / 結果本体 | — |
| `get(id, {offset?, limit?})` | jobId | `JobResult \| undefined` |
| `listBySession(id, status?)` | sessionId | `Job[]` |
| `listUnnotified(id)` | sessionId | `Job[]` |
| `markNotified(ids)` | jobId[] | — |
| `deleteBySession(id)` | sessionId | — |
| `deleteExpired(ttlDays)` | ttlDays | 削除件数 |
| `flush()` | — | — |

- `result-store` が無い構成では `MemoryResultStore` が使われ、再起動でジョブ状態・結果・通知状態は戻らない。

## 5. 復元の流れ

UI は `session.listRestorable()` で一覧を得て、`session.restore(id)` を要求する。`config.restore: "last"` のときだけ起動時に自動で行う。

```text
session.restore(id)
  -> session-store.load(id) で保存済み Session を取得
  -> コアが state=restoring で Session を作成 (user.message 拒否)
  -> 保存モデルのプロバイダーが現 config に無ければ error で失敗
  -> history-store.loadMessages(id)
  -> 結果の欠けた末尾 tool_call に interrupted の tool_result を補う
  -> ctx.history.restore でコアへ投入
  -> result-store.listBySession(id)
       running          -> failed (code: "interrupted") に更新
       terminal & !notified -> 通知キューへ
  -> state=idle
  -> session.restored を発行
  -> ターンループは自動再開しない
```

- `history.restore` は `history.restore` 権限 + history-store ロール、`state=restoring` かつ履歴が空のセッションだけ許可。
- 復元失敗時: セッションを `error` にして UI から再試行できる。`session.closed` は発行しない。
- 再試行時は error 状態のセッションとメモリ履歴を捨ててからやり直す。
- 保存モデルのプロバイダーが無い場合も `error`。エラーメッセージにモデル ID を含める。
- 強制終了で `tool_call` だけが残った場合、復元時に `tool_result` (`isError: true`, `interrupted by restart`) を補い、次のモデル呼び出しを壊さない。

## 6. 掃除

- 起動時と既定 6 時間ごとに `deleteExpired(ttlDays)` を実行する。
- 対象は `status != 'running'` かつ `notified = 1` かつ `finished_at < now - ttlDays`。
- 既定 `ttlDays = 30`。未通知・実行中は削除しない。
- `session.delete` は `closed` のみ。DB では `session.deleted` を購読して `sessions` を削除し、カスケードで messages / job_results を消す。

## 7. 書き込みの直列化

- すべての書き込みを `#queue` に積み、前の処理の完了後に実行する。
- メッセージ追記は 50ms または 100 件でバッチ化し、1 トランザクションで insert する (`batchMs` / `batchSize` で変更可)。他の書き込みの前には pending バッチを flush するため、順序は保たれる。
- `tool.completed` と `turn.ended` でも flush し、強制終了時の損失範囲を小さくする。
- 負荷テスト: 10 セッション × 1,000 メッセージを追記し、件数・seq の連続性・SQLITE_BUSY の不在を確認。
- `core.stopping` / `dispose` で flush する。

## 8. read ツールとの関係

DB を作業ディレクトリ内に置く場合に備え、read ツールは `*.db` / `*.sqlite` / `*.sqlite3` と `-wal` / `-shm` を拒否する。既定では DB はユーザーデータディレクトリに置く。

## 9. Windows

- パスは `%APPDATA%\next-harness\harness.sqlite` を既定とする。
- `node:path` の `join` / `resolve` を使い、区切り文字をハードコードしない。
- Windows 実機での確認は未実施 (M5)。
