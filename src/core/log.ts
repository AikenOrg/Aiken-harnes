export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  #level: LogLevel;
  #sink: (level: LogLevel, message: string, meta?: unknown) => void;

  constructor(options: { level?: LogLevel; sink?: (level: LogLevel, message: string, meta?: unknown) => void } = {}) {
    this.#level = options.level ?? "info";
    this.#sink =
      options.sink ??
      ((level, message, meta) => {
        const line = `[${level}] ${message}`;
        if (level === "error" || level === "warn") console.error(line, meta ?? "");
        else console.log(line, meta ?? "");
      });
  }

  log(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVELS[level] < LEVELS[this.#level]) return;
    this.#sink(level, message, meta);
  }

  debug(message: string, meta?: unknown): void { this.log("debug", message, meta); }
  info(message: string, meta?: unknown): void { this.log("info", message, meta); }
  warn(message: string, meta?: unknown): void { this.log("warn", message, meta); }
  error(message: string, meta?: unknown): void { this.log("error", message, meta); }
}
