# 08. プロバイダー

## 1. インターフェイス

```ts
interface Provider {
  models(): ModelInfo[];
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

type ModelInfo = {
  id: string;              // "provider/model" 形式の一意 ID
  provider: string;        // モジュール名
  contextWindow: number;   // 必須。コンテキスト判定の分母
  maxOutput?: number;
  supportsTools?: boolean;
  supportsCache?: boolean;
  /** 画像入力の能力。 */
  supportsImages?: boolean;
  /** 受け付ける画像 MIME。未指定は png/jpeg/webp/gif。 */
  imageMediaTypes?: string[];
  /** reasoning / thinking の能力。UI と送信可否に使う。 */
  reasoning?: {
    supported: boolean;
    efforts?: Array<"off" | "low" | "medium" | "high" | "max">;
    toggle?: boolean;
    budget?: boolean;
  };
};

type ModelRequest = {
  model: string;
  system: PromptSegment[];
  messages: Message[];
  tools: ToolSpec[];
  /** プロバイダーがルーティング/キャッシュに使えるセッション ID。 */
  sessionId?: string;
  params?: {
    temperature?: number;
    maxTokens?: number;
    reasoning?: { effort?: "off" | "low" | "medium" | "high" | "max"; budgetTokens?: number };
  };
};

type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "reasoning_end"; opaque?: unknown }
  | { type: "reasoning_ignored"; reason: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "usage"; input: number; output: number; cacheRead?: number; reasoning?: number }
  | { type: "stop"; reason: "end" | "tool_use" | "length" | "error" };
```

- プロバイダーはモジュール (`roles: ["provider"]`) として実装し、`init` で `ctx.providers.register(provider)` を呼ぶ。複数ロードできる。
- モデル ID は `"<prefix>/<model>"` 形式。接頭辞ごとに担当プロバイダーは 1 つ。同じ接頭辞の重複は起動失敗。
- `ModelRequest.sessionId` はセッション ID をプロバイダーへ渡す。OpenCode Go は `x-opencode-session` に使う。
- provider は最低 1 つ必要。無ければ起動失敗。
- `models()` はロード時に呼ばれ、コアがモデル→プロバイダーの対応表を作る。
- `stream()` はコアだけが呼ぶ。モジュール同士が直接呼ぶことはない。
- コアはストリームの開始・中継・完了を管轄する。プロバイダーは `AsyncIterable` を返すだけで、履歴やイベントバスに触れない。

## 2. メッセージ

```ts
type Role = "system" | "user" | "assistant" | "tool" | "notification";

type Message = {
  id: string;
  role: Role;
  blocks: Block[];
  createdAt: number;
  /** キャンセルで途切れたアシスタントメッセージ。 */
  interrupted?: boolean;
  /** 出力トークン上限 (stop.reason = "length") で切り詰められた。 */
  truncated?: boolean;
};

type Block =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; name?: string }
  | { type: "reasoning"; text: string; opaque?: unknown }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; toolCallId: string; name: string; content: string; isError?: boolean }
  | { type: "notification"; entries: JobNotification[] };
```

- 1 メッセージは複数ブロックを持つ。テキストと tool_call が同時に返る場合がある。
- `tool_result` は対応する `tool_call` の直後に置く。プロバイダーはこの順序を前提に変換してよい。
- `notification` はジョブ完了通知の配列。1 メッセージに完了順でまとめて入る。プロバイダーは `role` と本文を自前の形式へ写像する。
- `system` は `ModelRequest.system` に分離して渡す。`messages` に system ロールを混ぜない。

## 3. ストリームの扱い

- `text` は到着順に `model.delta` (`kind: "text"`) として中継する (購読者のみ)。
- `reasoning` は `model.delta` (`kind: "reasoning"`) として中継し、履歴には本文と分けて保存する。`reasoning_end.opaque` は署名や redacted data を保持する。
- `reasoning_ignored` はモデルが指定を受け付けなかったことを示す。セッションの診断と UI に残す。
- `tool_call` はコアが蓄積し、`stop` 後にまとめて実行する。プロバイダーは 1 つの tool_call を分割して返してよいが、`id` は同一にする。
- `usage` は複数回来てよい。コアは加算する。
- `stop.reason` の解釈:

