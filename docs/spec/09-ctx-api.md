# 09. ctx API

## 1. 基本

モジュールの `init(ctx)` に渡される唯一の窓口。モジュールは `ctx` 以外からコアへ触れない。

```ts
type ModuleContext = {
  name: string;
  bus: BusApi;
  tools: ToolApi;
  providers: ProviderApi;
  jobs: JobsApi;
  history: HistoryApi;
  prompt: PromptApi;
  session: SessionApi;
  agent: AgentApi;
  hooks: HookApi;
  fs: FsApi;
  net: NetApi;
  env: EnvApi;
  secrets: SecretsApi;
  modules: ModulesApi;
  log: LogApi;
};
```

- すべての API は呼び出し時に権限を検査する。足りなければ `permission.denied` を発行して例外を返す。
- 権限はモジュールに付与されたものだけ。セッションをまたぐ操作は、そのセッションが自分の子孫かどうかも検査する。
- API は非同期を基本とする (`Promise`)。同期で完結するものだけ同期。
- 履歴の権限検査はコアに一本化する。history-store は保存先であり、権限の番人ではない。

## 2. 各 API

### 2.1 `ctx.bus`

```ts
type BusApi = {
  on(type: string, handler: (event: CoreEvent) => void): () => void;
  once(type: string, handler: (event: CoreEvent) => void): () => void;
  emit(type: string, payload: unknown, sessionId?: string): void;
};
```

- `on` / `once` は manifest の `subscribes` に一致する型のみ許可する。
- `emit` はモジュール独自イベント用。**コアの予約イベント (`core.*`, `model.*`, `tool.*`, `job.*` など) は発行できない。** 予約イベントはコアだけが発行する。
- 独自イベントは `module.<name>.<event>` の形式に限る。
- 戻り値の関数で購読解除する。

### 2.2 `ctx.tools`

```ts
type ToolApi = {
  register(def: ToolDefinition): void;
  unregister(name: string): void;   // 停止時のみ
};
```

- `tool.register` 権限が必要。
- manifest の `tools` と一致しない登録は拒否する。

### 2.3 `ctx.history`

実行中の履歴の唯一の正はコアのメモリ。`ctx.history` はそこへの窓口であり、永続化モジュールへの委譲ではない。

```ts
type HistoryApi = {
  read(sessionId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;
  get(sessionId: string, messageId: string): Promise<Message | undefined>;
  append(sessionId: string, message: NewMessage): Promise<Message>;
  appendBatch(sessionId: string, messages: NewMessage[]): Promise<Message[]>;
  restore(sessionId: string, messages: Message[]): Promise<void>;
  rewrite(sessionId: string, messages: Message[], reason: string): Promise<void>;
  count(sessionId: string): Promise<number>;
};
```

| メソッド | 必要権限 | 備考 |
|---|---|---|
| `read` | `history.read` | 子孫セッションも可 |
| `get` | `history.read` | `message.appended` の ID から本文を引く |
| `append` | `history.append` | 追記のみ。既存メッセージは変更しない |
| `appendBatch` | `history.append` | 通知の一括追記。原子的に扱う |
| `restore` | `history.restore` + `history-store` ロール | `restoring` かつ履歴が空のセッションだけ。コアへ履歴を戻す |
| `rewrite` | `history.rewrite` + `compactor` ロール | コアがメモリを書き換え、`history.rewritten` を発行 |
| `count` | `history.read` | |

- `read` の `limit` は末尾から。`before` はカーソル。
- `append` はコアのメモリへ追記し、`message.appended` を発行する。history-store はそれを購読して保存する。
- `restore` は復元専用。セッション状態が `restoring` で履歴が空のときだけ許可する。稼働中の履歴は上書きできない (D37)。
- `restore` の成功後、コアはセッションを `idle` に戻す。失敗したら `error` にする。
- `rewrite` はコアのメモリを置換し、`history.rewritten` を発行する。永続化モジュールはこれを契機に保存内容を置き換える。

### 2.4 `ctx.providers`

```ts
type ProviderApi = {
  register(provider: Provider): void;
};
```

- `provider` ロールを持つモジュールだけが呼べる。
- `models()` はロード時に検証する。`contextWindow` は必須。
- 同じモデル ID の接頭辞を複数モジュールが担当したら起動失敗。

### 2.5 `ctx.jobs`

非同期ツールの完了をコアへ知らせる。ジョブごとに**ちょうど 1 回**呼ぶ。

