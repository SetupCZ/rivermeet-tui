import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  data?: unknown;
}

class Logger {
  private logFile: string;
  private logLevel: LogLevel;
  private entries: LogEntry[] = [];

  constructor() {
    const logDir = path.join(os.homedir(), ".cache", "confluence-tui", "logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const date = new Date().toISOString().split("T")[0];
    this.logFile = path.join(logDir, `confluence-tui-${date}.log`);
    this.logLevel = process.env.LOG_LEVEL 
      ? LogLevel[process.env.LOG_LEVEL as keyof typeof LogLevel] ?? LogLevel.INFO
      : LogLevel.DEBUG;
    
    this.info("Logger initialized", { logFile: this.logFile, logLevel: LogLevel[this.logLevel] });
  }

  private formatMessage(level: string, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const entry: LogEntry = { timestamp, level, message, data };
    this.entries.push(entry);
    
    let logLine = `[${timestamp}] [${level}] ${message}`;
    if (data !== undefined) {
      logLine += ` ${JSON.stringify(data, null, 2)}`;
    }
    return logLine;
  }

  private write(level: LogLevel, levelName: string, message: string, data?: unknown): void {
    if (level < this.logLevel) return;
    
    const logLine = this.formatMessage(levelName, message, data);
    fs.appendFileSync(this.logFile, logLine + "\n");
  }

  debug(message: string, data?: unknown): void {
    this.write(LogLevel.DEBUG, "DEBUG", message, data);
  }

  info(message: string, data?: unknown): void {
    this.write(LogLevel.INFO, "INFO", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write(LogLevel.WARN, "WARN", message, data);
  }

  error(message: string, data?: unknown): void {
    this.write(LogLevel.ERROR, "ERROR", message, data);
  }

  getLogFile(): string {
    return this.logFile;
  }

  getRecentEntries(count: number = 50): LogEntry[] {
    return this.entries.slice(-count);
  }

  // Read the entire log file
  readLogFile(): string {
    if (fs.existsSync(this.logFile)) {
      return fs.readFileSync(this.logFile, "utf-8");
    }
    return "";
  }
}

// Singleton instance
export const logger = new Logger();
