/**
 * 舞台页的版本号。
 *
 * 解决一个很烦的问题：OBS 的浏览器源会**缓存页面**，代码改了它不重载，
 * 于是服务器在跑新逻辑、页面上跑的还是三天前的 JS，报错都报不出来。
 *
 * 做法：把 src/stage/ 下所有文件的 mtime 汇总成一个短 hash，
 * 页面每 10 秒拉一次，发现变了就自己 location.reload()。
 */
import { statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.mjs';

const DIR = path.join(ROOT, 'src', 'stage');
let cached = { at: 0, version: '' };

/** @returns {string} 形如 "a1b2c3d4" */
export function stageVersion() {
  const now = Date.now();
  if (now - cached.at < 2000) return cached.version;

  let stamp = '';
  try {
    for (const name of readdirSync(DIR).sort()) {
      if (!/\.(js|css|html)$/.test(name)) continue;
      const st = statSync(path.join(DIR, name));
      stamp += `${name}:${st.mtimeMs}:${st.size};`;
    }
  } catch {
    stamp = 'unreadable';
  }

  // 简单 hash，不需要密码学强度
  let h = 5381;
  for (let i = 0; i < stamp.length; i++) h = ((h << 5) + h + stamp.charCodeAt(i)) | 0;
  cached = { at: now, version: (h >>> 0).toString(16).padStart(8, '0') };
  return cached.version;
}
