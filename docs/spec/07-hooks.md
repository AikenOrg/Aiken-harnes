# 07. フック

## 1. 共通ルール

- フックは登録順に**直列**で呼ばれる。前のフックの出力が次の入力になる。
- フックは結果を変えられるが、コアの不変条件 (権限、安定度ブロック順、config static の先頭固定など) は破れない。
- フック内の例外は記録し、そのフックの変更を破棄して続行する。ただし拒否系のフックが例外を投げた場合は安全側に倒し、拒否として扱う。
- フックにはタイムアウトを設ける (既定 5 秒)。**TBD**: 設定項目化。
- フックの登録は `ctx.hooks.register`。必要権限はフック種別ごとに異なる (下表)。

| フック | 登録に必要な権限 |
|---|---|
| `prompt.assemble` | `prompt.contribute` |
| `tool.before` | `tool.intercept` |
| `compaction.decide` | `compactor` ロール |

## 2. `prompt.assemble`

```ts
type PromptAssembleHook = (input: {
  session: Session;
  segments: PromptSegment[];
  cacheBoundary: number;
  isSubagent: boolean;
}) => PromptSegment[] | void;
```

- 全断片の登録が終わった後に 1 回呼ぶ。
- 断片の追加・削除・並び替え・本文の書き換えができる。
- 禁止される変更:
  - config static 断片を先頭以外へ動かす / 削除する
  - static と session / volatile を混在させる
  - サブエージェントで static 断片を変更する (親の権限でも不可)
- 禁止変更を検出したら、そのフックの出力全体を破棄し、`permission.violation` を発行する。
- フック後にコアが再度並び替えと `cacheBoundary` の再計算を行う。`prompt.assembled` は最終結果で 1 回だけ発行する。

## 3. `tool.before`

```ts
type ToolBeforeHook = (input: {
  session: Session;
  toolCallId: string;
  name: string;
  args: unknown;
  mode: "sync" | "async";
}) => {
  decision?: "allow" | "deny";
  args?: unknown;         // 承認済みの引数で置き換える
  reason?: string;
} | void;
```

- 同期・非同期の両方に適用する。実行直前 (job 作成前) に呼ぶ。
- 判定の合成:
  - 1 つでも `deny` があれば拒否。理由を最初の deny から採る。
  - `args` は最後に返したフックの値を使う。ただし zod で再検証し、不正なら拒否する。
- 拒否時:
  - `permission.denied` を発行する (`hook: "tool.before"`、`cap`、理由)。
  - 続けて `tool.failed (code: "denied")` を発行する。
  - モデルには拒否理由を `tool_result` として返す。ツールは実行しない。返さないと AI が同じ呼び出しを繰り返す。
- `tool.intercept` は重い権限。承認時に「他ツールの拒否・引数書き換えができる」と警告する。
- shell の承認モジュールは `tool.intercept` を使う。
- ユーザー承認が必要な場合、UI モジュールが `permission.requested` を購読して問い合わせる。フックは回答が来るまで待てる (ターンはブロックされる)。

## 4. `compaction.decide`

```ts
type CompactionDecideHook = (input: {
  session: Session;
  messageCount: number;
  tokenEstimate?: number;
  /** 直近のモデル呼び出しでプロバイダーが返した usage.input。 */
  lastInputTokens?: number;
  lastCompactionAt?: number;
}) => {
  action: "run" | "skip" | "defer";
  reason?: string;
} | void;
```

- compaction を実行するかの判断だけを行う。実際の書き換えは compactor ロールのモジュールが `ctx.history.rewrite` で行う。
- `run` が 1 つでもあれば実行。すべて `skip` なら実行しない。`defer` は次のターンまで待つ。
- 矛盾した結果は「実行しない」に倒す。
- 実行後、compactor は `compaction.completed` を発行する。コアは `history.rewritten` を検証して発行する。
- compaction の詳細 (要約アルゴリズム、保持する直近件数) は **TBD**。最小ループが動いてから決める。
- compactor がいない、または `compaction.decide` が実行を選ばないまま上限に近づいた場合、コアは履歴を切り捨てず `turn.ended (reason: "context_overflow")` で止める。

## 5. フックの順序と衝突

- 登録順はモジュールのロード順に従う。同じモジュール内では登録順。
- フックの追加・削除はロード完了後に許可しない (実行中の順序を安定させるため)。
- フックの実行中にフックを登録しても、その呼び出しには反映しない。
