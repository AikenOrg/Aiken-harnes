# 04. モジュール・ロール・権限

## 1. manifest

manifest はコードとは別の `manifest.json` に置く。コアはモジュールのコードを実行する前に manifest を読み、権限を提示して承認を得る。

```jsonc
{
  "name": "sqlite",
  "version": "0.1.0",
  "main": "index.js",
  "roles": ["history-store", "session-store", "result-store"],
  "critical": true,
  "runner": "inprocess",
  "talksTo": ["ui-web"],
  "subscribes": ["message.appended", "history.rewritten"],
  "permissions": [
    { "cap": "history.read" },
    { "cap": "history.append" },
    { "cap": "fs.write", "paths": ["./data"] }
  ],
  "tools": [{ "name": "search_log", "mode": "sync" }]
}
```

### 1.1 フィールド

| フィールド | 必須 | 内容 |
|---|---|---|
| `name` | ✓ | 一意な名前。`module.talk:<name>` の宛先になる |
| `version` | ✓ | SemVer |
| `main` | — | モジュールディレクトリからのエントリポイント。既定 `index.js` |
| `roles` | ✓ | 要求するロール。複数可 |
| `critical` | ✓ | `true` なら障害時に即停止 |
| `runner` | ✓ | 今は `"inprocess"` のみ |
| `requires` | — | 依存するロール名またはモジュール名 |
| `talksTo` | — | 呼び出してよい相手。宣言外への `ctx.modules.call` は拒否 |
| `subscribes` | — | 購読するイベント型。`tool.*` のようなワイルドカード可 |
| `permissions` | — | 要求する権限 |
| `tools` | — | 提供するツール。`name` / `mode` / `timeoutMs?` |

### 1.2 manifest の解決

`config.json` の `use` はモジュールのディレクトリまたはファイルを指す。

| `use` の指す先 | manifest の場所 | エントリ |
|---|---|---|
| ディレクトリ (基本) | `<dir>/manifest.json` | `main` (既定 `index.js`) |
| ファイル (補助) | 同じ場所の `<basename>.manifest.json` (例: `read.js` → `read.manifest.json`) | そのファイル |

- どちらも見つからなければ**ロードを拒否**する。権限の宣言なしにコードを動かさない。
- モジュール名はファイル名ではなく manifest の `name` で決める。重複は起動時エラー。
- コードの中に manifest を埋め込む形は認めない。コード実行前に権限を読む必要があるため。
- 外部取得 (将来) はディレクトリ形式だけにする。
- manifest が不正なモジュールはロードしない。`critical` なら起動中止。

### 1.3 ロード順

1. `requires` の依存グラフをトポロジカルソートする。
2. 同順位のときだけ `modules` 配列の順番を使う。
3. 循環依存は起動失敗。

## 2. ロール

| ロール | 数 | 補足 |
|---|---|---|
| `provider` | 複数可 | モデル ID の接頭辞ごとに担当が 1 つ。最低 1 つ必須 |
| `history-store` | 1 | 履歴の永続化 |
| `session-store` | 1 | セッション情報の永続化と復元 |
| `result-store` | 1 | 非同期ジョブの結果と復元用メタデータの保存 (`read_result` の裏側) |
| `compactor` | 1 | 履歴の書き換え |
| `shell` | 1 | `exec` 権限を持てる唯一のロール |
| `ui` | 複数可 | user.message / user.cancel の発行とイベント表示。ユーザー操作として任意のセッションを close できる |

- 1 つのモジュールが複数ロールを兼ねてよい。SQLite モジュールは `history-store` / `session-store` / `result-store` を兼ねる想定。
- 同じ排他ロールを 2 つ以上のモジュールが要求したら**起動時にエラー**。
- 排他ロール: `history-store` / `session-store` / `result-store` / `compactor` / `shell`。
- ロールを持たないモジュール (ログ収集など) も許可する。権限と購読だけで動く。

### 2.1 provider