| reason | コアの挙動 |
|---|---|
| `end` | ターン終了 |
| `tool_use` | tool_call を実行してループ継続 |
| `length` | 不完全な tool_call は実行しない。継続メッセージを履歴へ追加し、最大 `context.maxOutputContinuations` 回まで自動継続する。上限到達時は `turn.ended (reason: "length")` とし、assistant に `truncated: true` を付ける |
| `error` | `model.failed`。`critical` なら停止 |

- ストリームが `stop` を返さずに終了した場合は `stop.reason = "error"` とみなす。
- プロバイダーがコンテキスト長超過を検出したら、`error.code = "context_overflow"` を返す。コアは通常の `context_overflow` と同じ扱いにする (復元直後の安全網)。
- `signal.aborted` になったら、プロバイダーは速やかに反復を終了する。コアは `turn.ended` の `reason: "cancelled"` を記録し、生成済みテキストを `interrupted: true` で履歴に残す。途中の `tool_call` は捨てる。

## 3.1 画像

- 画像はユーザーメッセージの `image` ブロックに base64 で入れる。data URL は保存しない。
- OpenAI 互換は `image_url` の `data:` URL、Anthropic は `{type:"image", source:{type:"base64", ...}}` に変換する。
- モデルの `supportsImages` / `imageMediaTypes` に一致しない画像はコアが拒否する。
- 画像本文はイベントに載せず、`user.message.imageCount` だけを発行する。

## 4. tool_call の検証

1. `name` が登録済みツールに存在するか。
2. `args` を zod で検証する。
3. 検証失敗時はツールを実行せず、エラーを `tool_result` (`isError: true`) としてモデルへ返す。
4. `id` の重複はエラー。直近のターン内で一意でなければならない。

## 5. API キーと秘密情報

- API キーはコアが保管する。モジュールの manifest は `secrets.read` を宣言し、承認を得る。
- プロバイダーは `ctx.secrets.get(name)` で取得する。**取得できるのは `stream()` 実行中のみ**とし、それ以外では例外にする。
- キーの値はイベント、ログ、履歴、エラーメッセージに含めない。エラー整形時にマスクする。
- 設定ファイルに直書きするより、環境変数または OS の秘密情報ストアを推奨する。**TBD**: 保管方式 (環境変数 / ファイル / keyring)。

## 6. リトライとタイムアウト

- reasoning 指定が原因と判定できる 400 だけ、指定を外して 1 回再試行する。
- 408 / 429 / 5xx と接続エラーは、ストリーム開始前に限り指数バックオフで再試行する。既定は 2 回、初回 1 秒。`Retry-After` を尊重する。設定は `maxRetries` / `retryBaseDelayMs`。
- ストリーム開始後の切断は重複出力を避けるため再試行しない。`model.failed` を発行し、UI が再試行を判断する。
- プロバイダー側の HTTP タイムアウトはモジュールの責務。コアは AbortSignal で中断できる。
- レート制限・課金エラーの分類は **TBD**。

## 7. 参考実装の構成

```text
src/modules/provider-openai/
  index.ts        # Provider 実装 + ctx への登録
  manifest.json   # roles: ["provider"], critical: true, permissions: [secrets.read]
```

- プロバイダーは `critical: true` を推奨する。落ちたら会話が成立しないため。
- ストリーム中の接続断は `model.failed` を発行し、critical なら `core.stopping` へ進む。

## 7.1 reasoning の共通規則

- reasoning の強度は config → セッション → `agent.spawn` の順で上書きされる。
- 履歴の assistant では reasoning ブロックを text / tool_call より前に置く。Anthropic はこの順序を要求する。
- 署名のない Anthropic thinking は返送しない。redacted_thinking は表示せず opaque として返送する。
- `budget_tokens` は `max_tokens / 2` 以下に丸める。
- thinking 有効時は temperature などの制約に注意し、衝突する指定を送らない。
- 対応しないモデル・指定はエラーにせず無視し、`reasoning_ignored` と診断ログに残す。

## 8. Anthropic 実装

`src/modules/provider-anthropic` が Messages API のストリーミング実装。

