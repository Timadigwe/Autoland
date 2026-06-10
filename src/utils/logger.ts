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

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
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
      console.error('Failed to write to log file:', error);
    }
  }

  public error(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.ERROR) {
      console.error(` ${message}`, data || '');
      this.writeToFile('ERROR', message, data);
    }
  }

  public warn(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.WARN) {
      console.warn(`[WARN] ${message}`, data || '');
      this.writeToFile('WARN', message, data);
    }
  }

  public info(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.INFO) {
      console.log(`[INFO] ${message}`, data || '');
      this.writeToFile('INFO', message, data);
    }
  }

  public debug(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.DEBUG) {
      console.log(`[DEBUG] ${message}`, data || '');
      this.writeToFile('DEBUG', message, data);
    }
  }

  public success(message: string, data?: any): void {
    console.log(` ${message}`, data || '');
    this.writeToFile('SUCCESS', message, data);
  }

  public trade(message: string, data?: any): void {
    console.log(` ${message}`, data || '');
    this.writeToFile('TRADE', message, data);
  }

  public performance(message: string, timing: number, data?: any): void {
    console.log(` ${message} (${timing}ms)`, data || '');
    this.writeToFile('PERFORMANCE', `${message} (${timing}ms)`, data);
  }

  public setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }
}