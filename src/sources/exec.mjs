/**
 * 弹幕源：外部采集进程。
 *
 * 这是给「已经有成熟抓取器」的人留的口子——不管对面是 Python 的
 * DouyinLiveWebFetcher、Go 的 douyinLive，还是你自己写的脚本，
 * 只要能往 stdout 一行一条 JSON，这里就能吃下来。
 *
 * 协议（一行一条）：
 *   {"type":"comment","user":{"name":"观众"},"text":"你好"}
 *   {"type":"gift","user":{...},"gift":{"name":"玫瑰","diamonds":1,"count":1}}
 *   [ {...}, {...} ]                    ← 一次多条也行
 *
 * 这样做的另一个好处是许可上干净：上游是 AGPL，它是独立进程，
 * 不通过 import 传染到本项目。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from '../log.mjs';
import { make } from '../events.mjs';
import { ROOT } from '../config.mjs';

const log = logger('exec');

/** 把外部进程吐出的一行 JSON 转成本项目的标准事件。 */
export function normalizeExternal(raw) {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const type = obj.type ?? 'comment';
  switch (type) {
    case 'comment':
      return make.comment(obj.user, obj.text ?? '', obj.ts);
    case 'gift':
      return make.gift(obj.user, { ...(obj.gift || {}), id: obj.gift?.id ?? obj.gift?.name, repeatEnd: obj.gift?.repeatEnd !== false }, obj.ts);
    case 'like':
      return make.like(obj.user, obj.count ?? 1, obj.total ?? 0, obj.ts);
    case 'enter':
      return make.enter(obj.user, obj.ts);
    case 'follow':
      return make.follow(obj.user, obj.ts);
    case 'stats':
      return make.stats(obj.viewers, obj.likes, obj.ts);
    default:
      return null;
  }
}

export function createExecSource(cfg, { emit, onStatus }) {
  const opts = cfg.source.exec;
  let child = null;
  let stopped = true;
  const stats = { lines: 0, events: 0, bad: 0, restarts: 0 };
  const status = () => ({ kind: 'exec', running: !stopped, pid: child?.pid ?? null, ...stats });

  function spawnOnce() {
    if (!opts.command) throw new Error('source.exec.command 未配置');
    const cwd = opts.cwd ? (path.isAbsolute(opts.cwd) ? opts.cwd : path.join(ROOT, opts.cwd)) : ROOT;
    const proc = spawn(opts.command, opts.args || [], {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      windowsHide: true,
      shell: false,
    });
    child = proc;

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      stats.lines++;
      try {
        const parsed = JSON.parse(s);
        const items = Array.isArray(parsed) ? parsed : parsed.events ? parsed.events : [parsed];
        const events = items.map(normalizeExternal).filter(Boolean);
        if (!events.length) return;
        stats.events += events.length;
        emit(events);
      } catch (err) {
        stats.bad++;
        log.warn('外部进程输出无法解析：', s.slice(0, 120));
      }
    });
    proc.stderr.on('data', (buf) => {
      const text = String(buf).trimEnd();
      if (text) log.debug('[child]', text);
    });
    proc.on('exit', (code, signal) => {
      log.warn(`采集进程退出（code=${code} signal=${signal}）`);
      if (!stopped) {
        stats.restarts++;
        setTimeout(() => {
          if (!stopped) spawnOnce();
        }, 3000);
      }
    });
    proc.on('error', (err) => log.error('采集进程启动失败：', err));
    return child;
  }

  return {
    kind: 'exec',
    async start() {
      stopped = false;
      child = spawnOnce();
      log.info(`已启动外部采集进程：${opts.command} ${(opts.args || []).join(' ')}`);
      onStatus?.(status());
    },
    async stop() {
      stopped = true;
      if (child && !child.killed) child.kill();
      child = null;
      onStatus?.(status());
    },
    status,
  };
}
