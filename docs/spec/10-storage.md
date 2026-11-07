# 10. ストレージ

## 1. 方針

- SQLite はコアではなく**必須モジュール**が持つ。
- SQLite モジュールが唯一の書き込み担当。他のモジュールは API 経由で依頼し、内部キューで順番に処理する。
- WAL モードを使う。
- 履歴・セッション・ジョブ結果・ログは同じ DB に置いてよいが、テーブルと責務は分ける。

## 2. ロールとモジュール構成

| モジュール例 | ロール | 必須 |
|---|---|---|
| `history-sqlite` | `history-store`, `session-store` | 必須構成では必須 |
| `history-memory` | `history-store` | 既定 (メモリ) |
| `result-sqlite` | `result-store` | 非同期ツールを使うなら必須 |
| `log-sqlite` | `log-store` | 任意 |

- 1 モジュールが複数ロールを持ってよい (例: history-store + session-store + result-store)。
- 排他ロールは「同時に 1 モジュール」の意味。1 モジュールが複数の排他ロールを持つことは許す。
- 非同期ツールを使う構成で result-store が無い場合、起動時に設定エラーとする。**TBD**: メモリフォールバック。

## 3. 接続と同時書き込み

```ts
const db = new Database(path);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");
```

- 書き込みは単一の非同期キューで直列化する。`await queue.push(() => stmt.run(...))` の形。
- 読み取りは書き込みキューを待たない (WAL のスナップショット読み取り)。
- トランザクションは `BEGIN IMMEDIATE` を使い、書き込み競合を早期に検出する。
- キュー内の 1 件が失敗しても、後続を止めない。失敗は呼び出し元へ返し、`ctx.log` に記録する。

## 4. スキーマ (提案)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES sessions(id),
  state       TEXT NOT NULL,              -- active / idle / closed / error
  model       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  ordinal     INTEGER NOT NULL,           -- セッション内の連番
  role        TEXT NOT NULL,              -- system / user / assistant / tool / notification
  blocks_json TEXT NOT NULL,              -- Block[] を JSON で保存
  created_at  INTEGER NOT NULL,
  UNIQUE (session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ordinal);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  tool_call_id     TEXT NOT NULL,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL,         -- running / done / failed / cancelled
  summary          TEXT,
  size             INTEGER,
  result_ref       TEXT,
  cancel_by        TEXT,
  created_at       INTEGER NOT NULL,
  ended_at         INTEGER
);

CREATE TABLE IF NOT EXISTS job_results (
  ref        TEXT PRIMARY KEY,            -- resultRef
  job_id     TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  content    BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  level      TEXT NOT NULL,
  source     TEXT NOT NULL,
  message    TEXT NOT NULL,
  meta_json  TEXT
);
```

- `blocks_json` は `Block[]`。スキーマ変更に強い。
- `ordinal` はセッション内で単調増加。通知の末尾追記も同じ採番。
- `result_ref` は `job_results.ref`。本体は BLOB (UTF-8 テキストまたはバイナリ)。
- セッションの `parent_id` は外部キー。親削除はしない (close のみ)。

## 5. 履歴の操作

- `append`: `ordinal = max + 1` を同一トランザクションで採番する。競合は `BEGIN IMMEDIATE` で直列化。
- `appendBatch`: 複数メッセージを 1 トランザクションで追記し、ordinal を連番で振る。通知の一括追記に使う。
- `read`: `ordinal` 昇順。`limit` は末尾から。`before` はカーソル。
- `rewrite`: compactor のみ。全置換を 1 トランザクションで行い、`history.rewritten` を発行する。失敗時はロールバック。
- 履歴は追記専用が原則。書き換えは compaction のときだけ。

## 6. セッションの復元

- 起動時、`session-store` は `closed` 以外のセッションを復元できる。**TBD**: 自動復元するか、UI からの明示要求にするか。
- 復元時はモデルと状態のみ。実行中だったターンは復元しない (中断扱い)。
- 実行中だったジョブ (`status = running`) は、起動時に `cancelled` へ遷移させる。`by: "system"`、理由は `"interrupted"` として `job.cancelled` を発行する。**TBD**: 再開を許すか。

## 7. 保存先

```jsonc
{
  "modules": {
    "history": {
      "path": "history-sqlite.js",
      "config": { "db": "./data/harness.sqlite" }
    }
  }
}
```

- 保存先は履歴モジュールが決めるか、config.json に書く。両方ある場合は config を優先する。
- 相対パスはプロセスの作業ディレクトリ基準。Windows のドライブレター・UNC パスを扱えること。
- ディレクトリが無ければモジュールが作成する。作成に失敗したら `critical` なら起動中止。

## 8. マイグレーション

- `PRAGMA user_version` でスキーマ版を管理する。
- 起動時に版を比較し、古ければ順方向マイグレーションを実行する。
- 破壊的変更はバックアップを作ってから行う。
- 版が新しすぎる場合は起動を中止する (ダウングレード禁止)。

## 9. 障害時

- 書き込み失敗は呼び出し元へ例外を返す。コアはターンを失敗させ、`turn.ended` (`error`) を発行する。
- DB ファイルが壊れている / open できない場合、history-store が `critical` なら起動中止。
- WAL のチェックポイントは SQLite に任せる。明示的な `wal_checkpoint` は停止時のみ行う。
