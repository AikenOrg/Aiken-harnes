# 11. 設定

## 1. ファイル

- 既定: カレントディレクトリの `config.json`。
- 代替: `--config <path>` または環境変数 `HARNESS_CONFIG`。
- 形式: JSON (コメント不可)。zod で検証し、型違反・必須欠落は起動失敗。
- 秘密情報 (API キー) は config.json に直書きしない。環境変数を使う。
- 承認記録は config.json に置かない ([04-modules-roles-permissions.md](04-modules-roles-permissions.md) 参照)。

## 2. 全体構造

```jsonc
{
  "version": 1,
  "modules": [
    "./modules/read.js",
    { "use": "./modules/sqlite.js", "config": { "path": "./data/harness.sqlite" } },
    { "use": "./modules/shell.js", "config": {} },
    { "use": "./modules/ui-tui.js", "config": {} }
  ],
  "models": {
    "default": "anthropic/claude-sonnet-4-5"
  },
  "restore": "none",
  "shell": {
    "mode": "whitelist",
    "allow": ["git", "bun", "ls"]
  },
  "context": {
    "overflowRatio": 0.8
  },
  "jobs": {
    "defaultTimeoutMs": 300000,
    "maxTimeoutMs": 900000,
    "maxConcurrentPerSession": 8,
    "autoWake": false,
    "maxAutoWakeStreak": 10,
    "maxSummaryChars": 200,
    "maxNotificationChars": 2000,
    "resultTtlDays": 30
  },
  "log": { "level": "info", "file": "./data/harness.log" },
  "dataDir": "./data",
  "prompt": {
    "system": "あなたは... (最優先の static 断片)"
  },
  "secrets": {
    "ANTHROPIC_API_KEY": { "env": "ANTHROPIC_API_KEY" }
  }
}
```

## 3. `modules`

**種別ごとの配列ではなく、1 本の配列**にする。種別は manifest が持つため、config に重複して書かせない。

要素は次のいずれか。

- 文字列: モジュールのパス (設定なし)
- オブジェクト:
  - `use` (必須): モジュールのファイルまたはディレクトリ
  - `config` (任意): モジュール固有設定
  - `ref` (任意): 外部取得用のコミットハッシュ。現時点では未解禁

```jsonc
{
  "modules": [
    "./modules/read.js",
    { "use": "./modules/sqlite.js", "config": { "path": "./data/h.db" } },
    { "use": "user/repo", "ref": "<commit>" }
  ]
}
```

- パスは相対 (config.json のディレクトリ基準) または絶対。
- 同じモジュールの重複ロードは起動失敗。
- `use: "user/repo"` 形式の外部取得は、強制機構ができるまで**エラー**にする。将来もディレクトリ形式だけを許可する。

### 3.1 ロード順

1. manifest の `requires` から依存グラフを作る。
2. トポロジカルソートで順番を決める。
3. 同順位のときだけ配列の順番を使う。
4. 循環依存は起動失敗。

### 3.2 manifest の場所

manifest はコードとは別のファイルに置く。コードへの埋め込みは認めない。

| `use` の指す先 | manifest の場所 | エントリ |
|---|---|---|
| ディレクトリ (基本) | `<dir>/manifest.json` | `main` (既定 `index.js`) |
| ファイル (補助) | 同じ場所の `<basename>.manifest.json` (例: `read.js` → `read.manifest.json`) | そのファイル |

- どちらも見つからなければロードを拒否する。
- モジュール名はファイル名ではなく manifest の `name`。重複は起動時エラー。
- 外部取得 (将来) はディレクトリ形式だけ。

### 3.3 モジュール設定

- `config` はそのままモジュールの `init` に渡される。検証はモジュールが行う (zod 推奨)。
- コアは `config` の内容を解釈しない。
- ただし `shell` と `jobs` はコアが解釈する横断設定。

`store-sqlite` の設定:

```jsonc
{
  "use": "./modules/store-sqlite",
  "config": {
    "path": "~/.local/share/next-harness/harness.sqlite",
    "ttlDays": 30,
    "cleanupIntervalMs": 21600000,
    "batchMs": 50,
    "batchSize": 100
  }
}
```

