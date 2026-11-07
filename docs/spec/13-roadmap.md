# 13. ロードマップと評価

## 1. マイルストーン

### M0: 環境と仕様 (完了)

- リポジトリ初期化、Bun + strict TypeScript、CI (typecheck + test)
- 仕様書一式と ADR
- 共有型 (`src/protocol`) のスケルトン
- `events.ts` の zod スキーマと生成文書、config スキーマ
- 完了条件: `bun run check` が通る。docs の索引が揃っている。

### M1: 最小の会話ループ

- EventBus、SessionManager、PromptAssembler、TurnLoop
- コアの `HistoryManager` (メモリ履歴が唯一の正)
- フェイクプロバイダー (テスト用) + 実プロバイダー 1 つ
- 同期ツール 1 つ (`read`)
- 最小 UI (CLI または TUI) で 1 ターンが回る
- 完了条件: ユーザー入力 → モデル → ツール → 最終応答がイベントで追跡できる。

### M2: 非同期ジョブ

- JobManager、`ctx.jobs.done` / `fail`、タイムアウト、同時実行数上限
- メモリ result-store (SQLite は任意)
- 非同期 shell ツール、AbortSignal によるキャンセル
- `wait` / `cancel` / `read_result(offset, limit)` / `list_jobs`
- 通知の一括末尾追記と `job.notified`、autoWake
- 完了条件: 評価シナリオ E1〜E3 が通る。

### M3: 永続化と UI

- SQLite history-store (投影) + session-store、`ctx.history.restore` と `session.restore` による復元
- WebUI (HTTP/WS) とイベント購読
- ストリーミング表示 (`model.delta` の明示購読)
- 完了条件: プロセス再起動後も履歴とセッションが復元される。

### M4: 権限と compaction

- 承認フロー、危険な組み合わせの警告、承認記録
- compactor ロールと `compaction.decide`
- shell のホワイトリストと `tool.before` 承認
- 完了条件: `history.rewrite` が compactor 以外で拒否される。E4〜E6 が通る。

### M5: 堅牢化

- Windows での動作確認 (パス、シェル、シグナル)
- クラッシュ復旧、実行中ジョブの後始末
- サンドボックス設計 (fs / net / env / exec の実強制)
- 外部モジュール取得の設計 (コミット固定、再承認)

## 2. 評価シナリオ

### E1: read → 非同期 shell → wait → 完了通知

1. ユーザーが「ファイル一覧を取って」と依頼する。
2. モデルが `read` (sync) を呼び、結果を得る。
3. モデルが `shell` (async) を呼び、`{ jobId }` を受け取る。
4. モデルが `wait([jobId], 30000)` を呼ぶ。
5. ジョブ完了後、次のモデル呼び出し直前に通知が 1 メッセージ (完了順の配列) として履歴末尾へ追記される。
6. モデルが `read_result(jobId)` で本文を取得し、最終応答を返す。

検証:

- `job.running` → `job.done` → `job.notified` の順。
- 通知の各要素が `{id,status,summary,size}` のみ。
- `wait` で受け取ったジョブは通知されない (二重配信なし)。
- 通知追記後も既存メッセージの ordinal が変わらない。
- 最終応答に一覧の内容が含まれる。

### E2: AI によるキャンセル

1. 長時間ジョブを起動する。
2. モデルが `cancel(jobId)` を呼ぶ。
3. `job.cancelled` の `by` が `ai`。
4. モジュールが中断できない場合でも、遅延結果は破棄され `job.done` にならない。
5. モデルストリームをキャンセルした場合、生成済みテキストは `interrupted: true` で履歴に残り、途中の tool_call は捨てられる。
5. 範囲外のジョブ ID は `permission.denied`。

### E3: タイムアウト

1. `wait` のタイムアウトで戻る。ジョブは running のまま。
2. ジョブ側のタイムアウトが発火した場合、`job.cancelled` の `by` が `timeout`。

### E4: サブエージェント

1. 親が `agent.spawn` で子を作る。プロンプトは session 断片として追加される。
2. 子のプロンプトに親の static が含まれる。
3. static を上書きしようとする spawn は `permission.violation` で拒否。
4. 子のジョブを親がキャンセルできる。兄弟の子は不可。
5. `agent.close` で子と孫が閉じる。親を close しても子孫が閉じる。
6. `session.delete` は closed のセッションだけを消し、開いている子孫がいると拒否される。

### E5: 権限の実効強制

1. `history.rewrite` を compactor 以外が呼ぶと拒否。
2. `talksTo` に無い相手への `ctx.modules.call` が拒否。
3. `exec` を shell ロール以外が要求するとロード拒否。

### E6: compaction (M4 以降)

1. しきい値を超えたら `compaction.decide` が呼ばれる。
2. compactor だけが `history.rewrite` を実行できる。
3. 書き換え後も直近 N 件と通知の順序が保たれる。
4. compactor が無い状態で `usage.input` がしきい値を超えたら、履歴を切り捨てず `turn.ended (context_overflow)` で止まる。

### E7: 再起動復元 (M3 以降)

1. 会話後にプロセスを停止する。
2. 再起動する (`restore: "none"`)。セッションは自動では開かない。
3. UI が `session.listRestorable()` で一覧を取得し、1 つを選んで `session.restore(id)` を呼ぶ。
4. 履歴が復元され、セッションは `idle` になる。ターンループは自動で再開しない。
5. 実行中だったジョブは `interrupted` で失敗し、running のまま残らない。未通知の完了通知は再キューに積まれる。
6. `restore: "last"` の場合は起動時に直前のセッションが自動で開く。

## 3. テスト方針

- **単体**: EventBus の seq/配信順、PromptAssembler の並びと境界、JobManager の状態遷移、権限検査。
- **統合**: フェイクプロバイダーでターンループを駆動。実際のネットワークは使わない。
- **E2E**: 評価シナリオを `bun test` で再現。一時ディレクトリの SQLite を使う。
- **決定性**: ID と時刻は注入可能にする。テストでは固定値を使う。
- **CI**: Linux で typecheck + test。Windows は定期的に手動/別ジョブで確認。

## 4. リスク

| リスク | 対策 |
|---|---|
| プロンプトのキャッシュ境界が崩れる | 安定度ブロックの順序をコアで強制し、違反を拒否 |
| 通知追記で履歴の既存部分が変わる | ordinal の追記のみ。rewrite は compactor に限定 |
| Windows のシェル差異 | shell モジュール内で吸収。コアはコマンド文字列を解釈しない |
| 権限が「宣言だけ」で危険 | 承認画面に未強制である旨を明示。危険な組み合わせを警告 |
| モジュールの暴走でコアが止まる | イベント購読の例外隔離、フックのタイムアウト、critical の即停止 |
| イベントの順序が崩れる | seq をコアで採番し、発行順配信をテスト |

## 5. 未決定リスト

[docs/spec/14-open-decisions.md](14-open-decisions.md) を参照。実装を進める前に、少なくとも M1 に影響する項目 (D1〜D5, D18, D24) を確定させる。
