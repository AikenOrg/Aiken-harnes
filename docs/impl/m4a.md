# M4a 実装ノート: approvals.json と承認フロー

2026-11-08 時点。`--approve-all` 以外の本来の承認経路を実装した。

## 構成

| ファイル | 内容 |
|---|---|
| `src/core/approvals.ts` | ハッシュ、ApprovalStore、ApprovalManager、警告、照合 |
| `src/core/module-host.ts` | 承認後にモジュールを activate して init |
| `src/core/module-loader.ts` | コードを import せず記述子を返す遅延ロード |
| `src/modules/ui-cli` | UI ロールの `requestApproval` (標準入出力) |
| `src/index.ts` | CLI の承認フロー、`--approve-all`、`--approvals` |
| `src/shared/paths.ts` | `approvalsFile()` |

## approvals.json

```jsonc
{
  "v": 1,
  "modules": {
    "my-module": {
      "codeHash": "<sha256>",
      "codeOnlyHash": "<sha256>",
      "permissionsHash": "<sha256>",
      "permissions": ["history.read", "fs.write:paths=./data"],
      "approvedAt": 1760000000000
    }
  }
}
```

- 既定: `~/.config/iken-harnes/approvals.json` (Windows は `%APPDATA%\iken-harnes\approvals.json`)。
- 一時ファイルへ書いて `rename`。書き込み直前に読み直してマージする。
- 壊れたファイル / 未知の版は `.bak` に退避し、空の記録として扱う (fail closed)。
- `codeOnlyHash` は manifest を除くコードだけのハッシュ。権限だけを減らしたときの自動更新に使う内部フィールド。

## ハッシュ

- `codeHash`: ディレクトリ内のファイル (node_modules / .git を除く) を相対パス順に連結して SHA-256。単一ファイルはコード + `<basename>.manifest.json`。
- 改行は LF に正規化する。
- `permissionsHash`: `roles` / `talksTo` / `permissions` / `tools` / `main` / `version` をキー順・配列順を正規化した JSON にして SHA-256。
- どちらもコード import 前に計算する。`ModuleLoader` は記述子だけを返し、承認後に `activate()` で import する。

## 照合

| 状態 | 動作 |
|---|---|
| 記録なし | 承認を要求 |
| codeHash が変わった | 再承認 (コード変更) |
| 権限が増えた / 変わった | 再承認。変更点を表示 |
| 権限が減っただけ | 確認なしで記録を更新 |
| 一致 | 確認なしでロード |
| roles / talksTo / tools / main / version 変更 | 再承認 (変更点を表示) |
| builtin | 承認を省略し `permission.granted source:"builtin"` |
| `--approve-all` | 承認を省略し approvals.json を書かない |

## UI とイベント

- コアは `ui` ロールの `requestApproval(request)` を呼ぶ。
- `request` には module / version / roles / permissions / changes / warnings / previous が入る。
- `permission.requested` → `permission.granted (source)` / `permission.denied (cap:"module")`。
- UI がない、または標準入力が TTY でない場合は拒否。
- 拒否時:
  - `critical: true` → 起動エラー
  - `critical: false` → `module.disabled` で続行

## 警告

- 重い権限: `exec` / `secrets.read` / `tool.intercept` / `history.rewrite` / `history.restore` / `session.delete`
- 危険な組み合わせ: `history.read + net`、`fs.read + net`
- builtin が重い権限を持つ場合も起動時に診断ログへ出す。

## `--approve-all`

- 開発用。承認をバイパスし、approvals.json を書かない。
- 起動時に警告を表示。
- `config.allowApproveAll: false` の場合は CLI が拒否する。

## テスト

`tests/core/approvals.test.ts`:

- 初回承認 → 記録 → 2 回目は要求なし
- コード変更で再承認
- CRLF 変更だけでは再承認しない
- 権限追加で差分 + 警告、権限削減は自動更新
- critical 拒否で起動エラー、非 critical は disabled
- 壊れた approvals.json の `.bak` 退避
- `--approve-all` 相当はファイルを書かない
- 承認前にコードが import されない
- 重い権限の警告
- `allowApproveAll: false` の判定

## 既知の制限

- fs の強制がないため、モジュール自身が approvals.json を書き換えられる。改ざん防止ではなく記録・変更検知として扱う。
- 複数プロセスの同時承認は last-write-wins。ファイルは壊れないが、同時に別モジュールを承認した場合に片方が失われる可能性がある。
- Windows 実機の `%APPDATA%` パス確認は未実施。
- 外部取得 (`user/repository`) は未解禁。
