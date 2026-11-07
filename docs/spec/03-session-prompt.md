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
  autoWake?: boolean;    // アイドル中の完了通知で自動ターン開始
  lastInputTokens?: number; // 直近の usage.input
  createdAt: number;
};
```

- 履歴 (メッセージ列) は `Session` 型に含めない。コアの `HistoryManager` が `sessionId` ごとにメモリで保持する (関心の分離)。
- モデルはセッション単位で保持する。ターン途中の変更は次のターンから反映する。
- `id` の発行はコアの責務。モジュールは ID を生成しない。

### 1.2 状態遷移

```text
created -> idle -> active -> idle -> ... -> closed
created -> restoring -> idle
                  \-> error (復帰可能なら idle へ)
```

- `active`: ターン実行中。
- `idle`: 入力待ち。
- `restoring`: 保存済み履歴を復元中。`ctx.history.restore` だけが許可される。
- `closed`: 新規入力を受け付けない。履歴はコアのメモリに残る (プロセス終了まで)。永続化は任意。
- `error`: ターンが回復不能に失敗。`session.closed` は発行しない。復元失敗もここに落ちる。

### 1.3 サブエージェント

- サブエージェントは `parentId` を持つ別セッション。
- 呼び出し元 (親セッションを操作しているモジュール) がプロンプトを指定できる。
- 追加できる断片は **session / volatile のみ**。コアと config の static 断片は上書き・削除できない。
- 必要権限: `agent.spawn` **かつ** `prompt.contribute`。片方でも欠ければ拒否する。
- 子セッションのモデルは親と同一を既定とする。明示指定は `agent.spawn` の引数で行う (許可モデルの範囲内)。
- 子のジョブをキャンセルできるのは、そのセッション自身と祖先のみ (`agent.cancel(sessionId)`)。兄弟・他人の子孫は不可。
- ターン終了時、子セッションは `closed` にせず `idle` のまま保持する (再利用・監査のため)。
- アイドルの増加は次の 2 つの規則で防ぐ。件数上限は設けない。
  1. `agent.close(sessionId)` で自分の子孫を閉じられる。子孫も再帰的に閉じる。
  2. 親セッションが `close` されたら、子孫も再帰的に閉じる。
- `agent.close` は `agent.spawn` 権限を必要とし、対象は自分の子孫のみ。
- `session.close` は `session.manage` を必要とし、子孫も再帰的に閉じる。
- サブエージェントの `autoWake` は既定 `true`。誰も入力しないため、完了通知で起こさないと止まる。`agent.spawn` の `autoWake` で上書きできる。

### 1.4 fork と spawn

| 操作 | 意味 | 履歴 | イベント |
|---|---|---|---|
| fork | 既存セッションの履歴を複製して分岐 | 複製する | `session.forked` |
| spawn | 空の履歴で子セッションを開始 | 複製しない | `session.created` + `agent.spawned` |

fork は `session.manage` を必要とする。spawn は上記の 2 権限を必要とする。

### 1.5 キャンセル時の履歴

- モデルストリームのキャンセル時、生成済みのテキストは履歴に残し、アシスタントメッセージに `interrupted: true` を付ける。
- 途中の `tool_call` は捨てる。`tool_result` と対にならない tool_call は API 上不正な会話になるため。
- ユーザーが「続けて」と言ったとき、AI が何を言いかけていたか分かるようにする。

### 1.6 コンテキスト上限

- コアはプロバイダーが返した `usage.input` をセッションごとに記録する。
- `context.overflowRatio` (既定 0.9) を超えたら、まず compaction を試みる。
- compactor がいない、または compaction できない場合、履歴を黙って切り捨てず、ターンを止めて `turn.ended (reason: "context_overflow")` を発行し、UI に通知する。
- 記録した `lastInputTokens` は `compaction.decide` フックの入力にも使う。

### 1.7 履歴との関係

- 実行中の履歴はコアのメモリが唯一の正。ループは毎ターンそこから読む。
- `history-store` は `message.appended` を購読して書き出す投影であり、コアの履歴を置き換えない。
- 復元は UI の明示要求 (`ctx.session.restore`) で始まる。session-store がセッションを `restoring` で作り、履歴が空の状態で `ctx.history.restore(sessionId, messages)` を受け付ける。
- `ctx.history.restore` は `history.restore` 権限と `history-store` ロールを持つモジュールだけが呼べる。稼働中のセッションは上書きできない。
- `config.restore: "last"` のときだけ、起動時に直前のセッションを自動で開く。既定は `"none"`。
- 復元してもターンループは再開しない。ユーザー入力か、保留中の通知による autoWake を待つ。
- 復元前に動いていたジョブは `failed (code: "interrupted")`。完了済みで未通知の通知は再キューに積む。
- fork はコアのメモリ履歴を複製する。spawn は空の履歴で始める。
- compaction の書き換えはコアの `ctx.history.rewrite` を通り、コアが `history.rewritten` を発行する。

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
