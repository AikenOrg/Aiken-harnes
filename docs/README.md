# ドキュメント案内

本リポジトリの仕様は「原文スペック」を正とし、実装可能な粒度に分解した仕様書と、環境に関する ADR で構成する。

## 読む順番

| # | ドキュメント | 内容 |
|---|---|---|
| 0 | [requirements/original-spec.md](requirements/original-spec.md) | ユーザー提示の原文スペック (変更しない) |
| 1 | [spec/01-overview.md](spec/01-overview.md) | 目的、スコープ、設計原則、全体像 |
| 2 | [spec/02-architecture.md](spec/02-architecture.md) | レイヤ、起動停止、ターンループ、ディレクトリ |
| 3 | [spec/03-session-prompt.md](spec/03-session-prompt.md) | セッション、サブエージェント、プロンプト断片 |
| 4 | [spec/04-modules-roles-permissions.md](spec/04-modules-roles-permissions.md) | manifest、ロール、権限、承認 |
| 5 | [spec/05-tools-jobs.md](spec/05-tools-jobs.md) | ツール、非同期ジョブ、通知、キャンセル |
| 6 | [spec/06-events.md](spec/06-events.md) | イベントエンベロープ、ペイロード原則、配信 |
| 6g | [spec/06-events.generated.md](spec/06-events.generated.md) | 全ペイロードの生成一覧 (events.ts が正) |
| 7 | [spec/07-hooks.md](spec/07-hooks.md) | 3 種類のフック |
| 8 | [spec/08-provider.md](spec/08-provider.md) | Provider インターフェイスとメッセージ型 |
| 9 | [spec/09-ctx-api.md](spec/09-ctx-api.md) | ctx API と権限強制の範囲 |
| 10 | [spec/10-storage.md](spec/10-storage.md) | SQLite、WAL、単一書き込みキュー |
| 11 | [spec/11-config.md](spec/11-config.md) | config.json とモジュール設定 |
| 12 | [spec/12-lifecycle-errors.md](spec/12-lifecycle-errors.md) | critical、障害時の挙動、停止 |
| 13 | [spec/13-roadmap.md](spec/13-roadmap.md) | マイルストーン、評価タスク、未決定 |
| 14 | [spec/14-open-decisions.md](spec/14-open-decisions.md) | 決定・補完・要確認事項 |
| 15 | [impl/m1.md](impl/m1.md) | M1 の実装状況・動かし方・未実装項目 |
| 16 | [impl/m3.md](impl/m3.md) | SQLite 永続化と session.restore の実装 |
| — | [adr/](adr/) | 環境・ツール選定の記録 |

## ドキュメントのルール

1. **原文スペックを勝手に書き換えない。** 解釈・補完は `spec/` 側に書き、原文との差分は `spec/14-open-decisions.md` に記録する。
2. **決定と未決定を混ぜない。** 未決定は「TBD」と明示し、`13-roadmap.md` の未決定リストへリンクする。
3. **実装より先に仕様を更新する。** 実装中に仕様判断が変わったら、同じ変更で docs を直す。
4. **イベント名・権限名・型名は原文の表記を変えない。** コード側の型と 1:1 に対応させる。
