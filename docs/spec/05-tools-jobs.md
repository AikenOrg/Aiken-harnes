# 05. ツールと非同期ジョブ

## 1. ツール登録

```ts
type ToolDefinition = {
  name: string;
  description: string;
  input: z.ZodType;              // コード側で定義する
  mode: "sync" | "async";
  timeoutMs?: number;            // async のみ
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult | void> | ToolResult | void;
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
- async ツールの `handler` の戻り値は無視する。完了は `ctx.jobs.done` / `ctx.jobs.fail` で知らせる。

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
  -> jobId = core.jobs.create({ sessionId, ownerSessionId, callId, tool, timeoutMs })
  -> tool.started
  -> job.running
  -> handler を開始 (AbortSignal と jobId を渡す)
  -> モデルには { jobId } を tool_result として返す
  ...
  -> 終端: job.done + tool.completed
           job.failed + tool.failed
           job.cancelled + tool.cancelled
```

- ジョブ ID はコアが発行する。モジュールは ID を生成しない。
- `ownerSessionId` はジョブを起動したセッション。キャンセル範囲の判定に使う。
- 1 つの `tool_call` に対して 1 つのジョブ。

### 3.2 状態

```ts
type JobStatus = "running" | "done" | "failed" | "cancelled";

type Job = {
  id: string;
  sessionId: string;
  ownerSessionId: string;
  callId: string;
  tool: string;
  status: JobStatus;
  timeoutMs?: number;
  createdAt: number;
  endedAt?: number;
  summary?: string;
  size?: number;
  resultRef?: string;
  cancelBy?: "ai" | "user" | "timeout" | "system";
};
```

- 遷移は `running -> done | failed | cancelled` の一方向のみ。終端状態から戻らない。
- 終端後の完了報告・キャンセルは無視する。エラーにしない (現在の状態を返す)。

### 3.3 完了の契約

モジュールはジョブごとに、次のどちらかを**ちょうど 1 回**呼ぶ。

```ts
ctx.jobs.done(jobId, { summary: string, result: string | Uint8Array });
ctx.jobs.fail(jobId, { code: string, message: string });
```

- `summary` は必須。上限 (既定 200 文字) を超えたらコアが切り詰める。
- 2 回目以降の呼び出しは無視し、診断ログに残す。
- ハンドラが例外を投げた場合、コアは `fail({ code: "internal", message })` として扱う。
- ハンドラが何も呼ばずに終了した場合、ジョブは `running` のまま。タイムアウトで `cancelled (by: "timeout")` になる。
- コアは完了を受けると、結果を result-store に保存し、状態を更新し、イベントを発行し、通知をキューに積む。

### 3.4 タイムアウト

タイムアウトは 2 種類を明確に分ける。

| 種類 | 動作 |
|---|---|
| ジョブのタイムアウト | コアがジョブをキャンセルする。状態は `cancelled`、`by: "timeout"` |
| `wait` のタイムアウト | 待機をやめるだけ。ジョブは止めず、現在の状態を返す |

- ジョブのタイムアウトはツールごとの `timeoutMs`。未指定なら `jobs.defaultTimeoutMs`。
- `jobs.maxTimeoutMs` を上限とし、超える値は切り詰める。
- タイムアウト時、コアは `AbortSignal` を abort し、`job.cancelled` と `tool.cancelled` を発行する。以後の結果は破棄する。

### 3.5 同時実行数の上限

- `jobs.maxConcurrentPerSession` を超える新規ジョブは、実行せずに失敗させる。
- モデルには `{ code: "job_limit_exceeded", message }` を `tool_result` として返す。**TBD**: キューに積む方式にするか。

## 4. 結果の保存

- 結果本体は result-store に保存する。コアは `resultRef` だけを持つ。
- result-store が無い構成では、コアがメモリ上に結果を持つ。再起動で消える。
- result-store を必須にするかは、そのモジュールの `critical` で選ぶ。
- 通知に載せるのは固定 JSON のみ:

```json
{ "id": "job_...", "status": "done", "summary": "...", "size": 1234 }
```

- 本体は `read_result(id)` で取得する。

## 5. 通知

