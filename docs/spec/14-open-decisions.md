# 14. 決定・補完・要確認事項

2026-11-07 のユーザー決定 (D22, D36〜D40 を含む) を反映済み。**確定**は原文またはユーザー判断、**提案**は本書で暫定採用した内容、**未決定**は TBD。

| ID | 論点 | 本書の扱い | 状態 |
|---|---|---|---|
| D1 | プロンプト断片の順序 | static → session → volatile。static 内は config → core → module、priority 降順 | 提案 |
| D2 | セッション状態 | `restoring / active / idle / closed / error` の 5 状態 | 確定 |
| D3 | サブエージェント終了後の状態 | `idle` のまま保持し、明示クローズのみ | 提案 |
| D4 | fork の意味 | コアのメモリ履歴を複製して分岐。spawn は複製しない | 提案 |
| D5 | ロールと排他性 | provider (複数・接頭辞ごとに 1・最低 1)、history-store / session-store / result-store / compactor / shell は各 1、ui は複数。兼任可 | 確定 |
| D6 | 承認記録の保存先 | ユーザー設定ディレクトリの `approvals.json`。モジュール名 + コードハッシュ + 権限ハッシュ | 確定 |
| D7 | フック登録の権限 | 種別ごとに prompt.contribute / tool.register / compactor | 提案 |
| D8 | tool.before の拒否イベント | `permission.denied` を発行し、ツールは実行しない | 提案 |
| D9 | 非同期ツールの完了契約 | `ctx.jobs.done` / `ctx.jobs.fail` をちょうど 1 回。2 回目以降は無視 | 確定 |
| D10 | result-store が無い場合 | コアのメモリに結果を保持。再起動で消える。必須化は critical で選ぶ | 確定 |
| D11 | wait のタイムアウト | ジョブをキャンセルしない。待機だけ打ち切り、現在の状態を返す | 確定 |
| D12 | read_result の巨大結果 | 切り詰めて返す。offset/limit は将来追加 | 提案 |
| D13 | ジョブのタイムアウト | ツールの `timeoutMs` と config 上限。コアが `cancelled (by: timeout)` にする | 確定 |
| D14 | キャンセル時の部分応答 | 破棄する。保存しない | 提案 |
| D15 | API キーの保管 | 環境変数 → `secrets` マッピング。`stream()` 中のみ取得可 | 提案 |
| D16 | config の modules 形式 | 1 本の配列。文字列または `{use, config, ref}`。種別は manifest が持つ | 確定 |
| D17 | config プロンプトの上限 | 32 KiB | 提案 |
| D18 | 各イベントの payload | `src/protocol/events.ts` の zod が唯一の正。全 payload に `v:1`。本文は ID 参照。エラーは `{code,message}` | 確定 |
| D19 | イベント id の形式 | `evt_<seq>` | 提案 |
| D20 | 通知の届け方 | 次のモデル呼び出し直前に、完了順の配列を 1 メッセージで末尾追記。wait 受取分は通知しない | 確定 |
| D21 | 再起動時の running ジョブ | 実行中の正はメモリ。result-store があれば復元用メタデータを保存し、running は `interrupted`、未通知は再キュー | 確定 |
| D22 | セッションの復元 | UI の明示要求 (`session.restore`)。`restore: "none" \| "last"`、既定 `"none"`。復元してもループは再開しない | 確定 |
| D23 | 診断ログと履歴ログ | `ctx.log` はコアの stderr/ファイル。ログモジュールは権限と購読で動く (log-store ロールは廃止) | 確定 |
| D24 | 既定の履歴 | コアのメモリが唯一の正。history-store は `message.appended` を購読する投影 | 確定 |
| D25 | result-store のロール名 | 原文に無いため `result-store` を追加 | 確定 |
| D26 | ctx のシリアライズ | 将来の worker 化に備え、関数を manifest に持たせない | 提案 |
| D27 | プロバイダーの自動リトライ | 初版はなし。UI 判断 | 提案 |
| D28 | 複数プロバイダーのモデル重複 | 接頭辞の重複は起動失敗。provider が 0 でも起動失敗 | 確定 |
| D29 | 1 ターンの最大ステップ | 50 | 提案 |
| D30 | compaction の詳細 | 最小ループ後に決定。しきい値・要約方式は未定 | 未決定 |
| D31 | チーム機能 | モジュール側で別途設計 | 未決定 |
| D32 | サンドボックス | 将来。現状は宣言と承認のみ | 未決定 |
| D33 | 外部モジュール取得 | 強制機構ができるまで禁止。将来もディレクトリ形式だけ | 確定 |
| D34 | async ツールの tool.completed | ジョブの終端で発行する (同期は実行直後) | 提案 |
| D35 | 「caller id」の意味 | コアが発行するジョブ ID と解釈 | 確定 |
| D36 | manifest.json の解決 | ディレクトリ基本 (`<dir>/manifest.json`、`main` 既定 `index.js`)。ファイルは `<basename>.manifest.json`。無ければ拒否。name は manifest が正。埋め込み不可。外部はディレクトリのみ | 確定 |
| D37 | 履歴復元の権限 | 専用 `history.restore` を新設。history-store ロールのみ。`restoring` かつ履歴が空のセッションだけ | 確定 |
| D38 | 同時ジョブ上限の超過 | `too_many_jobs` で即失敗。実行中ジョブ ID を載せる。既定 8。同期ツールは数えない | 確定 |
| D39 | autoWake の既定値 | 最上位は `false`、サブエージェントは `true`。`agent.spawn` で上書き。連続自動起動は既定 10 回まで | 確定 |
| D40 | summary と通知の上限 | summary は既定 200 / 設定上限 500 文字 (コードポイント)。通知全体は既定 2000 文字。超過分は `ほか N 件` | 確定 |
| D41 | エラーコードの管理 | `src/protocol/common.ts` の `ERROR_CODES` にコア用を集約 | 提案 |
| D42 | 孤立したジョブ結果 | 再起動後に到達できない result-store の行を TTL で削除するか | 未決定 |
| D43 | セッション復元の API | コアが session-store の role API `listRestorable()` / `latestRestorable()` を呼ぶ | 提案 |
| D44 | 履歴復元の前提 | history-store は session-store を `requires` に含める | 提案 |
| D45 | tool.requested の引数 | イベントには載せない。承認は tool.before フックで扱う | 確定 |
| D46 | 復元失敗時の状態 | セッションを `error` にし、UI から再試行できる。`session.closed` は発行しない | 提案 |
| D47 | 復元時の未通知通知 | 完了済みで未通知の通知を再キューに積む | 確定 |
| D48 | 復元中の入力 | `restoring` 状態では `user.message` を拒否 | 確定 |
| D49 | 通知から溢れたジョブの ID | `ほか N 件` だけでは `read_result(id)` の ID が分からない。ID 一覧を併記するか `list_jobs` を追加する | 要確認 |
| D50 | 復元用のジョブメタデータ | result-store に `session_id` / `status` / `notified` を保存し、running は `interrupted`、未通知は再キュー | 提案 |

