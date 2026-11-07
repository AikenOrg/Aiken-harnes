# ADR 0001: ランタイムとツールチェーン

- 日付: 2026-11-07
- 状態: 採用

## 文脈

TypeScript でゼロからハーネスを作る。Linux / Windows の両方で動かし、AI が実装を進める。ビルドとテストの往復を短くしたい。

## 決定

- ランタイム: **Bun 1.4 系**
- 言語: TypeScript (strict)
- 型検査: `tsc --noEmit`
- スキーマ: **zod 4**
- テスト: `bun test`
- DB: `bun:sqlite` (SQLite モジュール内)
- パッケージ管理: `bun install` / `bun.lock`

## 理由

- Bun は TypeScript を直接実行でき、ビルド工程なしで開発できる。
- `bun test` と `bun:sqlite` が標準で揃い、依存を減らせる。
- Windows でも単一バイナリで動作し、Node のインストールを前提にしない。
- zod はツール入力と設定検証の両方に使え、JSON Schema への変換もできる。

## 影響

- Bun 固有 API (`bun:sqlite`, `Bun.file` など) を許容する。Node 互換を最優先しない。
- TypeScript 7 系 (native) を使う。`tsc` の挙動が変わった場合はバージョンを固定する。
- ネイティブ依存を要求するライブラリは避ける (Windows での配布を簡単にするため)。

## 代替案

- Node.js + tsx: 実績はあるが、テスト・SQLite・実行速度で Bun に劣る。
- Deno: エコシステムと SQLite の扱いが Bun ほど成熟していない。
