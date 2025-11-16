/**
 * Enhanced console logging with colors and structure for better demo visualization
 */

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

type LogLevel =
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'debug'
  | 'call'
  | 'tool'
  | 'transcript';

const levelConfig: Record<
  LogLevel,
  { color: string; symbol: string; label: string }
> = {
  info: { color: colors.blue, symbol: 'ℹ', label: 'INFO' },
  success: { color: colors.green, symbol: '✓', label: 'SUCCESS' },
  warning: { color: colors.yellow, symbol: '⚠', label: 'WARNING' },
  error: { color: colors.red, symbol: '✗', label: 'ERROR' },
  debug: { color: colors.dim, symbol: '◦', label: 'DEBUG' },
  call: { color: colors.cyan, symbol: '📞', label: 'CALL' },
  tool: { color: colors.magenta, symbol: '🔧', label: 'TOOL' },
  transcript: { color: colors.white, symbol: '💬', label: 'TRANSCRIPT' },
};

function formatTimestamp(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${colors.dim}${hours}:${minutes}:${seconds}.${ms}${colors.reset}`;
}

function formatCallId(callId: string): string {
  return `${colors.cyan}[${callId.slice(0, 8)}]${colors.reset}`;
}

function formatObject(obj: unknown): string {
  if (typeof obj === 'string') {
    return obj;
  }
  return JSON.stringify(obj, null, 2);
}

export class Logger {
  private readonly isDemoMode: boolean;

  constructor(demoMode = process.env.LOG_FORMAT === 'pretty') {
    this.isDemoMode = demoMode;
  }

  private log(
    level: LogLevel,
    message: string,
    data?: unknown,
    callId?: string
  ): void {
    if (!this.isDemoMode) {
      // Fallback to simple console.log if demo mode is off
      console.log(JSON.stringify({ level, message, data, callId }));
      return;
    }

    const config = levelConfig[level];
    const timestamp = formatTimestamp();
    const callIdStr = callId ? ` ${formatCallId(callId)}` : '';
    const levelLabel = `${config.color}${config.symbol} ${config.label}${colors.reset}`;

    let output = `${timestamp} ${levelLabel}${callIdStr} ${colors.bright}${message}${colors.reset}`;

    if (data !== undefined) {
      const dataStr = formatObject(data);
      output += `\n${colors.dim}${dataStr}${colors.reset}`;
    }

    console.log(output);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  success(message: string, data?: unknown): void {
    this.log('success', message, data);
  }

  warning(message: string, data?: unknown): void {
    this.log('warning', message, data);
  }

  error(message: string, error?: unknown): void {
    const errorData =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : error;
    this.log('error', message, errorData);
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  call(callId: string, event: string, data?: unknown): void {
    this.log('call', event, data, callId);
  }

  tool(
    callId: string,
    toolName: string,
    status: 'start' | 'success' | 'error',
    data?: unknown
  ): void {
    let statusSymbol = '→';
    if (status === 'success') {
      statusSymbol = '✓';
    } else if (status === 'error') {
      statusSymbol = '✗';
    }
    this.log('tool', `${statusSymbol} ${toolName}`, data, callId);
  }

  transcript(
    callId: string,
    speaker: 'user' | 'assistant',
    text: string
  ): void {
    const speakerLabel =
      speaker === 'user'
        ? `${colors.green}USER${colors.reset}`
        : `${colors.blue}ASSISTANT${colors.reset}`;
    this.log('transcript', `${speakerLabel}: ${text}`, undefined, callId);
  }

  banner(text: string): void {
    if (!this.isDemoMode) {
      return;
    }

    const border = '═'.repeat(text.length + 4);
    console.log(`\n${colors.bright}${colors.cyan}╔${border}╗${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}║  ${text}  ║${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}╚${border}╝${colors.reset}\n`);
  }

  separator(): void {
    if (!this.isDemoMode) {
      return;
    }
    console.log(`${colors.dim}${'─'.repeat(80)}${colors.reset}`);
  }

  callSummary(
    callId: string,
    summary: {
      duration?: number;
      toolCalls: number;
      transcripts: number;
      sentiment?: string;
      status: string;
    }
  ): void {
    if (!this.isDemoMode) {
      return;
    }

    const durationStr = summary.duration
      ? `${Math.floor(summary.duration / 1000)}s`
      : 'ongoing';

    let sentimentColor = colors.yellow;
    if (summary.sentiment === 'positive') {
      sentimentColor = colors.green;
    } else if (summary.sentiment === 'negative') {
      sentimentColor = colors.red;
    }

    console.log(
      `\n${colors.bright}${colors.cyan}┌─ Call Summary ─────────────────────────────────────────────┐${colors.reset}`
    );
    console.log(
      `${colors.cyan}│${colors.reset} Call ID:     ${formatCallId(callId)}`
    );
    console.log(
      `${colors.cyan}│${colors.reset} Duration:    ${colors.bright}${durationStr}${colors.reset}`
    );
    console.log(
      `${colors.cyan}│${colors.reset} Tool Calls:  ${colors.bright}${summary.toolCalls}${colors.reset}`
    );
    console.log(
      `${colors.cyan}│${colors.reset} Messages:    ${colors.bright}${summary.transcripts}${colors.reset}`
    );
    console.log(
      `${colors.cyan}│${colors.reset} Sentiment:   ${sentimentColor}${summary.sentiment ?? 'unknown'}${colors.reset}`
    );
    console.log(
      `${colors.cyan}│${colors.reset} Status:      ${colors.bright}${summary.status}${colors.reset}`
    );
    console.log(
      `${colors.bright}${colors.cyan}└────────────────────────────────────────────────────────────┘${colors.reset}\n`
    );
  }

  stats(stats: {
    activeCalls: number;
    totalCalls: number;
    completedCalls: number;
    toolCalls: number;
    uptime: number;
  }): void {
    if (!this.isDemoMode) {
      return;
    }

    const uptimeHours = Math.floor(stats.uptime / (1000 * 60 * 60));
    const uptimeMinutes = Math.floor(
      (stats.uptime % (1000 * 60 * 60)) / (1000 * 60)
    );

    console.log(
      `\n${colors.bright}${colors.green}┌─ System Statistics ────────────────────────────────────────┐${colors.reset}`
    );
    console.log(
      `${colors.green}│${colors.reset} Active Calls:    ${colors.bright}${stats.activeCalls}${colors.reset}`
    );
    console.log(
      `${colors.green}│${colors.reset} Total Calls:     ${colors.bright}${stats.totalCalls}${colors.reset}`
    );
    console.log(
      `${colors.green}│${colors.reset} Completed:       ${colors.bright}${stats.completedCalls}${colors.reset}`
    );
    console.log(
      `${colors.green}│${colors.reset} Total Tool Calls: ${colors.bright}${stats.toolCalls}${colors.reset}`
    );
    console.log(
      `${colors.green}│${colors.reset} Uptime:          ${colors.bright}${uptimeHours}h ${uptimeMinutes}m${colors.reset}`
    );
    console.log(
      `${colors.bright}${colors.green}└────────────────────────────────────────────────────────────┘${colors.reset}\n`
    );
  }
}

export const logger = new Logger(true);
