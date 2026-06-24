

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
};

/** Tag → color mapping for quick visual scanning */
const TAG_COLORS: Record<string, string> = {
  "[ENGINE]": C.brightBlue,
  "[POSITION]": C.blue,
  "[STRATEGY]": C.brightMagenta,
  "[DRY RUN]": C.gray,
  "[INFO]": C.gray,
  "[WARN]": C.yellow,
  "[ERROR]": C.red,
  "[SUCCESS]": C.brightGreen,
  "[TRADE]": C.green,
};

export class Logger {
  private static instance: Logger;
  private logLevel: LogLevel = LogLevel.INFO;

  private readonly originalConsoleLog = console.log;
  private readonly originalConsoleError = console.error;
  private readonly originalConsoleWarn = console.warn;

  private readonly recentWarnErrors: string[] = [];
  private readonly recentRawLogs: string[] = [];
  private readonly maxRecentWarnErrors = 80;
  private readonly maxRecentRawLogs = 120;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private colorize(message: string, levelColor = ""): string {
    let out = message;

    for (const [tag, color] of Object.entries(TAG_COLORS)) {
      const escaped = tag.replace(/[[\]]/g, "\\$&");
      out = out.replace(
        new RegExp(escaped, "g"),
        `${color}${tag}${C.reset}${levelColor}`
      );
    }

    return levelColor ? levelColor + out + C.reset : out;
  }

  public hijackConsole(): void {
    console.log = (...args: unknown[]) => {
      const message = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
      this.originalConsoleLog(this.colorize(message));
    };

    console.error = (...args: unknown[]) => {
      const message = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
      this.originalConsoleError(this.colorize(message, C.red));
    };

    console.warn = (...args: unknown[]) => {
      const message = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
      this.originalConsoleWarn(this.colorize(message, C.yellow));
    };
  }

  private emit(level: "ERROR" | "WARN" | "INFO" | "DEBUG", message: string, data?: unknown, levelColor = ""): void {
    const prefix = `[${level}]`;
    const full = data !== undefined ? `${prefix} ${message} ${JSON.stringify(data)}` : `${prefix} ${message}`;
    const colored = this.colorize(full, levelColor);

    if (level === "ERROR") this.originalConsoleError(colored);
    else if (level === "WARN") this.originalConsoleWarn(colored);
    else this.originalConsoleLog(colored);

    if (level === "WARN" || level === "ERROR") {
      this.pushRecentWarnError(full);
    }
    this.pushRecentRawLog(full);
  }

  private pushRecentRawLog(line: string): void {
    this.recentRawLogs.push(line);
    if (this.recentRawLogs.length > this.maxRecentRawLogs) {
      this.recentRawLogs.shift();
    }
  }

  public getRecentRawLogLines(limit = 60): string[] {
    return this.recentRawLogs.slice(-limit);
  }

  private pushRecentWarnError(line: string): void {
    this.recentWarnErrors.push(line);
    if (this.recentWarnErrors.length > this.maxRecentWarnErrors) {
      this.recentWarnErrors.shift();
    }
  }

  public getRecentWarnErrorLines(limit = 40): string[] {
    return this.recentWarnErrors.slice(-limit);
  }

  public error(message: string, data?: unknown): void {
    if (this.logLevel >= LogLevel.ERROR) this.emit("ERROR", message, data, C.red);
  }

  public warn(message: string, data?: unknown): void {
    if (this.logLevel >= LogLevel.WARN) this.emit("WARN", message, data, C.yellow);
  }

  public info(message: string, data?: unknown): void {
    if (this.logLevel >= LogLevel.INFO) this.emit("INFO", message, data);
  }

  public debug(message: string, data?: unknown): void {
    if (this.logLevel >= LogLevel.DEBUG) this.emit("DEBUG", message, data, C.dim);
  }

  public success(message: string, data?: unknown): void {
    this.emit("INFO", message, data, C.brightGreen);
  }

  public trade(message: string, data?: unknown): void {
    this.emit("INFO", message, data, C.green);
  }

  public performance(message: string, timing: number, data?: unknown): void {
    this.emit("INFO", `${message} (${timing}ms)`, data, C.cyan);
  }


  public setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }
}
