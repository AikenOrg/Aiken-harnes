# 10. ストレージ

## 1. 方針

- **実行中の履歴の唯一の正はコアのメモリ。** ループは毎ターンそこから読む。コアは単体で起動できる。
- `history-store` は `message.appended` を購読して書き出すだけの投影 (projection)。読み取りの権限判定はコアが行う。
- `session-store` はセッション情報を永続化し、起動時にコアへ戻す。
- `result-store` は非同期ジョブの結果本体を保存する。無ければコアがメモリに持つ (再起動で消える)。
- SQLite を使う場合、書き込みはそのモジュール内の単一キューで直列化する。WAL モード。
- 履歴・セッション・結果は同じ DB に置いてよいが、テーブルと責務は分ける。SQLite モジュールが 3 ロールを兼ねる想定。

## 2. ロールとモジュール

| モジュール例 | ロール | 必須 |
|---|---|---|
| `sqlite` | `history-store`, `session-store`, `result-store` | 永続化するなら推奨 |
| (不要) | なし | コアが既定でメモリ履歴を持つ |
| `compactor-llm` | `compactor` | compaction を使うなら |
| `log-jsonl` | なし (history.read + 購読) | 任意 |

- 1 モジュールが複数ロールを持ってよい。
- 排他ロールは「同時に 1 モジュール」。1 モジュールが複数の排他ロールを持つことは許す。
- history-store / session-store / result-store はどれも必須ではない。永続化が不要ならコアだけで動く。
- result-store を必須扱いにしたい場合は、そのモジュールを `critical: true` にする。

## 3. 履歴の流れ

### 3.1 追記

```text
core.history.append(sessionId, message)
  -> コアのメモリへ追記
  -> message.appended { v:1, messageId } を発行
  -> history-store が購読
  -> ctx.history.get(sessionId, messageId) で本文を取得
  -> SQLite へ INSERT
```

- イベントには本文を載せない。永続化モジュールは `history.read` 権限でコアから本文を引く。
- 追記は追記のみ。既存行を更新しない。
- 1 メッセージにつき 1 回。通知の一括追記でもメッセージごとに発行する。

### 3.2 書き換え (compaction)

```text
compactor -> ctx.history.rewrite(sessionId, messages, reason)
  -> コアが権限 (history.rewrite + compactor ロール) を検査
  -> コアのメモリを置換
  -> history.rewritten { v:1, reason, beforeCount, afterCount } を発行
  -> history-store が ctx.history.read(sessionId) で全文を取得
  -> 1 トランザクションで DELETE + INSERT
```

- 書き換えの正は常にコア。history-store は事後投影。
- 書き換え途中で失敗したらロールバックし、コアのメモリは保持する (永続化だけ古い状態になる)。再試行は次回の `history.rewritten` か起動時の再同期。

### 3.3 復元

復元は UI の明示要求が基本。起動時に自動で開くのは `config.restore: "last"` のときだけ (既定 `"none"`)。

```text
UI -> ctx.session.listRestorable()        # session-store が一覧を返す
UI -> ctx.session.restore(sessionId)
  -> コアが session-store に restoring での作成を依頼
  -> session-store が Session(state=restoring) を返す (履歴は空)
  -> コアが history-store の role API restoreSession(sessionId) を呼ぶ
  -> history-store が DB からメッセージを読み、ctx.history.restore(sessionId, messages)
  -> コアが履歴を投入し、状態を idle にする
```

- `ctx.history.restore` は `history.restore` 権限と `history-store` ロールが必要。`restoring` かつ履歴が空のセッションにだけ実行できる (D37)。
- 稼働中のセッションは上書きできない。偽の履歴を注入させない。
- 復元してもターンループは再開しない。ユーザー入力か、保留中の通知による autoWake を待つ。
- result-store があれば、復元前に動いていたジョブを `failed (code: "interrupted")` にし、完了済みで未通知だった通知を再キューに積む。
- result-store が無い場合、復元で通知の状態は戻らない。ジョブはメモリのみで、再起動時に消える。
- 復元できるのは `closed` 以外のセッション。自動復元は `config.restore: "last"` のときだけ。
- 実行中だったターンは復元しない (中断扱い)。
- session-store が無い場合、セッション ID が存在しないため履歴は復元できない。履歴の復元には session-store が必要。

## 4. セッションの保存

