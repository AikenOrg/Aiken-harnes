# next-harness

TypeScript (Bun) 製のモジュール型エージェントハーネス。コアは AI ループ・イベント・セッション・ジョブだけを持ち、プロバイダー・ツール・永続化・UI はすべてモジュールとして疎結合に差し込む。

- 仕様の入口: [`docs/README.md`](docs/README.md)
- 原文スペック (正): [`docs/requirements/original-spec.md`](docs/requirements/original-spec.md)
- 未決定事項: [`docs/spec/13-roadmap.md`](docs/spec/13-roadmap.md)

## クイックスタート

```sh
bun install
bun run typecheck
bun test
```

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

2026-11-07: リポジトリ初期化・仕様ドキュメント・共有型のスケルトンまで。コア実装は未着手。
