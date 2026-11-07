# 06. イベント

## 1. エンベロープ

```ts
type CoreEvent<T extends string = string, P = unknown> = {
  id: string;          // 一意 (例: evt_<seq>)
  seq: number;         // コア内で単調増加
  ts: number;          // epoch ms
  type: T;             // 例: "tool.completed"
  source: string;      // "core" またはモジュール名
  sessionId?: string;  // セッションに紐づく場合のみ
  payload: P;
};
```

- `seq` はコアが採番する。モジュールは採番しない。
- `id` は `seq` から導出してよいが、外部に保存しても衝突しない形式にする。
- `sessionId` は省略可能。モジュール全体のイベント (`module.loaded` など) には付けない。
- ペイロードに秘密情報・API キー・プロンプト本文を含めない。

## 2. 配信

- 購読は型名またはワイルドカード (`tool.*`) で行う。manifest の `subscribes` と一致しない購読は拒否する。
- 配信順は発行順。`seq` の昇順で届く。
- 購読者の例外は隔離する。他の購読者への配信は続行し、`ctx.log` に記録する。
- 購読ハンドラは同期実行を基本とし、重い処理は自分でキューへ逃がす。コアのターンをブロックしない。
- `model.delta` は既定で購読されない。UI がストリーミング表示を望む場合だけ明示購読する。

## 3. イベント一覧

### 3.1 ユーザー入力

| type | payload |
|---|---|
| `user.message` | `{ text: string }` |
| `user.cancel` | `{ reason?: string }` |

### 3.2 セッション

| type | payload |
|---|---|
| `session.created` | `{ parentId?: string, model: string }` |
| `session.closed` | `{ reason?: string }` |
| `session.forked` | `{ fromSessionId: string }` |

### 3.3 ターン

| type | payload |
|---|---|
| `turn.started` | `{ turnId: string }` |
| `turn.ended` | `{ turnId: string, reason: "completed" | "cancelled" | "error" }` |

### 3.4 モデル

| type | payload | 備考 |
|---|---|---|
| `model.requested` | `{ model, messageCount, toolCount, promptHash }` | 送信直前 |
| `model.delta` | `{ text: string }` | 既定は購読しない |
| `model.completed` | `{ stopReason, usage?: { input, output, cacheRead? }, durationMs }` | |
| `model.failed` | `{ error: string, retryable?: boolean }` | |

### 3.5 ツール

| type | payload |
|---|---|
| `tool.requested` | `{ toolCallId, name, args, mode }` |
| `tool.started` | `{ toolCallId, name, jobId?: string }` |
| `tool.completed` | `{ toolCallId, name, jobId?: string, size?: number, durationMs }` |
| `tool.failed` | `{ toolCallId, name, error: string }` |
| `tool.cancelled` | `{ toolCallId, name, by: CancelBy }` |

### 3.6 ジョブ

| type | payload |
|---|---|
| `job.running` | `{ jobId, name, toolCallId }` |
| `job.done` | `{ jobId, summary, size }` |
| `job.failed` | `{ jobId, error: string }` |
| `job.cancelled` | `{ jobId, by: CancelBy, reason?: string }` |
| `job.notified` | `{ jobId }` |

`CancelBy = "ai" | "user" | "timeout" | "system"`

### 3.7 履歴

| type | payload |
|---|---|
| `message.appended` | `{ messageId, role, blockTypes: string[], atTail: boolean }` |
| `history.rewritten` | `{ reason, beforeCount, afterCount }` |

### 3.8 プロンプト

| type | payload |
|---|---|
| `prompt.assembled` | `{ segmentIds: string[], stabilities: string[], cacheBoundary, hash }` |

本文は載せない。デバッグ用の全文は明示的な設定でのみ別途保存する。

### 3.9 compaction

| type | payload |
|---|---|
| `compaction.requested` | `{ reason, tokenEstimate? }` |
| `compaction.completed` | `{ beforeCount, afterCount }` |

### 3.10 エージェント

| type | payload |
|---|---|
| `agent.spawned` | `{ childSessionId, parentSessionId, model }` |
| `agent.message` | `{ from: string, to: string, text: string }` |
| `agent.cancelled` | `{ sessionId, by: CancelBy }` |

### 3.11 モジュール

| type | payload |
|---|---|
| `module.loaded` | `{ name, version, roles, critical }` |
| `module.failed` | `{ name, error: string }` |
| `module.disabled` | `{ name, reason: string }` |

### 3.12 権限

| type | payload |
|---|---|
| `permission.requested` | `{ module, permissions, warnings: string[] }` |
| `permission.granted` | `{ module, permissions }` |
| `permission.denied` | `{ module, cap, reason }` |
| `permission.violation` | `{ module, cap, reason }` |

### 3.13 コア

| type | payload |
|---|---|
| `core.started` | `{ version, modules: string[] }` |
| `core.stopping` | `{ reason }` |

## 4. ターン内の標準的な並び

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
message.appended (assistant: text + tool_call)
# モデルは { jobId } を受け取り、次のループで wait を呼ぶ
model.requested
tool.requested          # wait (sync)
tool.started
job.done                # 待機中にジョブが完了
tool.completed          # async ツールの終端
tool.completed          # wait 自身
message.appended (notification / atTail)
job.notified
model.requested
...
turn.ended
```

同期ツールの `tool.completed` は実行直後、非同期ツールの `tool.completed` はジョブの終端で発行する。

## 5. 保存と再生

- イベントは履歴そのものではない。履歴モジュールが `message.appended` を購読して保存する構成と、コアが `ctx.history` 経由で直接書く構成のどちらもあり得る。
- 必須構成では、コアが `ctx.history` を呼び、history-store が保存し、`message.appended` を発行する (二重保存を避ける)。
- イベントログの永続化は `log-store` モジュールの任意機能とする。