- session-store は `session.created` / `session.closed` / `session.forked` と `session.setModel` を購読、またはコアから role API で保存依頼を受ける。
- 一覧は role API `listRestorable()`、直前のセッションは `latestRestorable()` で返す。コアがセッション状態の所有者であり、モジュールが勝手にコア状態を作らない。
- 復元は UI の `session.restore(id)` か、`config.restore: "last"` の起動時だけ。復元時は session-store が `restoring` でセッションを作り、history-store が履歴を入れる。
- `closed` は削除せず状態として保存する。
- `session.delete` は `closed` のセッションだけを対象にする。`session.deleted` を契機に、history-store と result-store が messages / job_results を掃除する (DB では ON DELETE CASCADE)。
- 一括削除 API は作らない。複数消す場合は `session.delete` を繰り返し呼ぶ (誤操作で大量削除しないため)。

## 5. ジョブ結果

- 実行中のジョブ状態の正はコアのメモリ。
- result-store は結果本体に加え、復元に必要な最小メタデータ (`session_id` / `status` / `notified`) を保存する。
- ジョブ作成時に `running` を記録し、完了時に状態・summary・size・content を更新する。通知したら `notified = 1` にする。
- 状態は `running / done / failed / cancelled` の 4 つのまま。復元時に `running` の行は `failed (code: "interrupted")` にする。
- `done` / `failed` / `cancelled` かつ `notified = 0` の行は通知キューへ戻す。
- result-store が無い場合はコアがメモリに持つ。再起動で消えるため、復元時のジョブ回復も通知の回復もできない。
- セッション削除時は、そのセッションの `job_results` 行を削除する。
- `jobs.resultTtlDays` (既定 30 日) で、**終端かつ通知済み**の古い行を掃除する。running と未通知は対象外。

## 6. SQLite 接続と同時書き込み

```ts
const db = new Database(path);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");
```

- 書き込みは単一の非同期キューで直列化する。
- 読み取りは書き込みキューを待たない (WAL のスナップショット読み取り)。
- トランザクションは `BEGIN IMMEDIATE`。
- キュー内の 1 件が失敗しても後続を止めない。失敗は記録し、可能なら再試行する。
- 他のモジュールは SQLite に直接触れない。API 経由で依頼する。

## 7. スキーマ (提案)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES sessions(id),
  state       TEXT NOT NULL,              -- restoring / active / idle / closed / error
  model       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  ordinal      INTEGER NOT NULL,           -- セッション内の連番
  role         TEXT NOT NULL,              -- system / user / assistant / tool / notification
  blocks_json  TEXT NOT NULL,              -- Block[] を JSON で保存
  interrupted  INTEGER NOT NULL DEFAULT 0, -- キャンセルで途切れたメッセージ
  created_at   INTEGER NOT NULL,
  UNIQUE (session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ordinal);

CREATE TABLE IF NOT EXISTS job_results (
  job_id           TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_session_id TEXT NOT NULL,
  tool             TEXT NOT NULL,
  status           TEXT NOT NULL,          -- running / done / failed / cancelled
  summary          TEXT,
  size             INTEGER,
  content          BLOB,
  notified         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  ended_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON job_results(session_id, status, notified);

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
- `ordinal` はセッション内で単調増加。復元時も維持する。
- `job_results` は result-store の実体。`read_result` はここを引く。
- ログは任意 (`log-store` ロールは廃止。ログモジュールは権限と購読で動く)。

## 8. 保存先

```jsonc
{
  "modules": [
    { "use": "./modules/sqlite.js", "config": { "path": "./data/harness.sqlite" } }
  ]
}
```

- 保存先はモジュール設定 (`config.path`) で決める。プロセスの作業ディレクトリ基準。
- Windows のドライブレター・UNC パスを扱えること。
- ディレクトリが無ければモジュールが作成する。失敗したら `critical` なら起動中止。

## 9. マイグレーション

- `PRAGMA user_version` でスキーマ版を管理する。
- 起動時に版を比較し、古ければ順方向マイグレーションを実行する。
- 破壊的変更はバックアップを取ってから行う。
- 版が新しすぎる場合は起動を中止する (ダウングレード禁止)。

## 10. 障害時

- 書き込み失敗は記録する。コアのメモリは正なので、ターンは継続できる。永続化だけ失われる。
- DB を open できない場合、そのモジュールが `critical` なら起動中止。そうでなければ `module.disabled` で続行。
- WAL のチェックポイントは SQLite に任せる。停止時にキューを drain してから閉じる。
