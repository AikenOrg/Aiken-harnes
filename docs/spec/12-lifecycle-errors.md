# 12. ライフサイクルと障害

## 1. 起動

```text
config 読込 -> core 初期化 -> manifest 読込 -> ロール排他検査 -> 権限承認
-> module.init -> core.started -> 入力受付
   (restore: "last" のときだけ session 復元 -> history 復元)
```

- 既定では起動時にセッションを復元しない (`restore: "none"`)。UI が明示的に `session.restore(id)` を要求する。
- 復元中のセッションは `restoring` 状態で、`user.message` を受け付けない。
- 各段階の失敗は起動失敗として扱い、終了コード 1 で終了する。ただし「無効化して続行」の対象は 2 節の表に従う。
- 起動途中で失敗した場合、それまでに初期化したモジュールの `dispose` を逆順に呼ぶ。

## 2. モジュール障害の扱い

| 状況 | `critical: true` | `critical: false` |
|---|---|---|
| manifest 不正 | 起動中止 | `module.failed` → `module.disabled` |
| `init` 失敗 | 起動中止 | `module.failed` → `module.disabled` |
| 依存 (`requires`) 不足 | 起動中止 | `module.disabled` |
| 実行中の例外 (ツール) | ターン失敗 → 停止 | そのツールだけ失敗 |
| 実行中の例外 (イベント購読) | 停止 | 購読解除して続行 |
| プロバイダーのストリーム断 | 停止 | `model.failed` を発行してターン失敗 |

- `module.disabled` になったモジュールのツールは登録解除し、プロンプト断片も除去する。
- そのモジュールを `requires` に持つモジュールは連鎖的に無効化する。
- 無効化はイベントで通知する。UI は「機能が欠けた状態」を表示する。

## 3. モジュール死亡時のジョブ

- モジュールが落ちたら、そのモジュールが実行していたジョブをすべて `failed (code: "module_died")` にする。
- `job.failed` を発行し、通知キューに積む。
- コアが停止する場合は、全ジョブを `cancelled (by: "system")` にする。

## 3.1 セッション復元時のジョブ

- result-store がある場合、復元前に動いていたジョブは `failed (code: "interrupted")` として扱う。
- 完了済みで未通知だった通知は再キューに積み、次のモデル呼び出し直前に届ける。
- result-store が無い場合、ジョブ状態も通知状態も復元できない (メモリのみ)。
- 親セッションを閉じたら子孫も再帰的に閉じる。`agent.close` も同じく子孫を閉じる。
- 復元してもターンループは自動で再開しない。ユーザー入力か、保留中の通知による autoWake を待つ。
- 復元に失敗したらセッションを `error` にし、`session.closed` は発行しない。UI から再試行できる。
- 保存モデルのプロバイダーが無い場合も `error` にし、モデル ID を理由として返す。
- 結果の欠けた末尾 tool_call は `interrupted by restart` の tool_result で補う。

## 3.2 画像入力の拒否

- `invalid_image`: モデル非対応、未対応 MIME、base64 不正。
- `image_too_large`: 1 枚または合計のサイズ超過。
- `too_many_images`: 枚数超過。
- これらは `session.send` の呼び出し元へ返し、ターンは開始しない。

## 4. critical の範囲

- 真偽値のみ。将来のレベル化に備え、内部型は `boolean | "required" | ...` に拡張可能な形にする。
- provider は必須。最低 1 つロードできなければ起動失敗。
- history-store / session-store / result-store は必須ではない。
  - 履歴の正はコアのメモリ。永続化が不要ならロードしない。
  - 結果は result-store が無ければコアのメモリに置く。再起動で消える。
- SQLite モジュールを `critical: true` にした場合、その障害で即停止する。`false` なら永続化だけ失って続行する。

## 5. ターンの失敗

| 失敗 | 挙動 |
|---|---|
| モデル呼び出し失敗 | `model.failed` → `turn.ended` (`error`)。セッションは `idle` に戻す |
| ツールの引数不正 | ツールを実行せず `tool_result` (`isError`) を返す。ターン継続 |
| 同期ツールの例外 | エラーを `tool_result` として返す。ターン継続 |
| 非同期ジョブの失敗 | `job.failed`。ターンは継続し、通知で伝える |
| 履歴の永続化失敗 | コアのメモリは正なのでターンは継続。永続化だけ失われる |
| ターン内ステップ上限超過 | `turn.ended` (`error`)。理由をモデル/UI に通知 |
| コンテキスト上限接近 (compactor 不在) | `turn.ended` (`context_overflow`)。履歴は切り捨てない |
| プロバイダーがコンテキスト長超過を返す | 同じ `context_overflow` として扱う |

## 6. 停止

1. `core.stopping` を発行する。
2. 新規入力を拒否する。
3. 実行中ターンへ AbortSignal を渡す。
4. 実行中ジョブを `by: "system"` でキャンセルする。
5. モジュールの `dispose` を逆順に呼ぶ (タイムアウト付き)。
6. SQLite はキューを drain してから close する。
7. 終了コード 0 で終了する。強制終了時は 1。

- 履歴は追記のたびに `message.appended` を発行しているため、特別な flush は不要。
- `SIGINT` / `SIGTERM` を捕捉する。Windows では `SIGTERM` が来ない場合があるため、`SIGINT` と標準入力の EOF も扱う。
- 二重の停止要求は無視する (1 回目の猶予を待つ)。
- 停止タイムアウトを超えたら強制終了する。

## 7. 終了コード

| コード | 意味 |
|---|---|
| 0 | 正常停止 |
| 1 | 起動失敗・設定不正 |
| 2 | critical モジュールの障害 |
| 3 | 停止タイムアウトによる強制終了 |

## 8. 監査

- 権限の付与・拒否・違反は必ずイベントとして発行する。
- 秘密情報の取得は「誰が・いつ・どの名前を」記録する。値は記録しない。
- モジュールのロード・無効化も記録する。
- 監査ログの保存は任意モジュールの機能。コアはイベントを発行するだけ。
