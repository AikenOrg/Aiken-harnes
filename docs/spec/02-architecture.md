# 02. アーキテクチャ

## 1. 依存方向

```text
src/protocol  ←  src/core  ←  src/modules
      ↑              ↑
      └──────────────┴── tests
```

- `src/protocol` は純粋な型と定数のみ。コアにもモジュールにも依存しない。
- `src/core` は `protocol` に依存してよいが、特定モジュールを import しない。モジュールは実行時にパスからロードする。
- モジュールは `protocol` と `ctx` にだけ依存する。他のモジュールを直接 import しない (`ctx.modules.call` を使う)。

## 2. コアの構成要素

| コンポーネント | 責務 | 保持する状態 |
|---|---|---|
| `EventBus` | イベントの発行・購読・`seq` 採番 | 購読者、`seq` カウンタ |
| `SessionManager` | セッションの作成・親子関係・状態・モデル | `id` / `parentId` / `state` / `model` |
| `PromptAssembler` | 断片の登録・並び替え・結合・キャッシュ境界 | 断片一覧 (モジュール由来) |
| `ToolRegistry` | ツール定義と zod スキーマ・実行モード | ツール一覧 |
| `TurnLoop` | モデル呼び出し、ストリーム、ツール実行、履歴追記 | 実行中のターン |
| `JobManager` | ジョブ ID 発行・状態遷移・通知・キャンセル | ジョブの状態と所有セッション |
| `ModuleHost` | manifest 検証、ロード、`critical` 判定、無効化 | ロード済みモジュール |
| `PermissionBroker` | 承認、`ctx` 呼び出し時の権限検査、警告 | 付与済み権限 |
| `HookRunner` | フックの順次実行と結果の合成 | フック一覧 |
| `HistoryFacade` | 履歴モジュールへの読み書きを仲介 | なし (委譲) |

> コアは履歴の実体を持たない。既定のメモリ履歴も「必須の history-store モジュール」として実装する。これにより、保存先の差し替えと権限検査を同じ経路にできる。

## 3. 状態の所在

| 状態 | 所在 | 備考 |
|---|---|---|
| セッションの `id` / `parentId` / `state` / `model` | コア | 最小限。履歴は持たない |
| メッセージ履歴 | history-store モジュール | 既定はメモリ、必須構成では SQLite |
| ジョブの状態 | コア | 結果の本体は SQLite モジュール |
| プロンプト断片 | コア (登録内容) + モジュール (供給) | config の断片は最優先 static |
| 権限の付与記録 | コア | 監査イベントを発行 |
| API キー | コアの秘密情報ストア | 送信時にプロバイダーへ渡す |
| ログ (診断 / 履歴) | 別物。診断は `ctx.log`、履歴ログはモジュール | 混同しない |

## 4. 起動シーケンス

1. `config.json` を読み、zod で検証する。
2. コアを初期化する (EventBus / SessionManager / JobManager / PermissionBroker)。
3. `modules` を宣言順にロードする。各モジュールの manifest を検証する。
4. ロールの排他を検査する (重複は起動失敗)。
5. 要求権限をユーザーへ提示し、承認を得る。危険な組み合わせは警告する。
6. 承認済みモジュールを初期化し、`ctx` を渡す。`tool.register` / `prompt.contribute` / `bus.subscribe` を許可する。
7. `requires` の依存を満たせないモジュールは失敗扱いにする。
8. `core.started` を発行する。
9. UI モジュールの準備完了後、`user.message` を受け付ける。

起動に失敗した場合:

- `critical: true` のモジュール、または必須ロール (history-store / provider / sqlite) がロードできない → 起動を中止する。
- それ以外 → `module.failed` の後に `module.disabled` を発行し、続行する。
- 依存先が無効化されたモジュールも連鎖的に無効化する。

## 5. ターンループ

