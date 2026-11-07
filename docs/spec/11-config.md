# 11. 設定

## 1. ファイル

- 既定: カレントディレクトリの `config.json`。
- 代替: `--config <path>` または環境変数 `HARNESS_CONFIG`。
- 形式: JSON (コメント不可)。スキーマは zod で検証し、違反は起動失敗。
- 秘密情報 (API キー) は config.json に直書きしない。環境変数または OS の秘密情報ストアを使う。

## 2. 全体構造

```jsonc
{
  "version": 1,
  "core": {
    "model": "openai/gpt-4.1",
    "log": { "level": "info", "file": "./data/harness.log" },
    "dataDir": "./data"
  },
  "prompt": {
    "system": "あなたは... (最優先の static 断片)"
  },
  "modules": {
    "provider": [
      { "path": "./modules/provider-openai.js", "config": { "model": "gpt-4.1" } }
    ],
    "history": [
      { "path": "./modules/history-sqlite.js", "config": { "db": "./data/harness.sqlite" } }
    ],
    "tools": [
      "./modules/tools-fs.js",
      { "path": "./modules/shell.js", "config": { "mode": "whitelist", "allow": ["ls", "git"] } }
    ],
    "ui": ["./modules/ui-tui.js"]
  }
}
```

## 3. `modules`

- キーはカテゴリ (任意のグループ名)。ロード順は「キーの記述順 → 配列順」。
- 値は配列。要素は次のいずれか:
  - 文字列: モジュールのパス (設定なし)
  - オブジェクト: `{ "path": string, "config"?: object, "enabled"?: boolean }`
- パスは相対 (config.json のディレクトリ基準) または絶対。拡張子は `.js` / `.ts`。
- 同じパスの重複ロードは起動失敗。
- 外部取得 (`user/repository` 形式) は現時点で禁止。パスとして解釈しない。

### 3.1 モジュール設定

- `config` はそのままモジュールの `init` に渡される。検証はモジュールが行う (zod 推奨)。
- コアは `config` の内容を解釈しない。
- モジュール名は manifest の `name`。config のキーとは独立。

## 4. `core`

| キー | 型 | 既定 | 内容 |
|---|---|---|---|
| `model` | string | (必須) | 既定モデル。`ModelInfo.id` と一致 |
| `log.level` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | 診断ログ |
| `log.file` | string | なし | 未指定なら stderr |
| `dataDir` | string | `"./data"` | モジュールが使う既定ディレクトリ |
| `turn.maxSteps` | number | `50` | 1 ターン内のモデル呼び出し上限 |
| `shutdown.timeoutMs` | number | `10000` | 停止時の猶予 |

## 5. `prompt`

| キー | 内容 |
|---|---|
| `system` | config 由来の static 断片。常に static ブロックの先頭 |

- 空文字・空白のみは無視する。
- この断片はモジュールから削除・上書きできない。
- 長さ上限を設ける (既定 32 KiB)。**TBD**: 上限値。

## 6. 秘密情報

- 推奨: 環境変数から読む。config には「どの環境変数を使うか」だけを書く。

```jsonc
{
  "secrets": {
    "OPENAI_API_KEY": { "env": "OPENAI_API_KEY" }
  }
}
```

- `ctx.secrets.get(name)` はこのマッピングを解決する。**TBD**: OS keyring 対応。
- 未設定の秘密情報を要求した場合は例外。起動時ではなく利用時に検出する。

## 7. 承認記録

- 初回起動時、未承認モジュールは `permission.requested` を発行して停止する (非対話環境では起動失敗)。
- 承認済みの記録はコアが保持する。保存先は **TBD**。候補:
  1. `config.json` の `approvals` (手編集可能だが改ざんに弱い)
  2. 専用の `approvals.json` (モジュール内容ハッシュ付き)
  3. SQLite (history-store に依存)
- 推奨は 2。内容ハッシュに紐づけ、権限が増えた更新で再承認する。

## 8. 環境変数

| 変数 | 内容 |
|---|---|
| `HARNESS_CONFIG` | config.json のパス |
| `HARNESS_LOG_LEVEL` | 診断ログのレベル上書き |
| `HARNESS_DATA_DIR` | dataDir の上書き |

- 優先順位: CLI 引数 > 環境変数 > config.json > 既定値。

## 9. 検証とエラー

- 未知のキーは警告にとどめる (前方互換のため)。
- 型違反・必須欠落は起動失敗。どのキーが悪いかをパス付きで表示する (`modules.tools[1].config.mode`)。
- モジュールの `enabled: false` はロードせず、`module.disabled` を発行する。
- 設定のホットリロードはしない。変更は再起動で反映する。
