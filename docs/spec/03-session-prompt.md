# 03. セッションとシステムプロンプト

## 1. セッション

### 1.1 コアが持つ情報

```ts
type SessionState = "active" | "idle" | "closed" | "error";

type Session = {
  id: string;            // コアが発行 (例: ses_...)
  parentId?: string;     // サブエージェントの親
  state: SessionState;
  model: string;         // 現在選択中のモデル
  createdAt: number;
};
```

- 履歴 (メッセージ列) はセッションに含めない。history-store モジュールが `sessionId` で引く。
- モデルはセッション単位で保持する。ターン途中の変更は次のターンから反映する。
- `id` の発行はコアの責務。モジュールは ID を生成しない。

### 1.2 状態遷移

```text
created -> active -> idle -> active -> ... -> closed
                  \-> error (復帰可能なら idle へ)
```

- `active`: ターン実行中。
- `idle`: 入力待ち。
- `closed`: 新規入力を受け付けない。履歴は保持する。
- `error`: ターンが回復不能に失敗。`session.closed` は発行しない。

### 1.3 サブエージェント

- サブエージェントは `parentId` を持つ別セッション。
- 呼び出し元 (親セッションを操作しているモジュール) がプロンプトを指定できる。
- 追加できる断片は **session / volatile のみ**。コアと config の static 断片は上書き・削除できない。
- 必要権限: `agent.spawn` **かつ** `prompt.contribute`。片方でも欠ければ拒否する。
- 子セッションのモデルは親と同一を既定とする。明示指定は `agent.spawn` の引数で行う (許可モデルの範囲内)。
- 子のジョブをキャンセルできるのは、そのセッション自身と祖先のみ (`agent.cancel(sessionId)`)。兄弟・他人の子孫は不可。
- ターン終了時、子セッションは `closed` にせず `idle` のまま保持する (再利用・監査のため)。明示クローズは `session.manage`。

### 1.4 fork と spawn

| 操作 | 意味 | 履歴 | イベント |
|---|---|---|---|
| fork | 既存セッションの履歴を複製して分岐 | 複製する | `session.forked` |
| spawn | 空の履歴で子セッションを開始 | 複製しない | `session.created` + `agent.spawned` |

fork は `session.manage` を必要とする。spawn は上記の 2 権限を必要とする。

## 2. システムプロンプト

### 2.1 断片

```ts
type PromptStability = "static" | "session" | "volatile";

type PromptSegment = {
  id: string;             // 一意。例: "config.system", "core.rules", "module:foo"
  source: string;         // 登録元 (config / core / モジュール名)
  stability: PromptStability;
  priority: number;       // 大きいほど前に置く
  content: string;
};
```

- モジュールは `ctx.prompt.contribute(segment)` で登録する。`prompt.contribute` 権限が必要。
- コアは登録された断片を検証する (空文字、重複 ID、長さ上限)。
- **安定度が異なる断片を混ぜて並べない。** 必ず static → session → volatile のブロック順にする。

### 2.2 並び順

1. `static` ブロック
   - config.json のプロンプト (最優先。常に先頭)
   - コアの基本ルール
   - モジュール由来の static (priority 降順、同時なら登録順)
2. `session` ブロック (priority 降順、同時なら登録順)
3. `volatile` ブロック (priority 降順、同時なら登録順)

`priority` は同一ブロック内でのみ意味を持つ。安定度をまたいだ優先度比較はしない (キャッシュ境界を守るため)。

### 2.3 キャッシュ境界

コアは結合結果と一緒に境界を返す。

```ts
type AssembledPrompt = {
  segments: PromptSegment[];   // 上記の順
  cacheBoundary: number;       // static ブロックの末尾 index
  hash: string;                // static 部分のハッシュ (診断用)
};
```

- プロバイダーは `cacheBoundary` をヒントに、static 部分をキャッシュ対象として扱える。
- ターン中に static 断片を追加・変更してはならない。変更要求は次のターンから反映する。
- `prompt.assembled` イベントに `segments` (id と stability のみ) と `cacheBoundary` を載せる。本文は載せない (ログ肥大化と秘密漏洩を避ける)。

### 2.4 prompt.assemble フック

- 全断片が揃った後に呼ぶ。フックは断片の追加・削除・並び替え・本文の書き換えができる。
- ただし、安定度ブロックの順序と config static の先頭固定は破れない。違反した変更は拒否し、`permission.violation` を発行する。
- サブエージェント生成時に「static を書き換える」フック結果は親の権限でも許可しない。
- フックの実行順は登録順。各フックは前のフックの出力を受け取る。

### 2.5 コア基本ルール (static) の内容

最低限、次を含める。文言は実装時に確定する。

- ツールは与えられたスキーマに従って呼ぶこと。
- 非同期ツールの結果は通知と `read_result` で取得すること。
- 通知は履歴末尾に追記されること。
- 権限外の操作を試みないこと。
- サブエージェントには必要な文脈だけを渡すこと。

### 2.6 サブエージェントへのプロンプト

呼び出し元が指定したプロンプトは **session 断片** として追加する (既定)。揮発的な作業指示は volatile 断片にする。

- 追加できるのは session / volatile のみ。
- 同じ ID の既存断片があっても static は置き換えられない。session / volatile 内の重複は後着を優先する。
- 親の会話履歴は自動継承しない。必要な要約は呼び出し元が session 断片として渡す。
