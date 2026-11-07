const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomToken(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export type IdGenerator = {
  boot(): string;
  session(): string;
  message(): string;
  job(): string;
  turn(): string;
};

export function createIdGenerator(): IdGenerator {
  return {
    boot: () => randomToken(8),
    session: () => `ses_${randomToken(12)}`,
    message: () => `msg_${randomToken(12)}`,
    job: () => `job_${randomToken(12)}`,
    turn: () => `turn_${randomToken(12)}`,
  };
}

/** テスト用の決定的な ID。 */
export function createSequentialIds(prefix = "test"): IdGenerator {
  let boot: string | undefined;
  let session = 0;
  let message = 0;
  let job = 0;
  let turn = 0;
  return {
    boot: () => (boot ??= `${prefix}boot`),
    session: () => `ses_${prefix}_${++session}`,
    message: () => `msg_${prefix}_${++message}`,
    job: () => `job_${prefix}_${++job}`,
    turn: () => `turn_${prefix}_${++turn}`,
  };
}
