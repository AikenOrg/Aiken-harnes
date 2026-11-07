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
};

type ModelRequest = {
  model: string;
  system: PromptSegment[];
  messages: Message[];
  tools: ToolSpec[];
  params?: { temperature?: number; maxTokens?: number };
};

type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "usage"; input: number; output: number; cacheRead?: number }
  | { type: "stop"; reason: "end" | "tool_use" | "length" | "error" };
```

- プロバイダーはモジュール (`roles: ["provider"]`) として実装し、`init` で `ctx.providers.register(provider)` を呼ぶ。複数ロードできる。
- モデル ID は `"<prefix>/<model>"` 形式。接頭辞ごとに担当プロバイダーは 1 つ。同じ接頭辞の重複は起動失敗。
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
  /** キャンセルで途切れたアシスタントメッセージ。テキストだけを保持する。 */
  interrupted?: boolean;
};

type Block =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; toolCallId: string; name: string; content: string; isError?: boolean }
  | { type: "notification"; entries: JobNotification[] };
```

- 1 メッセージは複数ブロックを持つ。テキストと tool_call が同時に返る場合がある。
- `tool_result` は対応する `tool_call` の直後に置く。プロバイダーはこの順序を前提に変換してよい。
- `notification` はジョブ完了通知の配列。1 メッセージに完了順でまとめて入る。プロバイダーは `role` と本文を自前の形式へ写像する。
- `system` は `ModelRequest.system` に分離して渡す。`messages` に system ロールを混ぜない。

## 3. ストリームの扱い

- `text` は到着順に `model.delta` として中継する (購読者のみ)。
- `tool_call` はコアが蓄積し、`stop` 後にまとめて実行する。プロバイダーは 1 つの tool_call を分割して返してよいが、`id` は同一にする。
- `usage` は複数回来てよい。コアは加算する。
- `stop.reason` の解釈:

| reason | コアの挙動 |
|---|---|
| `end` | ターン終了 |
| `tool_use` | tool_call を実行してループ継続 |
| `length` | ターン終了。必要なら継続を促す (TBD) |
| `error` | `model.failed`。`critical` なら停止 |

- ストリームが `stop` を返さずに終了した場合は `stop.reason = "error"` とみなす。
- プロバイダーがコンテキスト長超過を検出したら、`error.code = "context_overflow"` を返す。コアは通常の `context_overflow` と同じ扱いにする (復元直後の安全網)。
- `signal.aborted` になったら、プロバイダーは速やかに反復を終了する。コアは `turn.ended` の `reason: "cancelled"` を記録し、生成済みテキストを `interrupted: true` で履歴に残す。途中の `tool_call` は捨てる。

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

- 初版では自動リトライしない。`model.failed` を発行し、UI が再試行を判断する。
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