```ts
type JobsApi = {
  done(jobId: string, input: { summary: string; result: string | Uint8Array }): void;
  fail(jobId: string, input: { code: string; message: string }): void;
  /** ui ロールのみ。 */
  list(sessionId: string, status?: JobStatus): Promise<Job[]>;
  read(jobId: string, opts?: { offset?: number; limit?: number }): Promise<JobResult>;
  cancel(jobId: string, opts?: { reason?: string }): Promise<void>;
};
```

- `summary` は必須。上限を超えたらコアが切り詰める。
- 2 回目以降の呼び出しは無視し、診断ログに残す。
- 存在しないジョブ ID は無視する (診断ログのみ)。
- コアは結果を result-store に保存し、状態を更新し、イベントを発行し、通知をキューに積む。
- 同時ジョブ上限を超えた新規ジョブは、`too_many_jobs` と実行中ジョブ ID を `tool_result` として返す。
- ジョブ ID は `ToolContext.jobId` でハンドラに渡される。ハンドラは `ctx.jobs` と `ctx` の両方にアクセスできる。
- `list` / `read` / `cancel` は `job.read` / `job.cancel` と `ui` ロールを必要とする。UI は全セッションのジョブを扱える。

### 2.6 `ctx.prompt`

```ts
type PromptApi = {
  contribute(segment: PromptSegmentInput): void;
  remove(id: string): void;   // 自分の断片のみ
  list(): PromptSegment[];    // 自分の断片のみ
};
```

- `prompt.contribute` 権限が必要。
- `PromptSegmentInput` は `id` / `stability` / `priority` / `content`。`source` はコアがモジュール名から埋める。
- static 断片の削除・上書きはできない (登録のみ)。

### 2.7 `ctx.session`

```ts
type SessionApi = {
  get(sessionId: string): Session;
  /** ui ロール向け。全セッション。 */
  list(): Promise<Session[]>;
  /** ui ロール向け。新規作成に使えるモデル。 */
  models(): ModelInfo[];
  create(opts: { model: string; parentId?: string; autoWake?: boolean }): Promise<Session>;
  fork(sessionId: string, opts?: { model?: string }): Promise<Session>;
  listRestorable(): Promise<Session[]>;
  restore(sessionId: string): Promise<Session>;
  /** 子孫セッションも再帰的に閉じる。 */
  close(sessionId: string): Promise<void>;
  /** closed のセッションだけを削除する。子孫が開いている間は拒否。 */
  delete(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: string): void;
  /** ui ロール向け。ユーザー入力をキューへ積む。 */
  send(sessionId: string, text: string): Promise<void>;
  /** ui ロール向け。現在のターンをユーザー操作としてキャンセルする。 */
  cancel(sessionId: string, opts?: { reason?: string }): Promise<void>;
};
```

- `session.manage` 権限が必要。
- `get` は自分のセッションと子孫のみ。
- `create` で `parentId` を指定できるのは、自身がその親を操作できる場合のみ。
- `close` は実行中ターンとジョブを `by: "system"` で停止し、セッションと子孫を再帰的に `closed` にする。ui ロールはユーザー操作として任意のセッションを close できる。
- `delete` は `session.delete` 権限を必要とする。`closed` のセッションだけを削除する。ui ロールは任意の `closed` を削除できる。それ以外は自分と子孫がすべて `closed` のときだけ許可する。履歴・セッション・ジョブ結果も削除する (実装は各 store に委譲)。`session.deleted` を発行する。
- `listRestorable` / `restore` は `session.manage` が必要。`restore` は session-store に `restoring` で作らせ、続いて history-store の role API `restoreSession` を呼ぶ。
- `restore` はターンループを再開しない。復元前に動いていたジョブは `failed (code: "interrupted")`、未通知の完了通知は再キューに積む。
- `create` の `autoWake` はセッション単位の上書き。省略時、最上位は config、サブエージェントは `true`。
- `setModel` は次のターンから反映する。
- `list` / `models` は `session.manage`、`send` / `cancel` は `session.input` と `ui` ロールを必要とする。
- `send` はターンの完了を待たずにキューへ積む。`cancel` は `user.cancel` を発行する。

### 2.8 `ctx.agent`

