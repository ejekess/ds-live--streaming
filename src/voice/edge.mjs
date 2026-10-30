/**
 * edge-tts 客户端：两种传输，自动降级。
 *
 *   pipe  常驻 worker（默认）：单句 300–600ms，靠 stdin/stdout 的 JSONL 通信。
 *   once  一次性子进程：用 argv + 文件通信，单句约 2.5s（要付 Python 启动）。
 *
 * 为什么需要 once：不是所有环境都允许带管道 stdio 的子进程——
 * 某些沙箱/守护进程里 `spawn(..., stdio:'pipe')` 直接 EPERM。
 * 遇到这种情况自动切到 once，功能不丢，只是慢一点。
 *
 * 失败策略是「快速放弃」：两种通道都不行就标记不可用，
 * 上层拿到 null 会退化成纯气泡。语音是锦上添花，卡住链路才是事故。
 */
import { spawn } from 'node:child_process';
import { readFile, unlink, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../log.mjs';
import { ROOT } from '../config.mjs';

const log = logger('voice:edge');
const WORKER = path.join(ROOT, 'src', 'voice', 'tts_worker.py');
const ONCE = path.join(ROOT, 'src', 'voice', 'tts_once.py');
const TMP = path.join(ROOT, 'data', 'runtime', 'tts-tmp');

export function createEdgeTts({ python = 'python', pythonPath, voice, pitch, rate, requestTimeoutMs = 12000 } = {}) {
  let child = null;
  let ready = false;
  let booting = null;
  let mode = 'pipe'; // pipe | once | dead
  let seq = 0;
  const pending = new Map(); // id → {resolve, timer}
  const env = { ...process.env, PYTHONPATH: pythonPath ?? '', PYTHONIOENCODING: 'utf-8' };

  function failAll(reason) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: reason });
      pending.delete(id);
    }
  }

  function startPipe() {
    if (booting) return booting;
    booting = new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(python, [WORKER], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        log.warn(`常驻 worker 起不来（${err?.code || err?.message}），改用一次性子进程`);
        mode = 'once';
        resolve(false);
        return;
      }
      child = proc;

      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      let buf = '';
      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let at;
        while ((at = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, at).trim();
          buf = buf.slice(at + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.hello) {
            ready = true;
            log.info('TTS 常驻 worker 就绪（pipe 通道）');
            done(true);
            continue;
          }
          const p = pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(msg.id);
            p.resolve(msg);
          }
        }
      });

      proc.stderr.on('data', (b) => log.debug('[tts]', String(b).trimEnd()));

      proc.on('error', (err) => {
        log.warn(`常驻 worker 出错（${err?.code || err?.message}），改用一次性子进程`);
        mode = 'once';
        ready = false;
        child = null;
        done(false);
      });

      proc.on('exit', (code) => {
        if (mode === 'pipe') log.warn(`TTS worker 退出（${code}），语音降级为一次性合成`);
        ready = false;
        child = null;
        booting = null;
        failAll('worker exited');
      });

      setTimeout(() => {
        if (!ready) {
          log.warn('TTS worker 8 秒未就绪，按不可用处理');
          done(false);
        }
      }, 8000).unref?.();
    });
    return booting;
  }

  /** 一次性：请求写文件 → spawn(ignore) → 等退出 → 读结果文件。 */
  async function synthOnce(text, out, timeoutMs) {
    await mkdir(TMP, { recursive: true });
    const id = `r_${Date.now()}_${++seq}`;
    const reqFile = path.join(TMP, `${id}.json`);
    await writeFile(reqFile, JSON.stringify({ text, out, voice, pitch, rate }), 'utf8');

    const code = await new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(python, [ONCE, reqFile], { env, windowsHide: true, stdio: 'ignore' });
      } catch (err) {
        resolve(`spawn-fail:${err?.code || err?.message}`);
        return;
      }
      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        resolve('timeout');
      }, timeoutMs);
      proc.on('exit', (c) => { clearTimeout(timer); resolve(c); });
      proc.on('error', (e) => { clearTimeout(timer); resolve(`error:${e?.code || e.message}`); });
    });

    const resFile = `${reqFile}.res.json`;
    let result = { ok: false, error: `once exit ${code}` };
    if (existsSync(resFile)) {
      try {
        result = JSON.parse(await readFile(resFile, 'utf8'));
      } catch (err) {
        result = { ok: false, error: `bad result: ${err.message}` };
      }
    }
    await unlink(reqFile).catch(() => {});
    await unlink(resFile).catch(() => {});
    return result;
  }

  return {
    get available() {
      return ready || mode === 'once';
    },
    get mode() {
      return mode;
    },

    /** @returns {Promise<{ok:true,ms?:number}|{ok:false,error:string}>} */
    async synth(text, out, timeoutMs = requestTimeoutMs) {
      if (mode === 'dead') return { ok: false, error: 'unavailable' };

      if (mode === 'once') return synthOnce(text, out, timeoutMs);

      if (!ready) {
        const ok = await startPipe();
        if (!ok) {
          if (mode === 'dead') return { ok: false, error: 'unavailable' };
          return synthOnce(text, out, timeoutMs);
        }
      }

      const id = `v_${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: 'timeout' });
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        try {
          child.stdin.write(JSON.stringify({ id, text, out, voice, pitch, rate }) + '\n', 'utf8');
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          resolve({ ok: false, error: err.message });
        }
      });
    },

    stop() {
      failAll('stopped');
      try {
        child?.kill();
      } catch {}
      child = null;
      ready = false;
      booting = null;
      if (mode === 'pipe') mode = 'dead';
    },
  };
}