- モデル ID は `"<prefix>/<model>"` 形式。`<prefix>` は最初の `/` より前。
- 同じ接頭辞を複数のプロバイダーが申告したら起動失敗。接頭辞ごとに担当は 1 つ。
- モデル選択は接頭辞でプロバイダーを決める。
- 最低 1 つの provider が必要。無ければ起動失敗。

### 2.2 shell

- `shell` ロールは 1 モジュールのみ。
- `exec` を要求できるのは `shell` ロールを持つモジュールだけ。それ以外が要求したらロード拒否。
- モードは `full` / `whitelist`。ホワイトリスト判定と承認は `tool.before` フックで行い、そのモジュールは `tool.intercept` を要求する。

### 2.3 history-store

- 実行中の履歴の正はコアのメモリ。history-store は `message.appended` を購読して書き出す投影 (projection)。
- 復元時は `ctx.history.restore(sessionId, messages)` でコアへ戻す。`history.restore` 権限が必要。
- コアが単体で起動できるため、history-store は必須ではない。永続化が必要な構成で追加する。
- 復元を行う場合、history-store は session-store を `requires` に入れる (D44)。session-store が `restoring` でセッションを作り、history-store が履歴を入れる。

### 2.4 compactor

- `history.rewrite` を持てる唯一のロール。
- 書き換えはコアの `ctx.history.rewrite` を通す。コアがメモリを更新し、`history.rewritten` を発行する。

### 2.5 result-store

- 非同期ジョブの結果本体を保存する。
- result-store が無い場合、コアはメモリに結果を持つ。再起動で消える。
- 必須扱いにするかは、そのモジュールの `critical` で選ぶ。

## 3. 権限 (capability)

### 3.1 コア API 系 (実効強制あり)

| 権限 | 許可される操作 | 主な保持ロール |
|---|---|---|
| `history.read` | `ctx.history.read` / `get` / 購読 | history-store, compactor, 監視用途 |
| `history.append` | `ctx.history.append` / `appendBatch` | history-store, ツール |
| `history.restore` | `ctx.history.restore` | `history-store` のみ |
| `history.rewrite` | `ctx.history.rewrite` | compactor のみ |
| `prompt.contribute` | `ctx.prompt.contribute` | 任意 (承認制) |
| `session.manage` | `ctx.session.*` | ui, agent 系。`close` は ui ロールなら任意、それ以外は自分のセッションと子孫 |
| `session.delete` | `ctx.session.delete` | ui ロールのみ。対象は `closed` のみ |
| `agent.spawn` | `ctx.agent.spawn` | 任意 |
| `agent.message` | `ctx.agent.message` | 任意 |
| `tool.register` | `ctx.tools.register` | ツール提供モジュール |
| `tool.intercept` | `tool.before` フックの登録 | shell の承認など |
| `module.talk:<name>` | `ctx.modules.call(name, ...)` | `talksTo` に含む相手 |

- `ctx` は呼び出しのたびに権限を検査する。未承認なら `permission.denied` を発行し、例外を返す。
- 履歴の権限検査はコアに一本化する。履歴モジュールは保存先であって、権限の番人ではない。
- `ctx.history.restore` は `history.restore` 権限と `history-store` ロールの両方を必要とする。状態が `restoring` で履歴が空のセッションにだけ実行できる (D37)。
- `ctx.agent.close` は `agent.spawn` を必要とし、自分の子孫だけを対象にする (D52)。
- `ctx.session.close` は `session.manage`。ui ロールはユーザー操作として任意のセッションを close できる。
- `ctx.session.delete` は専用の `session.delete` 権限を必要とし、`closed` のセッションだけを削除できる。ui ロールだけが任意の closed を削除できる。AI のツールやサブエージェントには付与しない。`session.deleted` を発行する。

### 3.2 外部資源系 (宣言と承認のみ)

