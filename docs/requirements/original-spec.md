# ハーネス確定仕様 (2026-11-07 時点)

> このファイルはユーザー提示の原文をそのまま保存する。編集しない。
> 解釈・補完は `docs/spec/` に書く。

## 1. 前提
- ゼロから自作する。言語は TypeScript(Bun)。実装は AI に任せる
- 対象 OS は Linux / Windows。OS 固有機能に依存しない
- サーバー/クライアント方式。UI(WebUI / TUI)もモジュール

## 2. コアの責務
- コアが持つもの: AI とのループ制御、モデル選択、イベントバス、モジュールのロード、セッション ID と履歴(既定はメモリ)、ジョブ ID の発行と状態管理
- モデル呼び出しもモジュール(プロバイダー)。コアはプロバイダーを呼んで応答を受け、インターフェイスを組み立てる
- tools(read / write / shell を含む)、ログ、セッション永続化、compaction、UI はすべてモジュールで疎結合
- モデル応答の開始・ストリーム・完了はコアの管轄

## 3. セッションとシステムプロンプト
- セッション = ID / 親 ID / 状態 / モデル(コアが最小限保持)。履歴や永続化とは分離
- 永続化と復元だけモジュール
- サブエージェントは親 ID を持つ別セッション。呼び出し元がプロンプトを指定できる
  - 追加できるのは session / volatile 断片まで。コアと config の static 断片は上書き不可
  - `agent.spawn` と `prompt.contribute` の両権限が必要
- システムプロンプトは断片(優先度 + 安定度 static / session / volatile)。モジュールが登録し、コアが結合してキャッシュ境界を管理。config.json のプロンプトは最優先の static 断片

## 4. ロールと権限
- モジュールは manifest でロールと権限を要求し、ユーザーが承認する
- 排他ロール(同時に1つ): history-store(履歴の永続化)、compactor、session-store など
- オブザーバー権限: 読み取り専用で複数可(例: ログは `history.read`)
- 書き換え権限(`history.rewrite`)は compactor だけ
- 権限の重いモジュール(プロバイダー、shell など)は基本ロールとして区別する
- shell は特権モジュール。`exec` 権限を持てるのは shell を追加するモジュールだけ
  - モード選択: フルアクセス / ホワイトリスト式。ホワイトリスト時と承認は `tool.before` フックで実施
  - シェルのパースによる防御には限界があり、許容する
- 危険な組み合わせ(履歴読み取り + ネットワークなど)は承認時に警告
- モジュール間通信は `talksTo` で事前宣言した相手だけ

## 5. 権限の強制(先送り)
- コア API 系の権限(履歴、プロンプト、セッション、エージェント、モジュール間通信)は、ctx 経由で実際に強制する
- fs / net / env / exec は、宣言と承認の記録のみ。実効的な強制(サンドボックス)は今後の課題
- 外部取得(`user/repository`)は強制の仕組みができるまで解禁しない。ローカルのモジュールのみ
- 外部取得の解禁時は、コミットハッシュ固定、導入時の権限承認、権限が増える更新での再承認、インストールスクリプトの禁止
- 特権操作は ctx 経由に寄せる。manifest の `runner` は今は `inprocess` のみ

## 6. ツールと非同期ジョブ
- 入力スキーマは zod(コード側)。同期 / 非同期は manifest(またはロード時の宣言)で宣言
- read など軽い処理以外は基本的に非同期
- 同期ツールのエラーはそのまま返す
- 非同期ツール: ID だけ返して終了。完了とエラーは通知で返す。モジュールは完了をコアに知らせる
- ID(caller id)はコアが発行。状態は running / done / failed / cancelled
- 結果は SQLite モジュールに保存。通知は JSON 固定で `{id, status, summary, size}` のみ。本体は `read_result(id)` で取得
- 通知は次のモデル呼び出しの直前に、履歴の末尾へ追記する(キャッシュを壊さない)
- コア提供のジョブ制御ツール(ID を持つのがコアのため):
  - `wait(ids, timeout)`: 複数 ID 可、タイムアウト必須
  - `cancel(id)`: AI による都合のキャンセル。対象は自分のセッションと、その子孫が起動したジョブのみ
  - `read_result(id)`
