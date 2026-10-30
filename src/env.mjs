/**
 * 读 .env。
 *
 * 项目本来要求"用系统环境变量"，但那样每次启动都要 export，太麻烦；
 * 这里加个 30 行的小加载器，**系统环境变量优先**（.env 只做兜底）。
 *
 * 必须在 index.mjs 的**第一个 import**，否则 log.mjs 之类在模块初始化时
 * 就读 process.env 的会读不到。
 */
import { readFileSync, existsSync } from 'node:fs';

function parseLine(line) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m) return null;
  let value = m[2];
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [m[1], value];
}

export function loadEnv(url = new URL('../.env', import.meta.url)) {
  let text;
  try {
    text = readFileSync(url, 'utf8');
  } catch {
    return { loaded: false, count: 0 };
  }
  let count = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.trimStart().startsWith('#')) continue;
    const kv = parseLine(raw);
    if (!kv) continue;
    const [key, value] = kv;
    // 系统里已经有了就不覆盖：环境变量永远优先于文件
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count += 1;
    }
  }
  return { loaded: true, count };
}

loadEnv();
