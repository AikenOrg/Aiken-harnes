# 14. 決定・補完・要確認事項

2026-11-07 のユーザー決定を反映済み。**確定**は原文またはユーザー判断、**提案**は本書で暫定採用した内容、**未決定**は TBD。

| ID | 論点 | 本書の扱い | 状態 |
|---|---|---|---|
| D1 | プロンプト断片の順序 | static → session → volatile。static 内は config → core → module、priority 降順 | 提案 |
| D2 | セッション状態 | `active / idle / closed / error` の 4 状態 | 提案 |
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
| D21 | 再起動時の running ジョブ | ジョブ状態は永続化しない。running は復元されない | 確定 |
| D22 | セッションの自動復元 | 起動時に自動復元するか、UI の明示要求にするか | 未決定 |
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
| D33 | 外部モジュール取得 | 強制機構ができるまで禁止 | 確定 |
| D34 | async ツールの tool.completed | ジョブの終端で発行する (同期は実行直後) | 提案 |
| D35 | 「caller id」の意味 | コアが発行するジョブ ID と解釈 | 確定 |
| D36 | manifest.json の解決規則 | `use` がディレクトリなら `<dir>/manifest.json`、ファイルなら `<basename>.manifest.json` → 同ディレクトリの manifest.json | 要確認 |
| D37 | ctx.history.load の権限 | `history.append` + `history-store` ロール。復元時のみ | 要確認 |
| D38 | 同時ジョブ上限を超えた場合 | 実行せず `job_limit_exceeded` で失敗させる | 要確認 |
| D39 | autoWake の既定値 | `false` (次のユーザー入力を待つ) | 提案 |
| D40 | summary の上限 | 200 文字。超えたらコアが切り詰める | 提案 |
| D41 | エラーコードの管理 | `src/protocol/common.ts` の `ERROR_CODES` にコア用を集約 | 提案 |
| D42 | 孤立したジョブ結果 | 再起動後に到達できない result-store の行を TTL で削除するか | 未決定 |
| D43 | セッション復元の API | コアが session-store の role API `loadSessions()` を呼ぶ | 提案 |
| D44 | 履歴復元の前提 | history-store は session-store を `requires` に含める | 提案 |
| D45 | tool.requested の引数 | イベントには載せない。承認は tool.before フックで扱う | 確定 |

## 決定の要点

- **履歴**: コアのメモリが唯一の正。永続化は `message.appended` の購読による投影。復元は `ctx.history.load`。権限検査はコアに一本化。
- **ロール**: provider は複数可 (接頭辞ごとに担当 1)。history-store / session-store / result-store / compactor / shell は各 1。兼任可。
- **イベント**: `events.ts` の zod が正。`v:1`、ID 参照、エラーは `{code,message}`。文書は生成。
- **ジョブ**: 完了は `ctx.jobs.done/fail` でちょうど 1 回。タイムアウトはコア。wait は待機のみ。通知はバッチで1回。
- **設定**: `modules` は 1 本の配列。manifest は別ファイル。承認は `approvals.json`。

## 次に確認したいもの

1. **D36**: manifest.json の場所 (ディレクトリ運用か、`<file>.manifest.json` か)。
2. **D37**: `ctx.history.load` の権限を `history.append` + ロールでよいか。
3. **D38**: 同時ジョブ上限超過を失敗にするか、キューに積むか。
4. **D39 / D40**: autoWake の既定値と summary の上限。
5. **D22**: セッション復元のタイミング (自動か明示か)。

## 補完の原則

- 原文に書かれた語彙・イベント名・権限名は変えない。
- 原文が「未決定」としたものは、勝手に確定せず TBD のまま残す。
- 実装上都合で決めたものは、この表に追記してから実装する。
