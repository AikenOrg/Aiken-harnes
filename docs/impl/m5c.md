# M5c 実装ノート: 画像入力

2026-11-08 時点。Web UI から画像を添付し、履歴に保存して、OpenAI 互換 / Anthropic のマルチモーダル入力として送れるようにした。

## 1. 型

```ts
type ImageBlock = {
  type: "image";
  mediaType: string; // image/png など
  data: string;      // base64 本体（data URL ではない）
  name?: string;
};

type ModelInfo = {
  // ...
  supportsImages?: boolean;
  imageMediaTypes?: string[]; // モデルが受け付ける MIME
};
```

- `Message.blocks` に `image` を追加。ユーザーメッセージにだけ入る。
- 履歴・SQLite は既存の `content_json` にそのまま保存する。スキーマ変更なし。
- 画像本文はイベントに載せない。`user.message` は `imageCount` だけを持つ。

## 2. 入力経路

- Web UI の「画像」ボタン、ドラッグ＆ドロップ、クリップボード貼り付け。
- `session.send` コマンドの `images` に `{mediaType, data, name?}` を載せる。
- コアの `ctx.session.send(sessionId, text, { images })` へ渡す。
- `TurnLoop` がユーザーメッセージのブロックを作る（text → image の順）。
- CLI の画像入力は未対応。

## 3. 上限と検証

既定値:

| 項目 | 既定 |
|---|---|
| 1 枚のデコード後サイズ | 4 MiB |
| 1 メッセージの枚数 | 4 |
| 合計デコード後サイズ | 8 MiB |

- `config.images.maxBytes` / `maxCount` / `maxTotalBytes` で変更する。
- `image/*` の MIME 形式、canonical base64、サイズをコアで検証する。
- モデルの `supportsImages` と `imageMediaTypes` に一致しない画像は拒否する。
- WebSocket の `maxPayloadLength` は 24 MiB。

## 4. モデル能力

- `provider-opencode-go`: `models.json` の `supportsImages` / `imageMediaTypes` を `ModelInfo` に載せる。
  - 例: `glm-5.3-flash` は jpeg/png、`deepseek-v4.1-flash` は jpeg/png/gif/webp。
- `provider-anthropic`: `models[].supportsImages` / `imageMediaTypes` で指定。既定モデルは jpeg/png/gif/webp。
- Web UI は選択モデルが非対応なら添付ボタンを無効化する。

## 5. Provider 変換

### OpenAI 互換

```ts
{ role: "user", content: [
  { type: "text", text: "..." },
  { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
] }
```

- 画像がないメッセージは従来どおり文字列 content を使う。

### Anthropic

```ts
{ type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
```

- テキストと画像のブロック順を保持する。

## 6. UI

- 添付画像のサムネイルと削除ボタン。
- 送信時に楽観表示し、失敗時は入力と添付を復元する。
- 履歴の画像は `figure` / `img` で表示する。
- モデル切り替え・セッション切り替えで未送信の添付をクリアする。

## 7. テスト

- `tests/core/images.test.ts`: 画像ブロック、provider への引き渡し、非対応モデル・MIME・サイズ・枚数・base64 の拒否。
- `tests/modules/opencode-go.test.ts`: `image_url` 変換。
- `tests/modules/anthropic.test.ts`: base64 image block 変換。
- `tests/modules/store-sqlite.test.ts`: 画像ブロックの復元。
- `tests/modules/ui-web.test.ts`: `session.send` の images。

## 8. 制限

- 画像生成、PDF、動画は対象外。
- 画像は base64 で SQLite に保存するため、大きな画像を多数保存すると DB が増える。
- CLI からの画像添付は未対応。
