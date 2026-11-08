# next-harness

TypeScript (Bun) 製のモジュール型エージェントハーネス。コアは AI ループ・イベント・セッション・ジョブだけを持ち、プロバイダー・ツール・永続化・UI はすべてモジュールとして疎結合に差し込む。

- 仕様の入口: [`docs/README.md`](docs/README.md)
- 原文スペック (正): [`docs/requirements/original-spec.md`](docs/requirements/original-spec.md)
- 未決定事項: [`docs/spec/13-roadmap.md`](docs/spec/13-roadmap.md)

## クイックスタート

```sh
bun install
bun run check

# 同梱の mock プロバイダー + read ツールで対話
printf 'hello\n' | bun run src/index.ts --config config/dev.config.json --approve-all

# Anthropic
ANTHROPIC_API_KEY=... bun run src/index.ts \
  --config config/anthropic.config.json --approve-all

# OpenCode Go
OPENCODE_API_KEY=... bun run src/index.ts \
  --config config/opencode-go.config.json --approve-all
```

`--events` を付けるとイベントを表示する。実装状況は [`docs/impl/m1.md`](docs/impl/m1.md) を参照。

## リポジトリ構成

| パス | 内容 |
|---|---|
| `docs/` | 仕様・設計・ADR。実装より先にここを更新する |
| `src/protocol/` | コアとモジュールが共有する型 (イベント、manifest、Provider など) |
| `src/core/` | ハーネスコア (これから実装) |
| `src/modules/` | 組み込みモジュール (これから実装) |
| `src/shared/` | 汎用ユーティリティ |
| `tests/` | `bun test` によるテスト |
| `config/` | 設定ファイルのサンプル |

## ステータス

2026-11-08: M1 のコア、非同期 shell、Anthropic / OpenCode Go プロバイダーを実装。永続化・承認 UI・compaction は未実装。
