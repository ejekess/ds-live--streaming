/**
 * 开播测试的一键开关。
 *
 *   node tools/live.mjs 123456789    # 接自己的直播间 + 降到测试门槛
 *   node tools/live.mjs off          # 恢复上线配置（mock 源、T4 门槛、两分钟冷却）
 *   node tools/live.mjs status       # 看现在是什么状态
 *
 * 只改 config.json，不动别的。改完需要重启服务才生效（source 是启动时创建的）。
 */
import { readFile, writeFile } from 'node:fs/promises';

const FILE = 'config/config.json';
const LIVE_GAMES = { minTier: 1, cooldownMs: 15000 };
const PROD_GAMES = { minTier: 4, cooldownMs: 120000 };

const arg = (process.argv[2] ?? 'status').trim();

async function load() {
  return JSON.parse(await readFile(FILE, 'utf8'));
}
async function save(cfg) {
  await writeFile(FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

if (arg === 'status') {
  const c = await load();
  console.log('source.kind :', c.source.kind);
  console.log('roomUrl     :', c.source.cdp.roomUrl || '(空)');
  console.log('games       : minTier=' + c.games.minTier + ' cooldownMs=' + c.games.cooldownMs);
  console.log('brain       :', c.brain.kind, '| maxCallsPerDay=' + c.brain.llm.maxCallsPerDay);
  process.exit(0);
}

if (arg === 'off') {
  const c = await load();
  c.source.kind = 'mock';
  c.games.minTier = PROD_GAMES.minTier;
  c.games.cooldownMs = PROD_GAMES.cooldownMs;
  await save(c);
  console.log('✓ 已恢复上线配置：source=mock, minTier=4, cooldown=120s');
  console.log('  重启服务生效。');
  process.exit(0);
}

const roomId = arg.replace(/\D/g, '');
if (!/^\d{6,}$/.test(roomId)) {
  console.error('用法：node tools/live.mjs <房间号>   （就是 live.douyin.com/ 后面那串数字）');
  console.error('      node tools/live.mjs off');
  process.exit(1);
}

const c = await load();
c.source.kind = 'cdp';
c.source.cdp.roomUrl = `https://live.douyin.com/${roomId}`;
c.source.cdp.headless = false;
c.games.minTier = LIVE_GAMES.minTier;
c.games.cooldownMs = LIVE_GAMES.cooldownMs;
await save(c);

console.log(`✓ 已切到你的直播间：https://live.douyin.com/${roomId}`);
console.log('  minTier → 1（送任何礼物都开局）');
console.log('  cooldown → 15 秒（方便连测）');
console.log('');
console.log('下一步：');
console.log('  1. 重启服务（source 只在启动时读取）');
console.log('  2. 等日志出现「已挂上推送信道」');
console.log('  3. 舞台页 Ctrl+F5');
console.log('');
console.log('测完记得：node tools/live.mjs off');