- 次のモデル呼び出しの**直前**に、キューにある通知を**完了順の配列**として 1 つのメッセージにまとめ、履歴の末尾へ追記する。
- 1 つの通知はちょうど 1 回だけ届く。`job.notified` は通知したジョブごとに発行する。
- 通知ブロック:

```ts
type NotificationBlock = {
  type: "notification";
  entries: JobNotification[];   // { id, status, summary, size }[]
};
```

- `wait` の戻り値で受け取った終端ジョブは「配信済み」とし、通知キューから除く。二重配信しない。
- `wait` がタイムアウトした場合、まだ終端でないジョブは後で通常どおり通知される。
- 通知はモデルへの入力であり、ユーザー発話ではない。role は `notification` とし、プロバイダーが自身の形式へ写像する。
- 未通知のジョブが無いターンでは何も追記しない。
- 通知後も `read_result` で本体を取得できる。

### 5.1 autoWake

宛先セッションがアイドルの間にジョブが完了した場合の挙動を設定で選ぶ。

| `jobs.autoWake` | 挙動 |
|---|---|
| `true` | 通知を追記して新しいターンを自動で開始する |
| `false` (既定) | 通知をキューに保持し、次の `user.message` の直前まで待つ |

## 6. コア提供ツール

ジョブ ID をコアが持つため、次の 3 つはコアが常に登録する。無効化できない。

### `wait(ids, timeoutMs)`

- 複数 ID 可。`timeoutMs` は必須。
- すべて終端に達したか、タイムアウトで戻る。
- 戻り値は各ジョブの `{ id, status, summary, size }`。結果本体は含めない。
- 終端ジョブは配信済みとして記録し、通知キューから除く。
- 待機中も他セッションのイベント配信は止めない。

### `cancel(id)`

- AI による都合のキャンセル。対象は**自分のセッションとその子孫が起動したジョブのみ**。
- 範囲外は `permission.denied` を返す。
- 終端済みのジョブに cancel してもエラーにせず、現在の状態を返す。
- ユーザーによるキャンセルは `user.cancel` 経由で、範囲制限なく行える。

### `read_result(id)`

- 結果本体を返す。取得可能なのは自分のセッションと子孫のジョブのみ。
- 大きすぎる結果は切り詰め、`size` と切り詰めた旨を返す。**TBD**: offset/limit 引数。

## 7. キャンセル

### 7.1 主体

| by | 起点 |
|---|---|
| `ai` | `cancel(id)` ツール / `agent.cancel` |
| `user` | `user.cancel` / UI 操作 |
| `timeout` | ジョブのタイムアウト |
| `system` | シャットダウン、セッション終了、critical 障害、モジュール死亡 |

### 7.2 流れ

1. コアが状態を `cancelled` に遷移させる (遷移は 1 回だけ)。
2. `job.cancelled` を `by` 付きで発行する。
3. モジュールへ `AbortSignal` を abort する。
4. モジュールが中断できなくても、以後の結果は破棄する。
5. 履歴へキャンセル通知を追記する (次ターン直前、または autoWake)。

- `tool.cancelled` も同じ `by` で発行する。
- キャンセル済みジョブへの `wait` は即座に `cancelled` を返す。

### 7.3 異常時

| 状況 | 挙動 |
|---|---|
| モジュールが落ちた | そのモジュールの実行中ジョブをすべて `failed (code: "module_died")` にする |
| セッションが閉じた | そのセッションの実行中ジョブを `cancelled (by: "system")` にする |
| コアが停止する | 全ジョブを `cancelled (by: "system")` にする |

### 7.4 サブエージェント

- `ctx.agent.cancel(sessionId)` は自分の子孫のみ対象。
- 対象セッションの実行中ターンを abort し、そのセッションが起動したジョブをキャンセルする。
- `by` は呼び出し元に応じて `ai` または `user`。`agent.cancelled` を発行する。

## 8. 権限とフック

- `tool.before` は同期・非同期の両方に適用する。
- フックは `allow` / `deny` / `args` の書き換えを返せる。
- 拒否時は `permission.denied` を発行し、モデルには拒否理由を `tool_result` として返す。
- shell のホワイトリスト判定と個別承認はこのフックで行う。