- `path` 省略時はユーザーデータディレクトリの `next-harness/harness.sqlite`。
- `ttlDays` / `cleanupIntervalMs` は結果の TTL 掃除。

## 4. `models`

```json
{
  "default": "opencode-go/glm-5.3-flash",
  "opencode-go/glm-5.3-flash": { "reasoning": { "effort": "high" } }
}
```

- `default` 以外のキーはモデル ID。`reasoning` で既定の強度・budget を指定する。
- セッション上書きと `agent.spawn({reasoning})` が優先される。

| キー | 型 | 内容 |
|---|---|---|
| `default` | string | 既定モデル。`<prefix>/<model>` 形式 |

- モデルの実体は provider が `models()` で申告する。
- 接頭辞ごとに担当プロバイダーは 1 つ。重複は起動失敗。
- セッション単位のモデル変更は `ctx.session.setModel`。

## 5. `shell`

`shell` ロールのモジュールに対する横断設定。コアが解釈する。

| キー | 型 | 内容 |
|---|---|---|
| `mode` | `"full" \| "whitelist"` | 実行モード |
| `allow` | string[] | ホワイトリスト。`mode: "whitelist"` のとき使う |

- 判定と個別承認は `tool.before` フックで行う。
- シェルのパースによる防御には限界がある。サンドボックス導入までの暫定措置。

## 6. `jobs`

| キー | 既定 | 内容 |
|---|---|---|
| `defaultTimeoutMs` | `300000` | async ツールの既定タイムアウト |
| `maxTimeoutMs` | `900000` | ツールが宣言できる上限 |
| `maxConcurrentPerSession` | `8` | セッションあたりの同時 async ジョブ数。同期ツールは数えない |
| `autoWake` | `false` | 最上位セッションの autoWake 既定。サブエージェントは `true` |
| `maxAutoWakeStreak` | `10` | 連続して自動で起こす回数の上限 |
| `maxSummaryChars` | `200` | summary の上限。設定できる最大は 500 |
| `maxNotificationChars` | `2000` | 1 回の通知メッセージ全体の上限 |
| `resultTtlDays` | `30` | 終端かつ通知済みの結果を掃除するまでの日数 |

- ツールの `timeoutMs` が `maxTimeoutMs` を超える場合は切り詰める。
- 同時実行数を超えた新規 async ジョブは `too_many_jobs` で即座に失敗させる。エラーに実行中のジョブ ID を載せる。
- `summary` はコードポイント数で切り詰め、切り詰めた印を付ける。`size` は元のサイズを保持する。
- 通知全体が `maxNotificationChars` を超えたら、超えた分を `ほか N 件: id1, id2, ...` (最大 20 件) に置き換える。AI は `read_result(id)` か `list_jobs` で取得する。
- `autoWake` はセッション単位で上書きできる (`agent.spawn` の引数)。

## 6.1 `agents`

| キー | 既定 | 内容 |
|---|---|---|
| `maxDepth` | `3` | 親からの深さ |
| `maxChildren` | `8` | 1 セッションの子の数 |
| `maxAgents` | `16` | 全体のエージェント数 |
| `maxPromptBytes` | `8192` | spawn 時の prompt+volatile の上限 |
| `maxConcurrentModelCalls` | `4` | モデル呼び出し全体の同時数 |

- 上限超過は `max_depth_exceeded` / `too_many_children` / `too_many_agents` で即失敗。
- 閉じたセッションは数えない。

## 6.2 `images`

| キー | 既定 | 内容 |
|---|---|---|
| `maxBytes` | 4 MiB | 1 枚のデコード後サイズ |
| `maxCount` | 4 | 1 メッセージの枚数 |
| `maxTotalBytes` | 8 MiB | 1 メッセージの合計デコード後サイズ |

- MIME は `image/*`、base64 は canonical のみ。
- モデルの `supportsImages` / `imageMediaTypes` と一致しない場合は拒否する。

## 7. `context`

