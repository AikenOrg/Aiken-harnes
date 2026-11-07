# 14. 決定・補完・要確認事項

2026-11-07 のユーザー決定 (D22, D36〜D40、および追加の不整合修正) を反映済み。**確定**は原文またはユーザー判断、**提案**は本書で暫定採用した内容、**未決定**は TBD。

| ID | 論点 | 本書の扱い | 状態 |
|---|---|---|---|
| D1 | プロンプト断片の順序 | static → session → volatile。static 内は config → core → module、priority 降順 | 提案 |
| D2 | セッション状態 | `restoring / active / idle / closed / error` の 5 状態 | 確定 |
| D3 | サブエージェント終了後の状態 | `idle` のまま保持し、明示クローズのみ | 提案 |
| D4 | fork の意味 | コアのメモリ履歴を複製して分岐。spawn は複製しない | 提案 |
| D5 | ロールと排他性 | provider (複数・接頭辞ごとに 1・最低 1)、history-store / session-store / result-store / compactor / shell は各 1、ui は複数。兼任可 | 確定 |
| D6 | 承認記録の保存先 | ユーザー設定ディレクトリの `approvals.json`。モジュール名 + コードハッシュ + 権限ハッシュ | 確定 |
| D7 | フック登録の権限 | `tool.before` は新設の `tool.intercept` (重い権限)。`prompt.assemble` は `prompt.contribute`、`compaction.decide` は compactor ロール | 確定 |
| D8 | tool.before の拒否 | `permission.denied` (`hook` と理由) → `tool.failed (code: "denied")` → AI に拒否理由を `tool_result` で返す | 確定 |
| D9 | 非同期ツールの完了契約 | `ctx.jobs.done` / `ctx.jobs.fail` をちょうど 1 回。2 回目以降は無視 | 確定 |
| D10 | result-store が無い場合 | コアのメモリに結果を保持。再起動で消える。必須化は critical で選ぶ | 確定 |
| D11 | wait のタイムアウト | ジョブをキャンセルしない。待機だけ打ち切り、現在の状態を返す | 確定 |
| D12 | read_result の巨大結果 | `offset` / `limit` を最初から用意。既定 limit は 20,000 文字。`{truncated, nextOffset}` を返す | 確定 |
| D13 | ジョブのタイムアウト | ツールの `timeoutMs` と config 上限。コアが `cancelled (by: timeout)` にする | 確定 |
| D14 | キャンセル時の部分応答 | 生成済みテキストは `interrupted: true` で履歴に残す。途中の tool_call は捨てる | 確定 |
| D15 | API キーの保管 | 環境変数 → `secrets` マッピング。`stream()` 中のみ取得可 | 提案 |
| D16 | config の modules 形式 | 1 本の配列。文字列または `{use, config, ref}`。種別は manifest が持つ | 確定 |
| D17 | config プロンプトの上限 | 32 KiB | 提案 |
| D18 | 各イベントの payload | `src/protocol/events.ts` の zod が唯一の正。全 payload に `v:1`。本文は ID 参照。エラーは `{code,message}` | 確定 |
| D19 | イベント id の形式 | `evt_<bootId>_<seq>`。bootId は起動ごとのランダムな短い文字列。再起動で衝突しない | 確定 |
| D20 | 通知の届け方 | 次のモデル呼び出し直前に、完了順の配列を 1 メッセージで末尾追記。wait 受取分は通知しない | 確定 |
| D21 | 再起動時の running ジョブ | 状態は `running / done / failed / cancelled` のまま。復元時に running を `failed (code: "interrupted")` にする | 確定 |
| D22 | セッションの復元 | UI の明示要求 (`session.restore`)。`restore: "none" \| "last"`、既定 `"none"`。復元してもループは再開しない | 確定 |
| D23 | 診断ログと履歴ログ | `ctx.log` はコアの stderr/ファイル。ログモジュールは権限と購読で動く (log-store ロールは廃止) | 確定 |
| D24 | 既定の履歴 | コアのメモリが唯一の正。history-store は `message.appended` を購読する投影 | 確定 |
| D25 | result-store のロール名 | 原文に無いため `result-store` を追加 | 確定 |
| D26 | ctx のシリアライズ | 将来の worker 化に備え、関数を manifest に持たせない | 提案 |
| D27 | プロバイダーの自動リトライ | 初版はなし。UI 判断 | 提案 |
| D28 | 複数プロバイダーのモデル重複 | 接頭辞の重複は起動失敗。provider が 0 でも起動失敗 | 確定 |
| D29 | 1 ターンの最大ステップ | 50 | 提案 |
| D30 | compaction の詳細 | 最小ループが動くまで未決定。しきい値・要約方式は未定 | 未決定 |
| D31 | チーム機能 | モジュール側で別途設計 | 未決定 |
| D32 | サンドボックス | 将来。現状は宣言と承認のみ | 未決定 |
| D33 | 外部モジュール取得 | 強制機構ができるまで禁止。将来もディレクトリ形式だけ | 確定 |
| D34 | tool.* と job.* の終端 | tool.* は呼び出しがモデルに返るまで。async の tool.completed は jobId 返却時。ジョブ終端は job.* のみ。job.* は callId で相関 | 確定 |
| D35 | 「caller id」の意味 | コアが発行するジョブ ID と解釈 | 確定 |
| D36 | manifest.json の解決 | ディレクトリ基本 (`<dir>/manifest.json`、`main` 既定 `index.js`)。ファイルは `<basename>.manifest.json`。無ければ拒否。name は manifest が正。埋め込み不可。外部はディレクトリのみ | 確定 |
| D37 | 履歴復元の権限 | 専用 `history.restore` を新設。history-store ロールのみ。`restoring` かつ履歴が空のセッションだけ | 確定 |
| D38 | 同時ジョブ上限の超過 | `too_many_jobs` で即失敗。実行中ジョブ ID を載せる。既定 8。同期ツールは数えない | 確定 |
| D39 | autoWake の既定値 | 最上位は `false`、サブエージェントは `true`。`agent.spawn` で上書き。連続自動起動は既定 10 回まで | 確定 |
| D40 | summary と通知の上限 | summary は既定 200 / 設定上限 500 文字 (コードポイント)。通知全体は既定 2000 文字。超過分は `ほか N 件` + ID (最大 20) | 確定 |
| D41 | エラーコードの管理 | `src/protocol/common.ts` の `ERROR_CODES` にコア用を集約 | 提案 |
| D42 | 結果の削除 | セッション削除時に結果も削除。`resultTtlDays` (既定 30 日) で終端かつ通知済みの行を掃除 | 確定 |
| D43 | セッション復元の API | session-store が `listRestorable()` / `latestRestorable()` を提供。コアが呼ぶ | 確定 |
| D44 | 履歴復元の前提 | history-store は session-store を `requires` に入れる。session-store が restoring で作り、history-store が履歴を入れる | 確定 |
| D45 | tool.requested の引数 | イベントには載せない。承認は tool.before フックで扱う | 確定 |
| D46 | 復元失敗時の状態 | セッションを `error` にし、UI から再試行できる。`session.closed` は発行しない | 提案 |
| D47 | 復元時の未通知通知 | 完了済みで未通知の通知を再キューに積む | 確定 |
| D48 | 復元中の入力 | `restoring` 状態では `user.message` を拒否 | 確定 |
| D49 | 通知から溢れたジョブの ID | `ほか N 件: id1, ...` (最大 20 件) を併記し、`list_jobs(status?)` を追加。範囲は自分のセッションと子孫 | 確定 |
| D50 | 復元用のジョブメタデータ | result-store に `session_id` / `status` / `notified` を保存。状態は 4 つのまま、running は復元時に `failed (code: "interrupted")`。無い構成では通知状態は戻らない | 確定 |
| D51 | セッション削除 | `session.delete` は `closed` のみ。履歴・セッション・結果を削除する | 提案 |