## 決定の要点

- **履歴**: コアのメモリが唯一の正。永続化は `message.appended` の購読による投影。復元は `ctx.history.restore` (専用権限) で、`restoring` かつ空のセッションだけ。権限検査はコアに一本化。
- **セッション復元**: UI の明示要求が基本。`restore: "last"` のときだけ起動時に自動で開く。復元してもループは再開しない。復元前のジョブは `interrupted`。
- **ロール**: provider は複数可 (接頭辞ごとに担当 1)。history-store / session-store / result-store / compactor / shell は各 1。兼任可。
- **manifest**: 別ファイル必須。ディレクトリ基本、単一ファイルは `<basename>.manifest.json`。名前は manifest の `name`。
- **イベント**: `events.ts` の zod が正。`v:1`、ID 参照、エラーは `{code,message}`。文書は生成。
- **ジョブ**: 完了は `ctx.jobs.done/fail` でちょうど 1 回。タイムアウトはコア。wait は待機のみ。通知はバッチで 1 回。上限超過は `too_many_jobs`。復元用に result-store へ最小メタデータを保存する。
- **autoWake**: 最上位は無効、サブエージェントは有効。連続自動起動に上限。
- **summary/通知**: 200/500/2000 文字の上限。超えた分は切り詰め、通知は `ほか N 件`。
- **設定/承認**: `modules` は 1 本の配列。承認はユーザー設定ディレクトリの `approvals.json`。

## 次に確認したいもの

1. **D43 / D44**: session-store の role API 名と、history-store の `requires` の扱い。
2. **D34**: async ツールの `tool.completed` をジョブ終端で発行するか。
3. **D7 / D8**: フック登録の権限と、tool.before 拒否時のイベント。
4. **D12 / D14**: read_result の offset/limit と、キャンセル時の部分応答の扱い。
5. **D49 / D50**: 通知から溢れたジョブ ID の参照方法と、復元用ジョブメタデータの保存。
6. **D30 / D42**: compaction の詳細と、孤立結果の TTL。

## 補完の原則

- 原文に書かれた語彙・イベント名・権限名は変えない。
- 原文が「未決定」としたものは、勝手に確定せず TBD のまま残す。
- 実装上都合で決めたものは、この表に追記してから実装する。
