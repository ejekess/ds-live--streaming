/**
 * 真渲染器：调用你已有的 RVC 翻唱管线（qq-bridge/tools/sing.py）。
 *
 * 关键约束：**子进程，不是进程内调用**。RVC 会吃几个 G 内存、可能崩、
 * 可能卡住不返回；放在子进程里，最坏情况是 kill 掉它，主进程和直播不受影响。
 *
 * sing.py 的契约（故意不改它）：
 *   入：python sing.py "<歌名>" [候选序号]
 *   出：stdout 最后打印 `成品 <路径>`，`NO_SEND=1` 时不往 QQ 发
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { logger } from '../../log.mjs';

const log = logger('songs:rvc');

const OUTPUT_RE = /成品\s+(.+\.(?:mp3|wav|flac))/i;

export function createRvcRenderer({
  python = 'python',
  script,
  cwd,
  renderedDir,
  timeoutMs = 600_000,
  extraEnv = {},
} = {}) {
  if (!script) throw new Error('songs.render.rvc.script 未配置');

  return {
    kind: 'rvc',
    async render({ song }) {
      await mkdir(renderedDir, { recursive: true });
      const started = Date.now();

      return new Promise((resolve, reject) => {
        const child = spawn(python, [script, song, '1'], {
          cwd: cwd || path.dirname(script),
          env: { ...process.env, NO_SEND: '1', ...extraEnv },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let out = '';
        let err = '';
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill(); } catch {}
          reject(new Error(`渲染超时（${Math.round(timeoutMs / 1000)}s）`));
        }, timeoutMs);

        child.stdout.on('data', (b) => { out += b.toString('utf8'); });
        child.stderr.on('data', (b) => { err += b.toString('utf8'); });

        child.on('error', (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`启动失败：${e.message}`));
        });

        child.on('close', async (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          if (code !== 0) {
            reject(new Error(`渲染进程退出 ${code}：${(err || out).slice(-300)}`));
            return;
          }
          const m = out.match(OUTPUT_RE);
          if (!m) {
            reject(new Error(`没在输出里找到成品路径：${out.slice(-300)}`));
            return;
          }

          try {
            const src = m[1].trim();
            const info = await stat(src);
            const hash = createHash('sha1').update(`rvc:${song}:${Date.now()}`).digest('hex').slice(0, 10);
            const dest = path.join(renderedDir, `rvc_${hash}${path.extname(src) || '.mp3'}`);
            await copyFile(src, dest);
            // 192kbps 估算，只用于超时兜底
            const durationMs = Math.round((info.size / 24000) * 1000);
            log.info(`[RVC] 「${song}」完成，用时 ${Math.round((Date.now() - started) / 1000)}s`);
            resolve({ file: dest, durationMs });
          } catch (e) {
            reject(new Error(`处理成品失败：${e.message}`));
          }
        });
      });
    },
  };
}
