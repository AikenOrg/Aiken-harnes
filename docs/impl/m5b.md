# M5b 実装ノート: reasoning(thinking)の表示と設定

2026-11-08 時点。OpenCode Go の実 API でモデルごとの挙動を確認してから実装した。

## 1. 実 API 検証結果

対象: OpenCode Go。プロンプトは「391 は素数か。割り算を試して理由を説明して」。
OpenCode のモデル一覧 `https://opencode.ai/inference/v1/models` の `capabilities.reasoning` も参照した。

| モデル / 経路 | 指定なし | effort / thinking | 無効化 | 備考 |
|---|---|---|---|---|
| `glm-5.3-flash` / OpenAI 互換 | reasoning 274 文字 / 148 tokens | `low`: 25 / 12、`high`: 170 / 99 | `reasoning_effort:"none"`: 0 / 0 | `reasoning_content`。`off` は 400。有効値は `none/minimal/low/medium/high/xhigh/max` |
| `glm-5.3` / OpenAI 互換 | 76 文字 / 35 tokens | 実測対象 | `none`: 0 | 同上 |
| `deepseek-v4.1-flash` / OpenAI 互換 | 741 文字 / 263 tokens | `high`: 573 / 209 | `none`: 0 / 0 | 同上 |
| `deepseek-v4-pro` / OpenAI 互換 | 348 文字 / 142 tokens | 実測対象 | `none`: 0 | 同上 |
| `beam-free` / OpenAI 互換 | 523 文字 / 278 tokens | 実測対象 | — | `reasoning_content` |
| `grok-4.7` / OpenAI 互換 | 18 文字 / 392 tokens | — | — | `reasoning_content` |
| `kimi-k3` / OpenAI 互換 | `reasoning` / `reasoning_details` フィールド | — | — | `reasoning_content` ではない |
| `qwen3.8-flash` / OpenAI 互換 | 355 文字 / 206 tokens | — | — | Anthropic 形式の thinking は 400 だったが OpenAI 経路は動作 |
| `qwen3.8-max` / OpenAI 互換 | 345 文字 / 205 tokens | — | — | 同上 |
| `minimax-m3` / OpenAI 互換 | reasoning tokens 118 | `high`: 500 tokens | — | **reasoning 本文は返らない**（tokens のみ） |
| `minimax-m3` / Anthropic 互換 | thinking なし | `thinking:{enabled, budget_tokens}`: 1180 文字 + signature 64 + 350 thinking tokens | `{type:"disabled"}`: 0 | thinking + tool_use を署名つきで返送して 200 |
| `qwen3.8-flash` / Anthropic 互換 | — | 400 upstream invalid JSON | — | M5b では OpenAI 経路を使う |

追加で確認したこと:

- `glm` の reasoning 付き assistant + tool_call を `reasoning_content` つきで返送して 200。返送なしでも 200。
- MiniMax は「thinking してから read_file を呼ぶ」と明示すると thinking + signature + tool_use を返し、次ターンで署名つき thinking をそのまま返送して 200。
- MiniMax の OpenAI 経路は reasoning tokens だけを返し、本文を返さない。UI では非対応扱いにした。
- OpenAI 互換の `effort` は最上位の `reasoning_effort` で効く。Anthropic は `thinking: {type:"enabled", budget_tokens}`。
- 参考: OpenCode の実装（MIT）の `fitThinkingBudget`、block order、redacted/signature の扱いを参照した。コードはコピーせず、このハーネスの型に合わせて実装した。

## 2. 型

```ts
type ReasoningParams = { effort?: "off"|"low"|"medium"|"high"|"max"; budgetTokens?: number };

type ModelInfo = {
  // ...
  reasoning?: { supported: boolean; efforts?: ReasoningEffort[]; toggle?: boolean; budget?: boolean };
};

type ModelRequest = {
  // ...
  params?: { temperature?: number; maxTokens?: number; reasoning?: ReasoningParams };
};

type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "reasoning_end"; opaque?: unknown }
  | { type: "reasoning_ignored"; reason: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "usage"; input: number; output: number; cacheRead?: number; reasoning?: number }
  | { type: "stop"; reason: StopReason };

type Block =
  | { type: "reasoning"; text: string; opaque?: unknown }
  | // 既存の text / tool_call / tool_result / notification
```

## 3. イベント

