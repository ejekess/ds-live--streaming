/**
 * 弹幕源：回放 JSONL。
 *
 * 一行一个事件对象。用来把真实直播间录下来的片段反复调参——
 * 「刚才那条嘉年华为什么没触发」这种问题，靠回放能在 10 秒内复现。
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../log.mjs';
import { ROOT } from '../config.mjs';

const log = logger('replay');

export async function readReplay(file) {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!existsSync(abs)) throw new Error(`回放文件不存在：${abs}`);
  const rl = readline.createInterface({ input: createReadStream(abs, 'utf8'), crlfDelay: Infinity });
  const rows = [];
  for await (const line of rl) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {
      log.warn('跳过无法解析的行：', s.slice(0, 80));
    }
  }
  return { rows, abs };
}

export function createReplaySource(cfg, { emit, onStatus }) {
  let stopped = true;
  let timer = null;
  const opts = cfg.source.replay;
  const stats = { total: 0, played: 0, loops: 0 };

  async function play(rows) {
    const speed = Math.max(0.05, Number(opts.speed) || 1);
    let prevTs = rows[0]?.event?.ts ?? rows[0]?.ts ?? Date.now();
    for (const row of rows) {
      if (stopped) return;
      const ev = row.event ?? row;
      const ts = Number(ev.ts) || prevTs;
      const gap = Math.max(0, Math.min(8000, ts - prevTs)) / speed;
      prevTs = ts;
      await new Promise((r) => setTimeout(r, gap));
      if (stopped) return;
      stats.played++;
      emit([{ ...ev, ts: Date.now() }]);
      onStatus?.(status());
    }
  }

  const status = () => ({ kind: 'replay', running: !stopped, ...stats });

  return {
    kind: 'replay',
    async start() {
      const { rows, abs } = await readReplay(opts.file);
      stats.total = rows.length;
      stopped = false;
      log.info(`回放 ${path.relative(ROOT, abs)}（${rows.length} 条，speed=${opts.speed}）`);
      onStatus?.(status());
      (async () => {
        do {
          await play(rows);
          stats.loops++;
        } while (!stopped && opts.loop);
        if (!stopped) log.info('回放结束');
      })();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      onStatus?.(status());
    },
    status,
  };
}
