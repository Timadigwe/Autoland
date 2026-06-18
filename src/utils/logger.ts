import * as fs from "fs";
import * as path from "path";

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

export class Logger {
  private static instance: Logger;
  private logLevel: LogLevel = LogLevel.INFO;
  private logDir: string;

  private constructor() {
    this.logDir = path.join(process.cwd(), "logs");
    this.ensureLogDirectory();
  }

  private originalConsoleLog = console.log;
  private originalConsoleError = console.error;
  private originalConsoleWarn = console.warn;

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private colorize(message: string, levelColor: string = ""): string {
    const colors = {
      reset: "\x1b[0m",
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      blue: "\x1b[34m",
      magenta: "\x1b[35m",
      cyan: "\x1b[36m",
      gray: "\x1b[90m",
      bright: "\x1b[1m"
    };

    let colorized = message;

    // Service Tags
    colorized = colorized.replace(/\[ENGINE\]/g, `${colors.blue}[ENGINE]${colors.reset}${levelColor}`);
    colorized = colorized.replace(/\[DLMM ENGINE\]/g, `${colors.blue}[DLMM ENGINE]${colors.reset}${levelColor}`);
    colorized = colorized.replace(/\[STRATEGY\]/g, `${colors.magenta}[STRATEGY]${colors.reset}${levelColor}`);
    colorized = colorized.replace(/\[JITO\]/g, `${colors.green}[JITO]${colors.reset}${levelColor}`);
    colorized = colorized.replace(/\[LIFECYCLE\]/g, `${colors.cyan}[LIFECYCLE]${colors.reset}${levelColor}`);
    colorized = colorized.replace(/\[FAILURE AGENT\]/g, `${colors.red}[FAILURE AGENT]${colors.reset}${levelColor}`);
    colorized = colorized.replace(/\[AI REASONING\]/g, `${colors.red}[AI REASONING]${colors.reset}${levelColor}`);
    colorized = colorized.replace(/\[MUTATION\]/g, `${colors.red}[MUTATION]${colors.reset}${levelColor}`);
    colorized = colorized.replace(/\[TIP AGENT\]/g, `${colors.yellow}[TIP AGENT]${colors.reset}${levelColor}`);
    colorized = colorized.replace(/\[AI TIP\]/g, `${colors.yellow}[AI TIP]${colors.reset}${levelColor}`);

    return levelColor + colorized + colors.reset;
  }

  public hijackConsole(): void {
    console.log = (...args: any[]) => {
      const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      this.originalConsoleLog(this.colorize(message));
      this.writeToFile('INFO', message);
    };

    console.error = (...args: any[]) => {
      const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      this.originalConsoleError(this.colorize(message, "\x1b[31m")); // Red
      this.writeToFile('ERROR', message);
    };

    console.warn = (...args: any[]) => {
      const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      this.originalConsoleWarn(this.colorize(message, "\x1b[33m")); // Yellow
      this.writeToFile('WARN', message);
    };
  }

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private getTimestamp(): string {
    return new Date().toISOString();
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = this.getTimestamp();
    const baseMessage = `[${timestamp}] [${level}] ${message}`;
    
    if (data) {
      return `${baseMessage}\n${JSON.stringify(data, null, 2)}`;
    }
    
    return baseMessage;
  }

  private writeToFile(level: string, message: string, data?: any): void {
    try {
      const formattedMessage = this.formatMessage(level, message, data);
      const logFile = path.join(this.logDir, `dlmm-mm-${new Date().toISOString().split('T')[0]}.log`);
      
      fs.appendFileSync(logFile, formattedMessage + '\n');
    } catch (error) {
      this.originalConsoleError('Failed to write to log file:', error);
    }
  }

  public error(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.ERROR) {
      this.originalConsoleError(` ${message}`, data || '');
      this.writeToFile('ERROR', message, data);
    }
  }

  public warn(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.WARN) {
      this.originalConsoleWarn(`[WARN] ${message}`, data || '');
      this.writeToFile('WARN', message, data);
    }
  }

  public info(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.INFO) {
      this.originalConsoleLog(`[INFO] ${message}`, data || '');
      this.writeToFile('INFO', message, data);
    }
  }

  public debug(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.DEBUG) {
      this.originalConsoleLog(`[DEBUG] ${message}`, data || '');
      this.writeToFile('DEBUG', message, data);
    }
  }

  public success(message: string, data?: any): void {
    this.originalConsoleLog(` ${message}`, data || '');
    this.writeToFile('SUCCESS', message, data);
  }

  public trade(message: string, data?: any): void {
    this.originalConsoleLog(` ${message}`, data || '');
    this.writeToFile('TRADE', message, data);
  }

  public performance(message: string, timing: number, data?: any): void {
    this.originalConsoleLog(` ${message} (${timing}ms)`, data || '');
    this.writeToFile('PERFORMANCE', `${message} (${timing}ms)`, data);
  }

  public setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }
}