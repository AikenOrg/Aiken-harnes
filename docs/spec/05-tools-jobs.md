# 05. ツールと非同期ジョブ

## 1. ツール登録

```ts
type ToolDefinition = {
  name: string;
  description: string;
  input: z.ZodType;              // コード側で定義する
  mode: "sync" | "async";
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
};
```

- モジュールは `ctx.tools.register(def)` で登録する。`tool.register` 権限が必要。
- manifest の `tools` と登録内容が一致しない場合は登録を拒否する (名前・mode)。
- モデルへ渡す `ToolSpec` は zod から JSON Schema へ変換して生成する。
- ツール名は全体で一意。重複は登録拒否。
- `description` はモデル向けの説明であり、権限や副作用を明記する。

### 1.1 同期 / 非同期

| mode | 用途 | モデルへの返し方 |
|---|---|---|
| `sync` | read など軽い処理 | 結果をその場で `tool_result` に |
| `async` | shell、ネットワーク、長時間処理 | `{ jobId }` を即返し、完了は通知 |

- 既定は `async`。`sync` を選べるのは軽い読み取り系のみとし、実装時に上限 (例: 5 秒) を設ける。
- モードは manifest (またはロード時の宣言) で固定する。実行時に切り替えない。

## 2. 同期ツールの実行

```text
model が tool_call を返す
  -> bus.emit tool.requested
  -> hook: tool.before (承認 / 拒否 / 引数書き換え)
  -> bus.emit tool.started
  -> handler 実行
  -> 成功: tool_result を履歴へ / bus.emit tool.completed
  -> 失敗: エラー内容をそのまま tool_result として履歴へ / bus.emit tool.failed
```

- 同期ツールのエラーは握りつぶさない。モデルが読める形で返し、ターンを継続する。
- タイムアウトはツール実装の責務。コアは `tool.before` で拒否できる。

## 3. 非同期ジョブ

### 3.1 開始

```text
model が async ツールを呼ぶ
  -> tool.requested
  -> tool.before
  -> jobId = core.jobs.create({ sessionId, toolCallId, name, ownerSessionId })
  -> tool.started
  -> job.running
  -> モジュールへ実行を依頼 (AbortSignal を渡す)
  -> モデルには { jobId } を tool_result として返す
  ...
  -> 終端: job.done     + tool.completed
           job.failed   + tool.failed
           job.cancelled + tool.cancelled
```

- `tool.completed` は同期ツールでは実行直後、非同期ツールではジョブの終端で発行する。`tool.started` は実行受付時点。

- ジョブ ID はコアが発行する。モジュールは ID を生成しない。
- `ownerSessionId` は「そのジョブを起動したセッション」。キャンセル範囲の判定に使う。
- 1 つの `tool_call` に対して 1 つのジョブ。複数ジョブを起動するツールは、ツール内部でサブジョブを作らず、コアのジョブとして登録する。

### 3.2 状態

```ts
type JobStatus = "running" | "done" | "failed" | "cancelled";

type Job = {
  id: string;                 // コア発行
  sessionId: string;          // 通知先
  ownerSessionId: string;     // 起動したセッション (キャンセル範囲)
  toolCallId: string;
  name: string;
  status: JobStatus;
  createdAt: number;
  endedAt?: number;
  summary?: string;           // 短い要約 (通知に載る)
  size?: number;              // 結果本体のバイト数
  resultRef?: string;         // SQLite 側の参照
  cancelBy?: "ai" | "user" | "timeout" | "system";
};
```

- 遷移は `running -> done | failed | cancelled` の一方向のみ。終端状態から戻らない。
- 終端後の完了報告 (モジュールが遅れて返した結果) は**破棄**する。`job.done` にしない。

### 3.3 結果の保存

- 結果本体は SQLite モジュールに保存する。コアは `resultRef` だけを持つ。
- 通知に載せるのは固定 JSON **のみ**:

```json
{ "id": "job_...", "status": "done", "summary": "...", "size": 1234 }
```

- 本体は `read_result(id)` で取得する。
- SQLite が無い構成では非同期ツールを許可しない (起動時に検査)。**TBD**: メモリフォールバックを許すか。

## 4. 通知

- 通知は次のモデル呼び出しの**直前**に、履歴の末尾へ追記する。
- 追記は 1 回の append にまとめ、`message.appended` を発行したうえで `job.notified` をジョブごとに発行する。
- 通知ブロックの型:

```ts
type NotificationBlock = {
  type: "notification";
  jobId: string;
  status: Exclude<JobStatus, "running">;
  summary: string;
  size: number;
};
```

- 通知はモデルへの入力であり、ユーザー発話ではない。role は `user` ではなく `system` 相当の別ブロックとして扱い、履歴上は「notification」メッセージにする (プロバイダー実装が role へ写像する)。
- 未通知のジョブが無いターンでは何も追記しない。
- 通知後も `read_result` で本体を取得できる。

## 5. コア提供ツール

ジョブ ID をコアが持つため、次の 3 つはコアが常に登録する。無効化できない。

### `wait(ids, timeout)`

```ts
{ ids: string[], timeoutMs: number }
```

- 複数 ID 可。`timeoutMs` は必須。
- すべて終端に達したか、タイムアウトで戻る。
- 戻り値は各ジョブの `{ id, status, summary, size }`。結果本体は含めない。
- `wait` のタイムアウトはジョブをキャンセルしない。ジョブ側のタイムアウトと混同しない。
- 待機中も他セッションのイベント配信は止めない。

### `cancel(id)`

- AI による都合のキャンセル。対象は**自分のセッションとその子孫が起動したジョブのみ**。
- 範囲外は `permission.denied` を返す。
- ユーザーによるキャンセルは `user.cancel` イベント経由で、範囲制限なく行える。

### `read_result(id)`

- 結果本体を返す。取得可能なのは自分のセッションと子孫のジョブのみ。
- 大きすぎる結果は切り詰め、`size` と切り詰めた旨を返す。**TBD**: offset/limit 引数の追加。

## 6. キャンセル

### 6.1 主体

| by | 起点 |
|---|---|
| `ai` | `cancel(id)` ツール |
| `user` | `user.cancel` / UI 操作 |
| `timeout` | ジョブまたは `wait` の設定タイムアウト |
| `system` | シャットダウン、critical 障害、セッション強制終了 |

### 6.2 流れ

1. コアが状態を `cancelled` に遷移させる (遷移は 1 回だけ)。
2. `job.cancelled` を `by` 付きで発行する。
3. モジュールへ `AbortSignal` を abort する。
4. モジュールが中断できなくても、以後の結果は破棄する。
5. 履歴へキャンセル通知を追記する (次ターン直前)。

- `tool.cancelled` も同じ `by` で発行する。
- キャンセル済みジョブへの `wait` は即座に `cancelled` を返す。

### 6.3 サブエージェント

- `ctx.agent.cancel(sessionId)` は自分の子孫のみ対象。
- 対象セッションの実行中ターンを abort し、そのセッションが起動したジョブを `by: "ai"` (または呼び出し元に応じた主体) でキャンセルする。
- `agent.cancelled` を発行する。

## 7. 権限とフック

- `tool.before` は同期・非同期の両方に適用する。
- フックは `allow` / `deny` / `args` の書き換えを返せる。
- 拒否時は `tool.failed` ではなく `tool.requested` の後に `permission.denied` を発行し、モデルには拒否理由を `tool_result` として返す。
- shell のホワイトリスト判定と個別承認はこのフックで行う。
