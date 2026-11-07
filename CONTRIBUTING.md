# 開発ガイド

## セットアップ

```sh
bun install
bun run check      # typecheck + test
bun run docs:gen   # events.ts からイベント一覧を生成
bun run docs:check # ドキュメント内リンクの検査
```

## コマンド

| コマンド | 内容 |
|---|---|
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | テスト |
| `bun run check` | typecheck + test |
| `bun run docs:gen` | `events.ts` からイベント一覧を生成 |
| `bun run docs:gen:check` | 生成物が最新か検査 |
| `bun run docs:check` | docs の相対リンク切れ検査 |
| `bun start` | エントリポイント実行 (現状はバージョン表示) |

## 変更の進め方

1. 仕様に関わる変更は、まず `docs/` を更新する。
2. 原文スペックを変えない。解釈は `docs/spec/` に書き、補完は `docs/spec/14-open-decisions.md` に追記する。
3. イベント名・権限名・manifest のフィールド名は原文の表記を維持する。
4. コアから特定モジュールを import しない。共有型は `src/protocol/` に置く。
5. 秘密情報 (API キー、トークン) をコード・テスト・docs に書かない。

## テスト

- 新機能には `tests/` のテストを追加する。
- ネットワークに依存するテストは書かない。プロバイダーはフェイクを使う。
- SQLite を使うテストは一時ディレクトリに DB を作り、終了時に削除する。
- ID と時刻は注入可能にし、テストでは固定値を使う。

## コミット

- 1 コミット 1 目的。docs とコードの同時変更は許す。
- メッセージは `docs:`, `core:`, `protocol:`, `module:`, `test:`, `chore:` の接頭辞を使う。
