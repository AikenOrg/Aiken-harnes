# 04. モジュール・ロール・権限

## 1. manifest

```jsonc
{
  "name": "log-sqlite",              // 一意。モジュール間通信の宛先名
  "version": "0.1.0",
  "roles": ["history-store"],        // 役割。排他検査の対象
  "critical": true,                  // 落ちたら停止するか (今は真偽値のみ)
  "runner": "inprocess",             // 現在は inprocess のみ
  "requires": ["session-store"],     // 依存するロール (またはモジュール名)
  "talksTo": ["ui-web"],             // 呼び出してよい相手 (事前宣言)
  "subscribes": ["message.appended", "tool.*"],
  "permissions": [
    { "cap": "history.read" },
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
| `roles` | ✓ | 要求するロール。複数可 |
| `critical` | ✓ | `true` なら障害時に即停止 |
| `runner` | ✓ | 今は `"inprocess"` のみ。それ以外はロード拒否 |
| `requires` | — | 依存するロール名またはモジュール名。満たせなければ失敗 |
| `talksTo` | — | 呼び出し先のモジュール名。宣言外への `ctx.modules.call` は拒否 |
| `subscribes` | — | 購読するイベント型。`tool.*` のようなワイルドカード可 |
| `permissions` | — | 要求する権限。cap ごとに引数を持つ |
| `tools` | — | 提供するツール。`mode` は `sync` / `async` |
| `config` | — | モジュール固有設定 (config.json 側から注入される) |

> `config` は manifest ではなく config.json のモジュールエントリに書く運用とする。manifest は配布物の性質、config は設置者の設定を表す。

### 1.2 検証

- 未知のフィールドは警告、未知の権限はロード拒否。
- `critical: true` は必須ロール (history-store / provider / SQLite) に限らず指定できる。
- manifest は起動時に一度だけ検証し、結果を `module.loaded` に載せる。

## 2. ロール

### 2.1 排他ロール

同時に 1 モジュールだけが持てる。重複したら起動失敗。

| ロール | 責務 | 必須 |
|---|---|---|
| `history-store` | メッセージ履歴の保存・読み出し | ✓ (既定はメモリ) |
| `session-store` | セッションの永続化・復元 | — |
| `compactor` | 履歴の書き換え (`history.rewrite` の唯一の保持者) | — |
| `log-store` | 履歴ログの永続化 | — |

### 2.2 非排他の基本ロール

| ロール | 責務 | 特権 |
|---|---|---|
| `provider` | モデル呼び出し (`Provider` 実装) | `secrets.read` |
| `shell` | シェル実行ツール | `exec` |
| `tools` | 一般ツール | — |
| `ui` | ユーザー入力とイベント表示 | — |
| `observer` | 読み取り専用の監視 (ログなど) | `history.read` |

- プロバイダーは複数ロードできる (モデル選択のため)。どのプロバイダーがどのモデルを持つかは `models()` で申告する。
- `shell` ロールを持たないモジュールは `exec` を要求できない。要求した場合はロード拒否。
- `history.rewrite` は `compactor` ロールのみ。他ロールが要求したら拒否。
- `history.read` は observer を含め複数可 (読み取り専用)。

## 3. 権限 (capability)

### 3.1 コア API 系 (実効強制あり)

| 権限 | 許可される操作 | 主な保持ロール |
|---|---|---|
| `history.read` | `ctx.history.read` / 購読 | history-store, observer |
| `history.append` | `ctx.history.append` | history-store, ツール |
| `history.rewrite` | `ctx.history.rewrite` | compactor のみ |
| `prompt.contribute` | `ctx.prompt.contribute` | 任意 (承認制) |
| `session.manage` | `ctx.session.*` (create/fork/close) | ui, agent 系 |
| `agent.spawn` | `ctx.agent.spawn` | 任意 |
| `agent.message` | `ctx.agent.message` | 任意 |
| `tool.register` | `ctx.tools.register` | tools |
| `module.talk:<name>` | `ctx.modules.call(name, ...)` | `talksTo` に含む相手 |

- `ctx` は呼び出しのたびに権限を検査する。未承認なら `permission.denied` を発行し、例外を返す。
- 権限の検査はモジュール名とセッションの両方で行う (サブエージェントの代理操作を制限するため)。

### 3.2 外部資源系 (宣言と承認のみ)

| 権限 | 引数 | 現状 |
|---|---|---|
| `fs.read` | `paths` | 宣言・承認のみ。強制なし |
| `fs.write` | `paths` | 同上 |
| `net` | `hosts` | 同上 |
| `env` | `names` | 同上 |
| `exec` | `mode`, `allow` | 宣言・承認のみ。`shell` ロール限定 |
| `secrets.read` | `names` | 宣言・承認のみ。`provider` 限定 |

> 実効的なサンドボックスは未実装。承認画面と監査イベントには「未強制」であることを明示する。

### 3.3 exec のモード

```jsonc
{ "cap": "exec", "mode": "whitelist", "allow": ["git", "bun", "ls"] }
```

- `full`: すべてのコマンドを許可。
- `whitelist`: `allow` に列挙した実行ファイルのみ許可。
- ホワイトリスト判定と個別承認は `tool.before` フックで行う。
- シェルのパースによる防御には限界がある。これは既知の受容リスクであり、サンドボックス導入までの暫定措置とする。

## 4. 承認

### 4.1 提示内容

承認画面には次を出す。

- モジュール名 / バージョン / 取得元 (現状はローカルパスのみ)
- 要求ロールと排他チェック結果
- 要求権限の一覧 (引数付き)
- `critical` の有無
- 危険な組み合わせの警告
- 「fs / net / env / exec はまだ強制されない」旨

### 4.2 承認の単位と再承認

- 承認はモジュール単位。付与結果はコアが保持し、`permission.granted` を発行する。
- バージョン更新で権限が増えた場合は再承認を要求する。同権限の範囲なら自動継続 (設定で厳格化可能)。
- 承認記録の保存先 (config.json / 専用ファイル / SQLite) は **TBD**。実装時は「モジュールの内容ハッシュに紐づける」方式を推奨する。

### 4.3 危険な組み合わせ (警告)

次の組み合わせは承認時に警告する。拒否はしない (ユーザー判断)。

- `history.read` + `net` (会話の外部送信)
- `history.read` + `exec` (会話を読む任意コード)
- `secrets.read` + `net` (鍵の外部送信)
- `fs.write` + `net` (書き込みと外部通信の併用)
- `env` + `net`
- `exec` (フルアクセス) + `history.rewrite`

## 5. モジュール間通信

- 呼び出し側は manifest の `talksTo` に宛先名を列挙する。
- 呼び出しには `module.talk:<name>` 権限が必要。承認時にまとめて付与する。
- `ctx.modules.call(name, method, args)` は、呼び出し側の宣言と呼び出し先の存在を検査する。
- 呼び出し先は自身の `ctx` で受け取り、必要なら権限を再検査する。**権限は委譲されない** (呼び出し元の権限で代理実行しない)。
- 同期呼び出しのみ。長時間処理はジョブとして非同期化する。
- 循環呼び出しは呼び出し深さ上限で検出する。

## 6. 外部取得の扱い

- `user/repository` 形式の外部モジュール取得は、強制機構ができるまで**解禁しない**。ローカルのファイルのみロード可。
- 解禁時の要件 (将来):
  1. コミットハッシュ固定
  2. 導入時の権限承認
  3. 権限が増える更新での再承認
  4. インストールスクリプトの禁止 (コードはロード時に検証)

## 7. runner

- 現状は `inprocess` のみ。モジュールは同一プロセスで動く。
- 将来の `worker` / `process` 追加を見据え、`ctx` はシリアライズ可能な境界を意識して設計する (関数を manifest に持たせない)。

## 8. critical

- 真偽値のみ。将来 `"required" | "important" | "optional"` などのレベルへ拡張できるよう、型は union で包む。
- `true` のモジュールが初期化・実行中に落ちた場合:
  - `module.failed` を発行
  - 実行中ターンを中断
  - `core.stopping` を発行してプロセスを終了 (終了コード非 0)
- プロバイダーのストリーム中死亡も同じ扱い。