```ts
type AgentApi = {
  spawn(opts: {
    parentSessionId: string;
    task: string;
    prompt?: string;              // session 断片
    volatile?: string;            // volatile 断片
    model?: string;
    tools?: string[];
    autoWake?: boolean;
  }): Promise<{ sessionId: string; jobId: string }>;
  send(fromSessionId: string, toSessionId: string, text: string): Promise<{ jobId: string }>;
  message(fromSessionId: string, toSessionId: string, text: string): Promise<{ jobId: string }>;
  cancel(fromSessionId: string, toSessionId: string, opts?: { reason?: string }): Promise<void>;
  close(fromSessionId: string, toSessionId: string, opts?: { reason?: string }): Promise<void>;
  list(fromSessionId: string): Promise<Session[]>;
};
```

- `spawn` は `agent.spawn` **かつ** `prompt.contribute` が必要。
- `send` / `message` は `agent.message` が必要。
- `cancel` / `close` / `list` は `agent.spawn` が必要。対象は自分の子孫のみ。
- `spawn` の `prompt` / `volatile` は session / volatile 断片。static は変更できない。
- `tools` は親の有効ツールの部分集合。省略時は agent ツールを除いた親のツール。
- `send` は子が idle なら新ターン、実行中なら現在のターンの後にキューされる。
- `cancel` は対象と子孫の現在ターンを中断し、実行中ジョブをキャンセルする。セッションは idle に戻る。
- `close` は対象と子孫を再帰的に closed にし、ジョブを `by: "system"` でキャンセルする。
- `list` は自分の子孫を返す。

### 2.9 `ctx.hooks`

```ts
type HookApi = {
  register(type: "prompt.assemble" | "tool.before" | "compaction.decide" | "agent.route", handler): () => void;
};
```

- フック種別ごとの必要権限は [07-hooks.md](07-hooks.md) を参照。
- ロード完了後の登録は、そのターンには反映しない。

### 2.10 `ctx.fs` / `ctx.net` / `ctx.env` / `ctx.secrets`

```ts
type FsApi = {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
};

type NetApi = {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

type EnvApi = {
  get(name: string): string | undefined;
};

type SecretsApi = {
  get(name: string): string;   // provider の stream 中のみ
};
```

- いずれも manifest の宣言範囲内でのみ呼べる。範囲外は拒否する。
- ただし実効的な強制 (サンドボックス) は未実装。**宣言と承認の記録だけ**であり、防御にはならない。
- `ctx.fs` のパスはモジュールに渡された作業ディレクトリ基準で解決し、`..` による脱出を拒否する (ベストエフォート)。
- `ctx.net.fetch` は `hosts` の前方一致/完全一致で検査する。リダイレクト先も検査する (ベストエフォート)。
- `ctx.secrets.get` はプロバイダーの `stream()` 実行中のみ有効。取得は監査ログに残す (値は残さない)。

### 2.11 `ctx.modules`

```ts
type ModulesApi = {
  call<T = unknown>(name: string, method: string, args?: unknown): Promise<T>;
};
```

- `talksTo` に列挙した相手のみ。`module.talk:<name>` 権限が必要。
- 呼び出し先のメソッドはモジュールが公開したものだけ。
- 権限は委譲されない。呼び出し先の `ctx` で再検査する。
- 呼び出し深さに上限を設け、循環を検出する。

### 2.12 `ctx.log`

```ts
type LogApi = {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
};
```

- コアの診断ログ。履歴のログ (会話ログ) とは別物。
- 秘密情報は渡さない。コア側でも既知の秘密値はマスクする。
- 出力先はコアの設定 (`log.level`, `log.file`) に従う。

## 3. 強制の範囲

| 系統 | 強制 | 備考 |
|---|---|---|
| コア API (history / prompt / session / agent / tool / jobs / module.talk) | 実効あり | `ctx` で検査 |
| fs / net / env / exec | 宣言と承認のみ | サンドボックスは未実装 |
| secrets | 宣言と承認 + 呼び出しタイミング制限 | 値の漏洩防止はベストエフォート |

## 4. モジュールのライフサイクル

```ts
type Module = {
  init(ctx: ModuleContext): Promise<void> | void;
  dispose?(): Promise<void> | void;
};
```

- `init` の完了をもって `module.loaded` を発行する。
- `init` 中の例外は `module.failed`。`critical` なら起動中止、それ以外は `module.disabled`。
- `dispose` はロードの逆順に呼ぶ。例外は記録して続行する。
- モジュールは自分のタイマー・接続・購読を `dispose` で必ず解放する。
