# 06. イベント

## 1. エンベロープ

```ts
type EventEnvelope<TType extends string = string, TPayload = unknown> = {
  id: string;          // 一意 (例: evt_<bootId>_<seq>)
  seq: number;         // コア内で単調増加
  ts: number;          // epoch ms
  type: TType;         // 例: "tool.completed"
  source: string;      // "core" またはモジュール名
  sessionId?: string;  // セッションに紐づく場合のみ
  payload: TPayload;
};
```

- `seq` はコアが採番する。モジュールは採番しない。
- `id` は `evt_<bootId>_<seq>` 形式。`bootId` は起動ごとにランダムな短い文字列、`seq` はその起動内で単調増加。再起動してもログ上で衝突しない。
- `sessionId` はセッションに紐づくイベントだけに付ける。
- ペイロードに秘密情報・API キー・プロンプト本文を含めない。

## 2. ペイロードの原則

ペイロードは **`src/protocol/events.ts` の zod スキーマが唯一の正**。TypeScript 型はそこから導出し、この文書の一覧も `bun run docs:gen` で生成する。

1. **本文を持たず、ID で参照する。**
   - `message.appended` は `{ v, messageId }` のみ。本文は `ctx.history.get(sessionId, messageId)` で取得する。
   - `history.rewritten` は件数のみ。内容は `ctx.history.read` で取得する。
   - `agent.message` は `jobId` のみ（本文なし）。
   - `tool.requested` は引数を持たない。承認に必要な引数は `tool.before` フックが受け取る。
   - ジョブ結果はイベントに載せず、`read_result(jobId)` で取得する。
2. **全ペイロードに `v: 1` を必須で付ける。** 将来の破壊的変更に備える。加算的な変更は `v: 1` のまま、削除・型変更は版を上げる。
3. **エラーは `{ code, message }` に統一する。** `model.failed`、`job.failed`、`tool.failed`、`module.failed`、`permission.*` が該当する。
4. **大きなデータを載せない。** 例外は `model.delta` の差分テキストと `user.message` の入力本文のみ。どちらも永続的な本文の参照元ではない。

フィールドの完全な一覧: **[06-events.generated.md](06-events.generated.md)** (自動生成)。

## 3. 配信

- 購読は型名またはワイルドカード (`tool.*`) で行う。manifest の `subscribes` と一致しない購読は拒否する。
- 配信順は発行順。`seq` の昇順で届く。
- 購読者の例外は隔離する。他の購読者への配信は続行し、`ctx.log` に記録する。
- 購読ハンドラは同期実行を基本とし、重い処理は自分でキューへ逃がす。コアのターンをブロックしない。
- `model.delta` は既定で購読されない。UI がストリーミング表示を望む場合だけ明示購読する。
- モジュールはコア予約イベントを発行できない。独自イベントは `module.<name>.<event>` のみ。

## 4. イベントの意味

### 4.1 ユーザー入力

- `user.message`: ユーザー入力。コアは履歴へ追記してターンを開始する。
- `user.cancel`: ユーザーによるキャンセル。実行中ターンとジョブを `by: "user"` で止める。

### 4.2 セッション / ターン

- `session.created` / `session.closed` / `session.forked` / `session.deleted` / `session.restored`: コアがセッション状態を変更した。`session.deleted` は履歴と結果の掃除を、`session.restored` は復元完了を store に伝える。
- `turn.started` / `turn.ended`: 1 ターンの開始と終了。`turnId` で対応付ける。`turn.ended.reason` は `completed` / `cancelled` / `error` / `context_overflow`。`context_overflow` のとき履歴は切り捨てない。

### 4.3 モデル

- `model.requested`: 送信直前。`promptHash` は static 部分のハッシュ。
- `model.delta`: ストリーミング差分。購読は任意。
- `model.completed`: `usage` と `stop` を含む。
- `model.failed`: `error: { code, message }`。

### 4.4 ツール / ジョブ

- `tool.requested` → `tool.started` → `tool.completed` / `tool.failed` / `tool.cancelled`。これは「ツール呼び出しがモデルに返るまで」のライフサイクル。
- async ツールの `tool.completed` は **jobId を返した時点**で発行し、payload に `jobId` を含める。ジョブの終端では `tool.*` を発行しない。
- `job.done` / `job.failed` / `job.cancelled` は `callId` を持ち、元の tool_call と相関する。
- `job.done` / `job.failed` / `job.cancelled` はジョブの状態遷移。`job.notified` は通知を履歴へ追記したときに発行する。
- `job.cancelled` は必ず `by` を持つ。

### 4.5 履歴

- `message.appended`: 追記されたメッセージの `messageId` のみ。通知の一括追記でも 1 メッセージにつき 1 回。
- `history.rewritten`: コアが履歴を書き換えた。永続化モジュールはこれを契機に保存内容を置き換える。

### 4.6 プロンプト / compaction

- `prompt.assembled`: 結合済みプロンプトの断片 ID、キャッシュ境界、static ハッシュ。本文は載せない。
- `compaction.requested` / `compaction.completed`: compaction の要求と完了。

### 4.7 エージェント / モジュール / 権限 / コア

- `agent.spawned` / `agent.message` / `agent.cancelled`: サブエージェントの操作。`agent.spawned` は tools、`agent.message` は jobId を持つ。
- `module.loaded` / `module.failed` / `module.disabled`: モジュールのライフサイクル。
- `permission.requested` / `granted` / `denied` / `violation`: 承認と強制の記録。
- `core.started` / `core.stopping`: コアの起動と停止。

## 5. 標準的な並び (非同期ジョブ)

```text
user.message
turn.started
prompt.assembled
model.requested
(model.delta)*
model.completed
tool.requested          # read (sync)
tool.started
tool.completed
tool.requested          # shell (async)
tool.started
job.running
tool.completed          # jobId を返した時点
message.appended (assistant: text + tool_call)
# モデルは { jobId } を受け取り、次のループで wait を呼ぶ
model.requested
tool.requested          # wait (sync)
tool.started
job.done                # 待機中にジョブが完了
tool.completed          # wait 自身
message.appended (notification: 完了順の配列)
job.notified            # 通知したジョブごと
model.requested
...
turn.ended
```

- 通知は次のモデル呼び出しの直前にまとめて 1 メッセージで追記する。
- `wait` の戻り値で受け取ったジョブは通知しない (二重配信の防止)。
- 通知の宛先セッションがアイドルの場合、そのセッションの `autoWake` が `true` なら新しいターンを開始し、`false` なら次のユーザー入力を待つ。最上位の既定は `false`、サブエージェントの既定は `true`。

## 6. バージョニング

- 全ペイロードの `v` は `CORE_EVENT_VERSION` (現在 `1`)。
- フィールド追加は `v: 1` のまま。消費者は未知フィールドを無視する。
- フィールド削除・意味変更・型変更は `v` を上げる。購読側は `v` で分岐する。
- イベント型の追加も `v: 1` でよい (購読側は未知型を無視する)。

## 7. 保存と再生

- イベントは履歴そのものではない。実行中の履歴の正はコアのメモリにある。
- `history-store` は `message.appended` を購読して永続化する。`messageId` から本文を引くために `history.read` 権限を使う。
- `compactor` の書き換えはコアの `ctx.history.rewrite` を通り、`history.rewritten` を契機に `history-store` が保存内容を置き換える。
- イベントログの永続化は任意モジュールの機能とする (コアはイベントを発行するだけ)。