- `anthropic/claude-sonnet-4-5` / `anthropic/claude-haiku-4-5` を既定モデルとする。`config.models` で差し替え可能。
- `ctx.secrets.get(apiKeySecret)` で API キーを取得する。取得は `stream()` の間だけ。
- `ctx.net.fetch` で `api.anthropic.com` に接続する。
- `system` の static ブロック末尾に `cache_control: { type: "ephemeral" }` を付ける。`cacheRead` は usage からコアへ返す。
- SSE の `input_json_delta` を蓄積し、`content_block_stop` で `tool_call` として返す。
- HTTP 400 の「prompt is too long」系は `code: "context_overflow"` に変換する。
- `config.logRaw: true` でリクエスト/SSE イベントを `ctx.log.debug` に出す。ヘッダー (API キー) はログに含めない。
- `stream: true` を必須で送る。
- `config.maxRetries` / `retryBaseDelayMs`: 408 / 429 / 5xx / 接続エラーの再試行（既定 2 回、1 秒から指数バックオフ）。
- `config.authStyle` は `x-api-key`（既定）または `bearer`。OpenCode Go の Anthropic 経路は `bearer` と `baseUrl` 上書きを使う。
- `config.reasoningStyle` は `anthropic_thinking`（既定）または `none`。
- `config.echoReasoning` は `never` / `tool_turns` / `always`（Anthropic の既定は `always`）。署名つき thinking を順序どおり返送する。
- thinking 有効時は `thinking: {type:"enabled", budget_tokens}` を送り、`max_tokens / 2` 以下に丸める。`max_tokens < 2048` では無効化する。
- `redacted_thinking` は `opaque` として保存し、そのまま返送する。署名のない thinking は返送しない。
- `x-opencode-session` をセッション ID として送る。

```jsonc
{
  "modules": [
    {
      "use": "./modules/provider-anthropic",
      "config": { "model": "anthropic/claude-sonnet-4-5", "logRaw": false }
    }
  ],
  "secrets": {
    "ANTHROPIC_API_KEY": { "env": "ANTHROPIC_API_KEY" }
  }
}
```

## 9. OpenCode Go 実装

`src/modules/provider-opencode-go` が OpenCode Go の OpenAI 互換 chat completions 実装。

- エンドポイント: `https://opencode.ai/inference/go/openai/v1/chat/completions`
- モデル ID: `opencode-go/<model-id>`。`src/modules/provider-opencode-go/models.json` に既定一覧。
- 認証: `Authorization: Bearer <OPENCODE_API_KEY>`。
- `x-opencode-session` にセッション ID を送る (`ModelRequest.sessionId`)。
- `user-agent` は `Aiken-harnes/0.1.0` を既定とする。
- `tool_calls` のストリーミング差分を index ごとに組み立て、finish 時に `tool_call` として返す。
- `usage.prompt_tokens_details.cached_tokens` を `cacheRead` として返す。
- 400 のコンテキスト長超過は `context_overflow` に変換する。
- `config.logRaw` でリクエスト/SSE を `ctx.log.debug` に出す。Authorization ヘッダーはログに出さない。
- `maxTokens` の既定は `32768`（モデルの `maxOutput` で上限を切る）。長い reasoning に備える。
- `config.reasoningStyle`: `effort_param`（既定）/ `thinking_object` / `both` / `anthropic_thinking` / `none`。
- `config.effortMap`: 共通 effort をモデル固有値へ変換する。
- `config.echoReasoning`: `never`（既定）/ `tool_turns` / `always`。assistant の `reasoning_content` として返送する。
- `config.reasoningField`: 返送フィールド名。既定 `reasoning_content`。
- `config.reasoningRetry`: reasoning 起因の 400 のとき、指定を外して 1 回だけ再試行する。
- `config.maxRetries` / `retryBaseDelayMs`: 408 / 429 / 5xx / 接続エラーの再試行（既定 2 回、1 秒から指数バックオフ）。
- ストリームの `reasoning_content` / `reasoning` を `reasoning` イベントに変換し、`completion_tokens_details.reasoning_tokens` を `usage.reasoning` に載せる。

```jsonc
{
  "modules": [
    {
      "use": "./modules/provider-opencode-go",
      "config": { "model": "opencode-go/glm-5.3-flash", "logRaw": false }
    }
  ],
  "secrets": {
    "OPENCODE_API_KEY": { "env": "OPENCODE_API_KEY" }
  }
}
```
