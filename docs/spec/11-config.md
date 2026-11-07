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
  "shell": {
    "mode": "whitelist",
    "allow": ["git", "bun", "ls"]
  },
  "jobs": {
    "defaultTimeoutMs": 300000,
    "maxTimeoutMs": 900000,
    "maxConcurrentPerSession": 4,
    "autoWake": false
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
- `use: "user/repo"` 形式の外部取得は、強制機構ができるまで**エラー**にする。

### 3.1 ロード順

1. manifest の `requires` から依存グラフを作る。
2. トポロジカルソートで順番を決める。
3. 同順位のときだけ配列の順番を使う。
4. 循環依存は起動失敗。

### 3.2 manifest の場所

manifest はコードとは別の `manifest.json`。`use` がディレクトリなら `<dir>/manifest.json`、ファイルなら `<dir>/<basename>.manifest.json` を探す (無ければ `<dir>/manifest.json`)。**TBD (D36)**。

### 3.3 モジュール設定

- `config` はそのままモジュールの `init` に渡される。検証はモジュールが行う (zod 推奨)。
- コアは `config` の内容を解釈しない。
- ただし `shell` と `jobs` はコアが解釈する横断設定。

## 4. `models`

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
| `maxConcurrentPerSession` | `4` | セッションあたりの同時ジョブ数 |
| `autoWake` | `false` | アイドル中の完了通知で新しいターンを開始するか |

- ツールの `timeoutMs` が `maxTimeoutMs` を超える場合は切り詰める。
- 同時実行数を超えた新規ジョブは `job_limit_exceeded` で失敗させる (**TBD**: キュー方式)。

## 7. `log` / `dataDir` / `prompt` / `secrets`

| キー | 内容 |
|---|---|
| `log.level` | `debug` / `info` / `warn` / `error` (既定 `info`) |
| `log.file` | 未指定なら stderr |
| `dataDir` | モジュールが使う既定ディレクトリ (既定 `./data`) |
| `prompt.system` | config 由来の static 断片。常に static ブロックの先頭 |
| `secrets.<name>.env` | 秘密情報を読む環境変数名 |

- `prompt.system` はモジュールから削除・上書きできない。長さ上限は 32 KiB (**TBD**)。
- 秘密情報は `ctx.secrets.get(name)` で解決する。プロバイダーの `stream()` 中のみ取得できる。
- 未設定の秘密情報を要求した場合は利用時に例外。

## 8. 承認記録

- 保存先はユーザーの設定ディレクトリの `approvals.json`。プロジェクトの config とは分ける。
- 詳細は [04-modules-roles-permissions.md](04-modules-roles-permissions.md) の 4.2 を参照。

## 9. 環境変数

| 変数 | 内容 |
|---|---|
| `HARNESS_CONFIG` | config.json のパス |
| `HARNESS_LOG_LEVEL` | 診断ログのレベル上書き |
| `HARNESS_DATA_DIR` | dataDir の上書き |
| `XDG_CONFIG_HOME` | Linux の承認記録の基準ディレクトリ |
| `APPDATA` | Windows の承認記録の基準ディレクトリ |

優先順位: CLI 引数 > 環境変数 > config.json > 既定値。

## 10. 検証

- 未知のキーは警告にとどめる (前方互換のため)。
- 型違反・必須欠落は起動失敗。キーのパス付きで表示する (`modules[1].config.path`)。
- 設定のホットリロードはしない。変更は再起動で反映する。
- `src/protocol/config.ts` の `configSchema` が正。