| 権限 | 引数 | 現状 |
|---|---|---|
| `fs.read` | `paths` | 宣言・承認のみ。強制なし |
| `fs.write` | `paths` | 同上 |
| `net` | `hosts` | 同上 |
| `env` | `names` | 同上 |
| `exec` | `mode`, `allow` | `shell` ロール限定。強制なし |
| `secrets.read` | `names` | `provider` 限定。`stream()` 中のみ取得可 |

> 実効的なサンドボックスは未実装。承認画面と監査イベントには「未強制」であることを明示する。

## 4. 承認

### 4.1 提示内容

- モジュール名 / バージョン / 取得元
- 要求ロールと排他チェック結果
- 要求権限の一覧 (引数付き)
- `critical` の有無
- 重い権限 (`tool.intercept`、`exec`、`history.rewrite` など) の明示
- 危険な組み合わせの警告
- 「fs / net / env / exec はまだ強制されない」旨

### 4.2 保存先

承認記録は config.json とは別のファイルに置く。

| OS | 既定パス |
|---|---|
| Linux | `$XDG_CONFIG_HOME/next-harness/approvals.json` (未設定なら `~/.config/next-harness/approvals.json`) |
| Windows | `%APPDATA%\next-harness\approvals.json` |

- **プロジェクトの config とは分ける。** config を共有したり、AI がモジュールと一緒に config を書き換えたりしても、承認が付いてこないようにするため。
- SQLite などのモジュール側ストアには置かない。権限の記録をモジュールに預けると循環する。コア自身が管理する。
- 記録は「モジュール名 + コードの内容ハッシュ + 承認した権限のハッシュ」。
- コードまたは権限が変わったら再承認。
- 注意: fs の強制がない間は、モジュールが自分で `approvals.json` を書き換えられる。現段階では改ざん防止ではなく、承認の記録と変更検知として位置づける。

### 4.3 危険な組み合わせ (警告)

次の組み合わせは承認時に警告する。拒否はしない (ユーザー判断)。

- `history.read` + `net` (会話の外部送信)
- `history.read` + `exec` (会話を読む任意コード)
- `secrets.read` + `net` (鍵の外部送信)
- `fs.write` + `net`
- `env` + `net`
- `exec` (フルアクセス) + `history.rewrite`
- `tool.intercept` + `history.read` (全ツールの引数と会話の同時観測)

## 5. モジュール間通信

- 呼び出し側は `talksTo` に宛先名を列挙する。
- 呼び出しには `module.talk:<name>` 権限が必要。
- `ctx.modules.call(name, method, args)` は、呼び出し側の宣言と呼び出し先の存在を検査する。
- 呼び出し先は自身の `ctx` で受け取り、必要なら権限を再検査する。**権限は委譲されない**。
- 同期呼び出しのみ。長時間処理はジョブとして非同期化する。
- 循環呼び出しは呼び出し深さ上限で検出する。

## 6. 外部取得の扱い

- `user/repository` 形式の外部モジュール取得は、強制機構ができるまで**解禁しない**。ローカルのみ。
- 解禁時の要件:
  1. コミットハッシュ固定 (`ref`)
  2. 導入時の権限承認
  3. 権限が増える更新での再承認
  4. インストールスクリプトの禁止

## 7. runner

- 現状は `inprocess` のみ。モジュールは同一プロセスで動く。
- 将来の `worker` / `process` 追加を見据え、`ctx` はシリアライズ可能な境界を意識する (関数を manifest に持たせない)。

## 8. critical

- 真偽値のみ。将来レベル化できるよう union で包む。
- `true` のモジュールが初期化・実行中に落ちた場合:
  - `module.failed` を発行
  - 実行中ターンを中断
  - そのモジュールの実行中ジョブを `failed (code: "module_died")`
  - `core.stopping` を発行してプロセスを終了 (終了コード非 0)
- プロバイダーのストリーム中死亡も同じ扱い。
- `result-store` が無い場合はメモリで動く。モジュールがあり `critical: true` なら、その障害で停止する。
