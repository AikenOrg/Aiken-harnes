# M4b 実装ノート: サブエージェント

2026-11-08 時点。コアの `ctx.agent` と builtin `tools-agent` モジュールを実装した。

## 設計

- エージェント依頼は非同期ジョブ。
  - `spawn` / `send` は `{sessionId, jobId}` / `{jobId}` を返す。
  - 子がターンを終えて idle になると `job.done`（通常終了）、それ以外は `job.failed` / `job.cancelled`。
  - 結果本体は子の最終応答全文。summary は先頭 200 文字。
- モデル向けツールは `tools-agent` が提供:
  - `spawn_agent` / `send_message` / `list_agents` / `close_agent`
  - すべて `agentTool: true`。子の既定ツールから除外される。
- フック `agent.route` を追加。送信先・本文を拒否/書き換えできる。M4b では規則を入れない。
- モデル呼び出し全体に `Semaphore`（`agents.maxConcurrentModelCalls`、既定 4）を適用。
- 子セッションは `parent_id` つきで保存するが、復元対象は最上位のみ。子を待っていた running ジョブは `failed (interrupted)`。

## ctx.agent

```ts
spawn({ parentSessionId, task, prompt?, volatile?, model?, tools?, autoWake? })
  -> { sessionId, jobId }
send(fromSessionId, toSessionId, text) -> { jobId }
message(...) // send の互換エイリアス
cancel(fromSessionId, toSessionId, opts?)
close(fromSessionId, toSessionId, opts?)
list(fromSessionId) -> Session[]
```

- `spawn` は `agent.spawn` + `prompt.contribute`。
- `send` / `message` は `agent.message`。
- `cancel` / `close` / `list` は `agent.spawn`。
- 対象は自分の子孫のみ。自分自身・親・兄弟は拒否。
- `prompt` は session 断片、`volatile` は volatile 断片。static は追加不可。
- `tools` は親の有効ツールの部分集合。省略時は親のツールから agent ツールを除いたもの。
- `autoWake` の既定は true。

## 上限

| 項目 | 既定 | エラーコード |
|---|---|---|
| 深さ | 3 | `max_depth_exceeded` |
| 子の数 | 8 | `too_many_children` |
| 全体のエージェント数 | 16 | `too_many_agents` |
| prompt の長さ | 8 KiB | `invalid_state` |
| モデル同時呼び出し | 4 | （キュー待ち） |

閉じたセッションは数えない。

## イベント

- `agent.spawned` `{ childSessionId, parentSessionId, model, tools }`
- `agent.message` `{ from, to, jobId }`（本文なし）
- `agent.cancelled` `{ sessionId, by }`
- 子の close は子ごとに `session.closed`
- ジョブ終端は既存の `job.*`（`callId` 付き）

## 永続化

- 子セッションも `sessions` に `parent_id` 付きで保存。
- `listRestorable()` / `latestRestorable()` は最上位のみ。
- `session.restore(childId)` は拒否。
- 親を復元したとき、子を待っていた running なジョブは `failed (interrupted)`。子セッションは復元されない。

## テスト

`tests/core/agents.test.ts` / `tests/core/semaphore.test.ts` / `tests/modules/store-sqlite.test.ts`:

- 親 spawn → 子 read → 親 wait → read_result で子の全文
- wait なしの完了通知
- 子への send で新ターン
- `cancelAgent` で子の shell ジョブを中断
- 親 close で子孫を再帰 close
- 子から親・兄弟への操作を拒否
- 深さ / 子数 / 全体数 / prompt 長 / tools 部分集合
- `agent.route` の拒否
- セマフォのキュー待ち（`maxConcurrentModelCalls`）
- autoWake の連続回数上限
- 子は復元されず、親の agent ジョブは interrupted
- 実 API（OpenCode Go）で 2 子の並行実行と集約

## 制限

- チームポリシー（誰が誰に送れるか等）は未実装。`agent.route` の入口だけ用意。
- 子の復元はしない。
- Windows 実機の確認は未実施。
