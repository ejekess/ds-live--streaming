/**
 * 给 vendored 的 pet.js 打一个「只增不改」的小补丁：把 `act` 暴露到 window.DSHPet。
 *
 * 为什么要这个补丁：pet.js 内部有 act({mood, motion, props, line, heart, ms})，
 * 它把「表情 + 动作 + 气泡 + 爱心粒子 + 起停时序」打包在一次调用里，是目前
 * 驱动这只鲸鱼娘最稳的入口；但作者只把更底层的 setReaction/playMotion 暴露了出来。
 * 自己在外层拼一遍会导致「话说完了嘴还在动」这类错位，所以直接把它接出来。
 *
 * 原则：
 *   · 绝不改动原文件，产物写到 pet.patched.js，原文件保持上游原样（便于核对/升级）；
 *   · 只插入一行，且带标记注释，重复运行不会重复插；
 *   · 锚点找不到就报错，不做任何猜测性替换——补丁悄悄失效比报错危险得多。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'vendor', 'whale-girl', 'assets', 'pet.js');
const OUT = path.join(ROOT, 'vendor', 'whale-girl', 'assets', 'pet.patched.js');
const MARK = '/* live-patch: expose act() */';
const ANCHOR = 'window.DSHPet = {\n';
const INSERT = `${MARK}\n    act,\n`;

/**
 * 打补丁（幂等）。服务启动时会自动调一次，所以正常使用不需要手动执行。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function ensurePatched() {
  if (!existsSync(SRC)) return { ok: false, reason: `缺少素材文件 ${path.relative(ROOT, SRC)}` };
  const source = await readFile(SRC, 'utf8');
  if (source.includes(MARK)) {
    await writeFile(OUT, source, 'utf8');
    return { ok: true, reason: '源文件自带补丁' };
  }
  if (!source.includes('function act(spec)')) {
    return { ok: false, reason: '源文件里找不到 act()，上游版本可能变了' };
  }
  const at = source.indexOf(ANCHOR);
  if (at < 0) return { ok: false, reason: '找不到 window.DSHPet 定义锚点' };

  const patched = source.slice(0, at + ANCHOR.length) + INSERT + source.slice(at + ANCHOR.length);
  await writeFile(OUT, patched, 'utf8');
  return { ok: true, reason: `新增 ${patched.length - source.length} 字节` };
}

// 直接运行时作为命令行工具使用
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  ensurePatched()
    .then((r) => {
      if (!r.ok) {
        console.error(`[patch] 失败：${r.reason}`);
        process.exit(1);
      }
      console.log(`[patch] 已生成 ${path.relative(ROOT, OUT)}（${r.reason}）`);
    })
    .catch((err) => {
      console.error('[patch] 异常：', err);
      process.exit(1);
    });
}