| キー | 既定 | 内容 |
|---|---|---|
| `overflowRatio` | `0.8` | `lastInputTokens + maxTokens > ratio * contextWindow` なら compaction を試みる |
| `maxOutputContinuations` | `2` | 出力トークン上限 (length) で自動継続する回数 |

- `maxOutputContinuations` を使い切るまで、`length` のたびに継続用の system メッセージを追加して同じターンを続ける。
- compactor が無い場合は履歴を切り捨てず、`turn.ended (reason: "context_overflow")` で止める。
- プロバイダーがコンテキスト長超過を返した場合も同じ扱い。
- 値は 0 より大きく 1 以下。

## 8. `restore`

起動時の復元方針。

| 値 | 挙動 |
|---|---|
| `"none"` (既定) | 何もしない。UI が `session.listRestorable()` → `session.restore(id)` で明示的に開く |
| `"last"` | 直前のセッションを自動で開く。ターンループは再開しない |

- 自動復元でも、ユーザー入力か保留中の通知による autoWake までモデルは呼ばない。
- 復元前に動いていたジョブは `failed (code: "interrupted")`。完了済みで未通知の通知は再キューに積む。
- 復元失敗時はセッションを `error` にし、UI に通知する。

## 9. `log` / `dataDir` / `prompt` / `secrets`

| キー | 内容 |
|---|---|
| `log.level` | `debug` / `info` / `warn` / `error` (既定 `info`) |
| `log.file` | 未指定なら stderr |
| `allowApproveAll` | 開発用 `--approve-all` を許可するか。本番は `false` (省略時 true) |
| `dataDir` | モジュールが使う既定ディレクトリ (既定 `./data`) |
| `prompt.system` | config 由来の static 断片。常に static ブロックの先頭 |
| `secrets.<name>.env` | 秘密情報を読む環境変数名 |

- `prompt.system` はモジュールから削除・上書きできない。長さ上限は 32 KiB (**TBD**)。
- 秘密情報は `ctx.secrets.get(name)` で解決する。プロバイダーの `stream()` 中のみ取得できる。
- CLI は起動時に `~/.config/next-harness/.env` (Windows は `%APPDATA%\next-harness\.env`) を読み、未設定の環境変数だけを補う。プロジェクト内の `.env` は使わない。
- 未設定の秘密情報を要求した場合は利用時に例外。

## 9.1 `ui-web`

`ui-web` モジュールの config。

| キー | 既定 | 内容 |
|---|---|---|
| `host` | `127.0.0.1` | bind 先。`0.0.0.0` は警告付きで許可するが、Origin/Host は loopback 固定 |
| `port` | `8787` | HTTP/WS のポート。`0` は OS 任せ（テスト用） |
| `seedColor` | `#6750A4` | M3 のシード色（`#RRGGBB`） |
| `approvalTimeoutMs` | `300000` | 承認待ちのタイムアウト。超過は拒否 |
| `historyLimit` | `200` | snapshot で返す履歴の件数 |

安全要件とプロトコルは [15-web-ui.md](15-web-ui.md) を参照。

## 10. 承認記録

- 保存先はユーザーの設定ディレクトリの `approvals.json`。プロジェクトの config とは分ける。
- 詳細は [04-modules-roles-permissions.md](04-modules-roles-permissions.md) の 4.2 を参照。

## 11. 環境変数

| 変数 | 内容 |
|---|---|
| `HARNESS_CONFIG` | config.json のパス |
| `HARNESS_LOG_LEVEL` | 診断ログのレベル上書き |
| `HARNESS_DATA_DIR` | dataDir の上書き |
| `HARNESS_ENV_FILE` | 秘密情報の .env パス上書き |
| `XDG_CONFIG_HOME` | Linux の承認記録の基準ディレクトリ |
| `APPDATA` | Windows の承認記録の基準ディレクトリ |

優先順位: CLI 引数 > 環境変数 > config.json > 既定値。

## 12. 検証

- 未知のキーは警告にとどめる (前方互換のため)。
- 型違反・必須欠落は起動失敗。キーのパス付きで表示する (`modules[1].config.path`)。
- 設定のホットリロードはしない。変更は再起動で反映する。
- `src/protocol/config.ts` の `configSchema` が正。
