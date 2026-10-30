/**
 * 统一日志：带级别、时间、模块名，同时留一份环形缓冲给管控台实时看。
 *
 * 直播场景下日志是排障主力——弹幕丢了、礼物没触发、模型没加载，
 * 都得能事后回看最近几百条，所以内存里始终保留最近 N 条。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const COLOR = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

const buffer = [];
const BUFFER_LIMIT = 500;
let minLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;
let seq = 0;

function push(entry) {
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
  return entry;
}

function make(module) {
  const emit = (level, args) => {
    const entry = push({
      seq: ++seq,
      ts: Date.now(),
      level,
      module,
      text: args.map(fmt).join(' '),
    });
    if (LEVELS[level] >= minLevel) {
      const stamp = new Date(entry.ts).toTimeString().slice(0, 8);
      const line = `${COLOR[level] ?? ''}${stamp} ${level.toUpperCase().padEnd(5)} [${module}]${COLOR.reset} ${entry.text}`;
      (level === 'error' ? console.error : console.log)(line);
    }
    return entry;
  };

  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = make('app');
export function logger(module) {
  return make(module);
}
export function setLevel(level) {
  if (level in LEVELS) minLevel = LEVELS[level];
}
export function recentLogs(limit = 200) {
  return buffer.slice(-limit);
}
