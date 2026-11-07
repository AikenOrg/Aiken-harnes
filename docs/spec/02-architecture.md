# 02. アーキテクチャ

## 1. 依存方向

```text
src/protocol  ←  src/core  ←  src/modules
      ↑              ↑
      └──────────────┴── tests
```

- `src/protocol` は純粋な型・zod スキーマ・定数のみ。コアにもモジュールにも依存しない。
- `src/core` は `protocol` に依存してよいが、特定モジュールを import しない。モジュールは実行時にパスからロードする。
- モジュールは `protocol` と `ctx` にだけ依存する。他のモジュールを直接 import しない (`ctx.modules.call` を使う)。

## 2. コアの構成要素

| コンポーネント | 責務 | 保持する状態 |
|---|---|---|
| `EventBus` | イベントの発行・購読・`seq` 採番 | 購読者、`seq` カウンタ |
| `SessionManager` | セッションの作成・親子関係・状態・モデル | `id` / `parentId` / `state` / `model` |
| `HistoryManager` | **実行中履歴の唯一の正**。追記・読み出し・書き換え | `Map<sessionId, Message[]>` |
| `PromptAssembler` | 断片の登録・並び替え・結合・キャッシュ境界 | 断片一覧 |
| `ToolRegistry` | ツール定義と zod スキーマ・実行モード | ツール一覧 |
| `TurnLoop` | モデル呼び出し、ストリーム、ツール実行、履歴追記 | 実行中のターン |
| `JobManager` | ジョブ ID 発行・状態遷移・タイムアウト・通知・キャンセル | ジョブの状態と所有セッション |
| `ModuleHost` | manifest 検証、ロード、ロール排他、`critical` 判定 | ロード済みモジュール |
| `PermissionBroker` | 承認、`ctx` 呼び出し時の権限検査、警告 | 付与済み権限 |
| `HookRunner` | フックの順次実行と結果の合成 | フック一覧 |

- コアは永続化を知らない。履歴の保存は購読モジュール、セッションの復元は role API、結果の保存は result-store が担う。
- 履歴の権限検査はコアの `ctx.history` に一本化する。モジュール側のストアは権限を持たない。

## 3. 状態の所在

| 状態 | 所在 | 備考 |
|---|---|---|
| セッションの `id` / `parentId` / `state` / `model` | コア (メモリ) | session-store が永続化 |
| メッセージ履歴 | コア (メモリ) | 唯一の正。history-store は投影 |
| ジョブの状態 | コア (メモリ) | 永続化しない |
| ジョブ結果の本体 | result-store (無ければコアのメモリ) | `read_result` で取得 |
| プロンプト断片 | コア (登録内容) + モジュール (供給) | config の断片は最優先 static |
| 権限の付与記録 | コア + `approvals.json` | モジュールには預けない |
| API キー | コアの秘密情報ストア | 送信時にプロバイダーへ渡す |
| ログ (診断 / 履歴) | 別物。診断は `ctx.log`、履歴ログはモジュール | 混同しない |

## 4. 起動シーケンス

1. `config.json` を読み、zod で検証する。
2. コアを初期化する (EventBus / SessionManager / HistoryManager / JobManager / PermissionBroker)。
3. `modules` の manifest を読み、`requires` からロード順を決める。
4. manifest を検証し、ロールの排他を検査する。
5. 要求権限をユーザーへ提示し、承認を得る。危険な組み合わせは警告する。
6. 承認済みモジュールを順に `init` する。`ctx` を渡す。
7. `core.started` を発行する。
8. `config.restore: "last"` のときだけ、session-store の `latestRestorable()` で直前のセッションを開く。既定は `"none"`。
9. UI の準備完了後、入力受付を開始する。UI は `session.listRestorable()` → `session.restore(id)` で任意のセッションを復元できる。
10. 復元はコアがセッションを `restoring` にし、history-store の role API `restoreSession(id)` を呼ぶ。history-store が `ctx.history.restore` で履歴を戻す。

- 復元中のセッションは `restoring` 状態で、`user.message` を受け付けない。
- 復元してもターンループは再開しない。ユーザー入力か、保留中の通知による autoWake を待つ。
- `critical: true` のモジュール、または provider がロードできない場合は起動中止。
- それ以外の失敗は `module.failed` → `module.disabled` で続行する。
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
    if pending: history.appendTail(session.id, notificationMessage(pending))  # モデル呼び出し直前
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
  jobId = jobs.create({ sessionId, ownerSessionId, callId, tool, timeoutMs })
  bus.emit job.running
  handler(args, { signal, jobId })
  ...
  module -> ctx.jobs.done(jobId, { summary, result })
         or ctx.jobs.fail(jobId, { code, message })
  -> コアが result-store へ保存
  -> 状態更新 + job.done / job.failed
  -> 通知キューへ
  -> 次のモデル呼び出し直前に履歴末尾へ追記 (job.notified)
```

- `ctx.jobs.done` / `fail` はジョブごとにちょうど 1 回。2 回目以降は無視。
- タイムアウトはコアが管理し、`cancelled (by: "timeout")` にする。
- `wait` の戻り値で受け取ったジョブは通知しない。

## 6. 停止シーケンス

1. `core.stopping` を発行する。
2. 新規 `user.message` の受付を止める。
3. 実行中ターンに AbortSignal を渡し、全ジョブを `by: "system"` でキャンセルする。
4. モジュールの `dispose` を逆順に呼ぶ。SQLite はキューを drain してから close する。
5. プロセスを終了する。

履歴はコアのメモリにあるが、追記のたびに `message.appended` を発行しているため、history-store があれば特別な flush は不要。

## 7. 並行性

- 1 セッション内のターンは直列 (同じセッションに 2 つ目のターンが来たらキューに積む)。
- セッションをまたぐターンは並行可能。
- ジョブはターンから独立して並行実行する。セッションあたりの同時数に上限を設ける。
- 通知の追記はセッション単位で直列。1 メッセージにまとめる。
- イベントの `seq` はコア内で単調増加。購読者への配信順序は発行順を保証する。

## 8. ディレクトリ構成

```text
.
├── docs/                  # 仕様・ADR
├── src/
│   ├── protocol/          # 共有型・zod スキーマ (events / manifest / provider / config / ctx)
│   ├── core/              # コア実装
│   ├── modules/           # 組み込みモジュール (provider-*, tools, sqlite, ui-*)
│   ├── shared/            # 汎用ユーティリティ
│   └── index.ts           # エントリポイント
├── tests/                 # bun test
├── config/                # config.example.json
└── .github/workflows/     # CI (typecheck + test + docs)
```

モジュールは将来 `modules/<name>/manifest.json` + エントリポイントとして配布する。

## 9. エラー境界

| 境界 | 挙動 |
|---|---|
| 同期ツール | エラーをそのまま `tool_result` としてモデルに返す |
| 非同期ツール | `ctx.jobs.fail` → `job.failed` + 通知。例外でコアを落とさない |
| プロバイダー | ストリーム中の失敗は `model.failed`。`critical` なら即停止 |
| モジュール初期化 | `critical` なら起動中止、それ以外は無効化 |
| モジュール実行中の死亡 | 実行中ジョブを `failed (code: "module_died")` |
| フック | 例外は記録し、そのフックを無視して続行 (拒否系は安全側) |
| イベント購読者 | 例外を隔離し、他の購読者へ配信を続ける |
