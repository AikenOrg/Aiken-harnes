# 09. ctx API

## 1. 基本

モジュールの `init(ctx)` に渡される唯一の窓口。モジュールは `ctx` 以外からコアへ触れない。

```ts
type ModuleContext = {
  name: string;
  bus: BusApi;
  tools: ToolApi;
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

```ts
type HistoryApi = {
  read(sessionId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;
  append(sessionId: string, message: NewMessage): Promise<Message>;
  appendBatch(sessionId: string, messages: NewMessage[]): Promise<Message[]>;
  rewrite(sessionId: string, messages: Message[], reason: string): Promise<void>;
  count(sessionId: string): Promise<number>;
};
```

| メソッド | 必要権限 | 備考 |
|---|---|---|
| `read` | `history.read` | 子孫セッションも可 |
| `append` | `history.append` | 追記のみ。既存メッセージは変更しない |
| `appendBatch` | `history.append` | 通知の一括追記に使う。原子的に扱う |
| `rewrite` | `history.rewrite` | `compactor` のみ。`history.rewritten` を発行 |
| `count` | `history.read` | |

- `read` の `limit` は末尾から。`before` はカーソル。
- 履歴の実体は history-store モジュールが持つ。コアは委譲するだけ。

### 2.4 `ctx.prompt`

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

### 2.5 `ctx.session`

```ts
type SessionApi = {
  get(sessionId: string): Session;
  create(opts: { model: string; parentId?: string }): Promise<Session>;
  fork(sessionId: string, opts?: { model?: string }): Promise<Session>;
  close(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: string): void;
};
```

- `session.manage` 権限が必要。
- `get` は自分のセッションと子孫のみ。
- `create` で `parentId` を指定できるのは、自身がその親を操作できる場合のみ。
- `setModel` は次のターンから反映する。

### 2.6 `ctx.agent`

```ts
type AgentApi = {
  spawn(opts: {
    parentSessionId: string;
    prompt?: string;              // session 断片として追加
    volatile?: string;            // volatile 断片として追加
    model?: string;
    task: string;                 // 最初の user メッセージ
  }): Promise<{ sessionId: string }>;
  message(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string, opts?: { reason?: string }): Promise<void>;
};
```

- `spawn` は `agent.spawn` **かつ** `prompt.contribute` が必要。
- `prompt` / `volatile` で static 断片は変更できない。
- `message` は `agent.message` が必要。宛先は自分の子孫のみ。
- `cancel` は自分の子孫のみ。実行中ターンとジョブをキャンセルする。

### 2.7 `ctx.hooks`

```ts
type HookApi = {
  register(hook: HookRegistration): () => void;
};
```

- フック種別ごとの必要権限は [07-hooks.md](07-hooks.md) を参照。
- ロード完了後の登録は、そのターンには反映しない。

### 2.8 `ctx.fs` / `ctx.net` / `ctx.env` / `ctx.secrets`

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

### 2.9 `ctx.modules`

```ts
type ModulesApi = {
  call<T = unknown>(name: string, method: string, args?: unknown): Promise<T>;
};
```

- `talksTo` に列挙した相手のみ。`module.talk:<name>` 権限が必要。
- 呼び出し先のメソッドはモジュールが公開したものだけ。
- 権限は委譲されない。呼び出し先の `ctx` で再検査する。
- 呼び出し深さに上限を設け、循環を検出する。

### 2.10 `ctx.log`

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
- 出力先はコアの設定 (`log.level`, `log.file`) に従う。**TBD**: log-store モジュールとの関係。

## 3. 強制の範囲

| 系統 | 強制 | 備考 |
|---|---|---|
| コア API (history / prompt / session / agent / tool / module.talk) | 実効あり | `ctx` で検査 |
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