- キャンセルの主体は4種類: `ai` / `user` / `timeout` / `system`。`job.cancelled` イベントに `by` を記録
- キャンセルの流れ: コアが状態を `cancelled` に遷移 → モジュールへ AbortSignal を渡す。モジュールが中断できなくても、結果は破棄する
- サブエージェントのキャンセルも同様(`agent.cancel(sessionId)`、自分の子孫のみ)

## 7. 設定と障害
- config.json の `modules` でモジュールを指定(例: `tools: ["xxx.js", "user/repository"]`)。モジュールごとの設定も書く
- セッションとログの保存先は、履歴モジュールが決めるか、config.json に書く
- SQLite はコアではなく必須モジュールが持つ
- `critical`: 今は真偽値のみ(将来、重要度のレベルを足せる形)
  - critical なモジュール(history-store、プロバイダー、SQLite など)が落ちたら、即エラーで停止。プロバイダーの接続中の死亡も同様
  - それ以外は無効化して続行(`module.disabled`)
- イベント(通知)
共通形式: `{ id, seq, ts, type, source, sessionId?, payload }`

| 分類 | イベント |
|---|---|
| ユーザー入力 | user.message / user.cancel |
| セッション | session.created / closed / forked |
| ターン | turn.started / ended |
| モデル | model.requested / delta(既定は購読しない)/ completed / failed |
| ツール | tool.requested / started / completed / failed / cancelled |
| ジョブ | job.running / done / failed / cancelled(by 付き)/ notified |
| 履歴 | message.appended / history.rewritten |
| プロンプト | prompt.assembled |
| compaction | compaction.requested / completed |
| エージェント | agent.spawned / message / cancelled |
| モジュール | module.loaded / failed / disabled |
| 権限 | permission.requested / granted / denied / violation |
| コア | core.started / stopping |

## 8. フック(順番に呼ばれ、結果を変えられる)
- `prompt.assemble`: プロンプト断片の登録と並び替え
- `tool.before`: ツール実行前の承認、拒否、引数の書き換え
- `compaction.decide`: compaction の実行判断

## 9. プロバイダーのインターフェイス
```ts
interface Provider {
  models(): ModelInfo[]
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
}
type ModelRequest = {
  model: string
  system: PromptSegment[]
  messages: Message[]
  tools: ToolSpec[]
  params?: { temperature?: number; maxTokens?: number }
}
type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "usage"; input: number; output: number; cacheRead?: number }
  | { type: "stop"; reason: "end" | "tool_use" | "length" | "error" }
```
- Message はテキスト / tool_call / tool_result / 通知(ジョブ完了の JSON)のブロックの並び
- API キーはコアが保管し、リクエスト送信時にだけ渡す

## 10. manifest
```jsonc
{
  "name": "log-sqlite",
  "version": "0.1.0",
  "roles": ["history-store"],
  "critical": true,
  "runner": "inprocess",
  "requires": ["session-store"],
  "talksTo": ["ui-web"],
  "subscribes": ["message.appended", "tool.*"],
  "permissions": [
    { "cap": "history.read" },
    { "cap": "fs.write", "paths": ["./data"] }
  ],
  "tools": [{ "name": "search_log", "mode": "sync" }]
}
```

## 11. 権限一覧
- コア API 系(実効あり): history.read / history.append / history.rewrite / prompt.contribute / session.manage / agent.spawn / agent.message / tool.register / module.talk:<name>
- 外部資源系(宣言と承認のみ): fs.read / fs.write(paths)、net(hosts)、env(names)、exec、secrets.read(プロバイダー用)

## 12. ctx API
- ctx.bus / ctx.tools.register / ctx.history / ctx.prompt / ctx.session / ctx.agent
- ctx.fs / ctx.net.fetch / ctx.env / ctx.secrets(宣言された権限の範囲だけ)
- ctx.modules.call(name, ...)(`talksTo` の相手だけ)
- ctx.log(コアの診断ログ。履歴のログとは別)

## 13. DB の同時書き込み
- SQLite モジュールが唯一の書き込み担当。他のモジュールは API 経由で依頼し、内部のキューで順番に処理。WAL モード

## 14. 未決定
- 評価用タスクセット(最小シナリオ: read → 非同期 shell → wait → 完了通知 など)
- compaction の詳細(履歴の最小ループが動いてから)
- チーム機能(モジュール側の設計。別途)
- 権限の実効的な強制(サンドボックス)
こんな感じでハーネスを作りたいから環境を整えて　ドキュメント整備から可能な限り shell を使ってタスクを実行してください。