## 決定の要点

- **履歴**: コアのメモリが唯一の正。永続化は `message.appended` の購読による投影。復元は `ctx.history.restore` (専用権限) で、`restoring` かつ空のセッションだけ。権限検査はコアに一本化。
- **セッション復元**: UI の明示要求が基本。`restore: "last"` のときだけ起動時に自動で開く。session-store が restoring で作り、history-store が requires で後に続く。復元してもループは再開しない。running は `failed (code: "interrupted")`。
- **ロール**: provider は複数可 (接頭辞ごとに担当 1)。history-store / session-store / result-store / compactor / shell は各 1。兼任可。
- **manifest**: 別ファイル必須。ディレクトリ基本、単一ファイルは `<basename>.manifest.json`。名前は manifest の `name`。
- **イベント**: `events.ts` の zod が正。`v:1`、ID 参照、エラーは `{code,message}`。ID は `evt_<bootId>_<seq>`。文書は生成。
- **ツール/ジョブ**: tool.* は呼び出しがモデルに返るまで。async の tool.completed は jobId 返却時。ジョブ終端は job.* のみで、callId で相関。完了は `ctx.jobs.done/fail` でちょうど 1 回。
- **autoWake**: 最上位は無効、サブエージェントは有効。連続自動起動に上限。
- **summary/通知**: 200/500/2000 文字の上限。超えた分は切り詰め、通知は `ほか N 件` + ID。
- **設定/承認**: `modules` は 1 本の配列。承認はユーザー設定ディレクトリの `approvals.json`。`tool.intercept` は重い権限として警告。

## 次に確認したいもの

1. **D51**: `session.delete` を `closed` のみに限定してよいか (履歴・結果の一括削除を伴う)。
2. **D46**: 復元失敗時に `error` 状態で保持し、UI から再試行させる形でよいか。
3. **D1 / D3**: プロンプト断片の順序と、サブエージェント終了後の `idle` 保持。
4. **D15**: API キーの保管方式 (環境変数のみか、OS keyring も許すか)。
5. **D30**: compaction の詳細。

## 補完の原則

- 原文に書かれた語彙・イベント名・権限名は変えない。
- 原文が「未決定」としたものは、勝手に確定せず TBD のまま残す。
- 実装上都合で決めたものは、この表に追記してから実装する。
