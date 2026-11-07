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

```text
core 起動
  -> session-store が保存済みセッションをコアへ戻す (role API loadSessions)
  -> history-store が自身の DB からセッションごとのメッセージを読む
  -> ctx.history.load(sessionId, messages)
  -> コアのメモリへ投入
```

- `ctx.history.load` は `history.append` 権限と `history-store` ロールが必要 (D37)。
- 復元できるのは `closed` 以外のセッション。**TBD**: 自動復元するか UI の明示要求にするか (D22)。
- 実行中だったターンは復元しない (中断扱い)。
- session-store が無い場合、セッション ID が存在しないため履歴は復元できない。履歴の復元には session-store が必要。

## 4. セッションの保存

- session-store は `session.created` / `session.closed` / `session.forked` と `session.setModel` を購読、またはコアから role API で保存依頼を受ける。
- 復元はコアが role API `loadSessions()` を呼ぶ。コアがセッション状態の所有者であり、モジュールが勝手にコア状態を作らない。
- `closed` は削除せず状態として保存する。

## 5. ジョブ結果

- コアはジョブのメタデータ (ID / 状態 / 所有者) をメモリに持つ。
- 結果本体は result-store に保存する。コアは `resultRef` を保持する。
- result-store が無い場合はコアがメモリに持つ。再起動で消える。
- ジョブの状態そのものは永続化しない。再起動時に running だったジョブは復元されない (結果だけが DB に残る場合はある)。**TBD**: 孤立結果の TTL 削除 (D42)。

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
  state       TEXT NOT NULL,              -- active / idle / closed / error
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
  created_at   INTEGER NOT NULL,
  UNIQUE (session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ordinal);

CREATE TABLE IF NOT EXISTS job_results (
  job_id      TEXT PRIMARY KEY,
  tool        TEXT NOT NULL,
  status      TEXT NOT NULL,               -- done / failed / cancelled
  summary     TEXT NOT NULL,
  size        INTEGER NOT NULL,
  content     BLOB NOT NULL,
  created_at  INTEGER NOT NULL
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