- `model.delta` は **v2**。`{ v: 2, turnId, text, kind: "text" | "reasoning" }`。
- `model.completed.usage.reasoning` は任意。
- `session.reasoning` は設定変更と「無視された」診断を通知する。`reasoning: null` は設定解除。
- イベントの版は**種別ごと**。`model.delta` だけ v2、他は v1。

## 4. 優先順位

1. config `models.<id>.reasoning`
2. セッション `session.reasoning`（UI / `ctx.session.setReasoning`）
3. `agent.spawn({ reasoning })`

`setReasoning` は `ui` ロールまたは `session.input` 権限で呼べる。変更は次のターンから。`sessions.meta_json` に保存し、復元後も維持する。

## 5. プロバイダー設定

### provider-opencode-go (OpenAI 互換)

```json
{
  "reasoningStyle": "effort_param",
  "effortMap": { "medium": "high" },
  "echoReasoning": "never",
  "reasoningField": "reasoning_content",
  "reasoningRetry": true
}
```

- `reasoningStyle`: `effort_param` / `thinking_object` / `both` / `anthropic_thinking` / `none`
- effort は `effortMap` で変換し、モデルの `efforts` に無い値は近い値へ丸める。
- `echoReasoning`: `never` / `tool_turns` / `always`。assistant の `reasoning_content` として返送。
- `reasoning_effort` が原因の 400 だけ、指定を外して 1 回再試行する。成功したモデルはプロセス内で記憶し、以降は送らない。無視は `reasoning_ignored` とセッションに残す。
- `reasoning_content` / `reasoning` の両方を読み、`reasoning_end` を 1 回返す。

### provider-anthropic

```json
{
  "baseUrl": "https://opencode.ai/inference/go/anthropic/v1/messages",
  "authStyle": "bearer",
  "reasoningStyle": "anthropic_thinking",
  "echoReasoning": "always"
}
```

- `thinking` ブロック、`signature`、`redacted_thinking` を扱う。
- 履歴の assistant は **thinking → text → tool_use** の順序を保って返送する。
- 署名のない thinking は表示用に保存するが、返送しない。
- redacted は表示せず `opaque` として保存し、`redacted_thinking` として返送する。
- budget は `max_tokens / 2` 以下に丸める。`max_tokens < 2048` では thinking を無効化し `reasoning_ignored` を出す。
- thinking 有効時は `temperature` を送らない。
- OpenCode Go 用に `x-opencode-session` を送る。

## 6. 履歴・ジョブ

- reasoning は `Message.blocks` の `reasoning` ブロックとして保存する。SQLite は既存の `content_json` にそのまま入る。
- ジョブの `summary` とサブエージェントの最終応答は本文のみ。reasoning は含めない。
- キャンセル時は、その時点までの reasoning を `interrupted` 付きで保存する。署名が届いていなければ返送時に落とす。

## 7. UI / CLI

- UI は reasoning を本文と別の折りたたみブロックで表示する。ストリーミング中は展開、完了後は折りたたむ。
- 「reasoning を表示する」スイッチ（既定オン、localStorage 保存）。
- セッションごとの強度選択。モデルの `efforts` にある値だけを出す。非対応モデルでは選択を出さない。
- 無視された場合はセッションに警告チップを出す。
- CLI は `--show-reasoning` で薄い表示（ANSI dim）。

## 8. テスト

- `tests/core/reasoning.test.ts`: 履歴ブロック、v2 delta、usage、優先順位、ジョブ summary、キャンセル、ignored。
- `tests/modules/opencode-go.test.ts`: effort/thinking/budget、effortMap、echo、reasoning ストリーム、限定再試行、無関係 400。
- `tests/modules/anthropic.test.ts`: thinking 順序、署名なし除外、redacted、budget、stream、bearer。
- `tests/modules/store-sqlite.test.ts`: reasoning 設定とブロックの復元。
- `tests/modules/ui-web.test.ts`: `session.setReasoning` コマンド。
- 実 API: GLM で UI 経由の reasoning 表示、MiniMax Anthropic で署名つき thinking のツール往復を確認。
- ヘッドレス Chromium: ストリーミング中は reasoning が展開され、完了後は履歴の折りたたみブロックになることを確認。

## 9. 未確認・制限

- すべてのモデルの reasoning 対応を実測したわけではない。UI は実測またはモデル一覧の能力があるものだけ表示し、それ以外は非対応扱い。
- MiniMax の OpenAI 経路は reasoning 本文を返さないため非対応。Anthropic 経路を使う。
- 将来の compaction では、古いターンの reasoning を最初に捨てる。