```text
on user.message(sessionId, text):
  session = sessions.get(sessionId) or error
  history.append(sessionId, user text)            # message.appended
  runTurn(session)

runTurn(session):
  bus.emit turn.started
  loop:
    pending = jobs.drainNotifications(session.id)  # 完了済みで未通知のもの
    if pending: history.appendTail(session.id, notifications)   # モデル呼び出し直前
    system = prompt.assemble(session)              # hook: prompt.assemble
    req = { model, system, messages: history.read(session.id), tools: registry.specs() }
    bus.emit model.requested
    stream = provider.stream(req, signal)          # コアが開始・中継・完了を管理
    for event in stream:
      text delta -> bus.emit model.delta (既定は購読されない)
      tool_call  -> 蓄積
      usage      -> 記録
      stop       -> break
    history.append(session.id, assistant message)  # テキスト + tool_call
    if no tool_call: bus.emit turn.ended; return
    for call in tool_calls:
      executeTool(session, call)                   # 同期は即結果、非同期は job 起動
                                                   # 結果は tool_result として履歴へ
    continue
```

### 非同期ジョブの流れ

```text
tool async:
  jobId = jobs.create(sessionId, toolName, ownerSessionId)
  bus.emit job.running
  result = await module starts work (AbortSignal 付き)
  on success: jobs.done(jobId, summary, resultRef)  -> job.done
  on error:   jobs.fail(jobId, error)               -> job.failed
  on cancel:  jobs.cancelled(jobId, by)             -> job.cancelled
  次のモデル呼び出し直前に通知を履歴末尾へ追記      -> job.notified
```

- ジョブは `tool.requested` → `tool.started` → `job.*` → `tool.completed` の順でイベントになる。
- `wait` は対象ジョブが終わるまでターンをブロックするコア提供ツール。タイムアウト必須。
- 非同期ツールの `tool_result` は「ID を返した」時点で 1 回返す。完了結果は通知と `read_result` で取得する。

## 6. 停止シーケンス

1. `core.stopping` を発行する。
2. 新規 `user.message` の受付を止める。
3. 実行中ターンに AbortSignal を渡し、`by: "system"` でジョブをキャンセルする。
4. モジュールの `dispose` を逆順に呼ぶ。SQLite はキューを drain してから close する。
5. 未保存の履歴があれば history-store に flush を要求する。
6. プロセスを終了する。

## 7. 並行性

- 1 セッション内のターンは直列 (同じセッションに 2 つ目のターンが来たらキューに積む)。
- セッションをまたぐターンは並行可能。
- ジョブはターンから独立して並行実行する。完了通知はセッション単位で直列に追記する。
- イベントの `seq` はコア内で単調増加。購読者への配信順序は発行順を保証する。

## 8. ディレクトリ構成

```text
.
├── docs/                  # 仕様・ADR
├── src/
│   ├── protocol/          # 共有型 (events / manifest / provider / messages / jobs)
│   ├── core/              # コア実装
│   ├── modules/           # 組み込みモジュール (provider-*, tools, sqlite, ui-*)
│   ├── shared/            # 汎用ユーティリティ
│   └── index.ts           # エントリポイント
├── tests/                 # bun test
├── config/                # config.example.json
└── .github/workflows/     # CI (typecheck + test)
```

モジュールの実体は将来 `modules/<name>/index.ts` として配布可能にする。今は `src/modules/` に置き、config からはファイルパスで指定する。

## 9. エラー境界

| 境界 | 挙動 |
|---|---|
| 同期ツール | エラーをそのまま `tool_result` としてモデルに返す |
| 非同期ツール | `job.failed` + 通知。例外でコアを落とさない |
| プロバイダー | ストリーム中の失敗は `model.failed`。`critical` なら即停止 |
| モジュール初期化 | `critical` なら起動中止、それ以外は無効化 |
| フック | フック内の例外は記録し、そのフックを無視して続行 (拒否フックを除く) |
| イベント購読者 | 購読者の例外は隔離し、他の購読者へ配信を続ける |
