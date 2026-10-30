/**
 * 一键采集舞台画面：待机 + 五档打赏各一张。
 *
 * 这是给「改了一版想看看对不对」用的：不用真的开播，也不用等剧本，
 * 直接通过管控台的 /api/manual 触发五档打赏，每档截一张图，
 * 顺便把「有没有气泡、有没有动作、有没有特效」回读出来做客观判断。
 *
 * 用法：node tools/capture.mjs [--h=780] [--out=data/runtime]
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureBrowser } from '../browser.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const BASE = opt('base', 'http://127.0.0.1:8787');
const outDir = path.resolve(opt('out', 'data/runtime'));
const height = opt('h', '780');
const width = Number(opt('w', 1600));
const viewH = Number(opt('vh', 900));
const port = Number(process.env.CDP_PORT || 9222);

await mkdir(outDir, { recursive: true });

const launched = await ensureBrowser({ port, headless: true });
const browser = await chromium.connectOverCDP(launched.wsEndpoint);
const context = browser.contexts()[0] ?? (await browser.newContext());
context.setDefaultTimeout(60_000);

const page = await context.newPage();
await page.setViewportSize({ width, height: viewH });

const results = [];
const shots = [];

async function shot(name, { bg = true } = {}) {
  if (bg) {
    await page.addStyleTag({
      content:
        'html,body{background:radial-gradient(circle at 52% 26%, #1b2a4a 0%, #0b1220 62%, #05080f 100%) !important;}',
    });
  }
  const file = path.join(outDir, `${name}.png`);
  // 透明那张必须 omitBackground：否则 Playwright 会铺白底，看着「有底」其实是被它压平的
  await page.screenshot({ path: file, omitBackground: !bg });
  shots.push(file);
  return file;
}

async function state() {
  return page.evaluate(() => {
    const pet = window.DSHPet;
    const bubble = document.querySelector('.dshp-bubble');
    return {
      ready: Boolean(pet?.state?.modelSize),
      mood: pet?.state?.mood ?? null,
      face: pet?.state?.face ?? null,
      props: pet?.state?.props ?? [],
      motionPlaying: Boolean(pet?.state?.motion?.active),
      acting: pet?.state?.acting?.left ?? null,
      hasAct: typeof pet?.act === 'function',
      bubbleOn: Boolean(bubble && bubble.classList.contains('dshp-on')),
      bubbleText: bubble ? (bubble.textContent || '').slice(0, 60) : null,
      modelSize: pet?.state?.modelSize ?? null,
      // 透明底是 OBS 的硬要求，顺手回读一次，别等上播才发现带着白底
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });
}

async function manual(body) {
  const res = await fetch(`${BASE}/api/manual`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

try {
  // 先把弹幕源停掉：截图要的是「我点的这一档」，不能被后台剧本抢镜
  await fetch(`${BASE}/api/source`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }),
  }).catch(() => {});

  await page.goto(`${BASE}/avatar?h=${height}&corner=br`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.DSHPet?.state?.modelSize), null, { timeout: 45_000 });
  await page.waitForTimeout(2500);

  results.push({ step: 'idle', ...(await state()) });
  // 先存一张透明底的：这才是 OBS 里真实叠上去的样子
  await shot('stage-alpha', { bg: false });
  await shot('stage-idle');

  const tiers = [1, 2, 3, 4, 5];
  for (const tier of tiers) {
    const sent = await manual({ kind: 'gift', tier, name: '测试大哥', gift: `礼物T${tier}` });
    // 动作很短（喷水只有几百毫秒），所以要早点采一次样，不然永远看到 playing:false
    await page.waitForTimeout(280);
    const early = await state();
    await page.waitForTimeout(620);
    const mid = await state();
    results.push({ step: `gift-t${tier}`, sent, motionEarly: early.motionPlaying, ...mid });
    await shot(`stage-gift-t${tier}`, { bg: false }); // 后续图已带背景样式，不必重复注入
    await page.waitForTimeout(2600);
  }

  // 手动说一句话，验证气泡文本
  await manual({ kind: 'say', text: '大家好，我是小鲸鱼，今天也一起玩呀' });
  await page.waitForTimeout(800);
  results.push({ step: 'say', ...(await state()) });
  await shot('stage-say', { bg: false });

  // —— 管控台：顺带检查它能不能正常渲染、设置项有没有回填 ——
  const adminPage = await context.newPage();
  await adminPage.setViewportSize({ width: 1500, height: 950 });
  const adminErrors = [];
  adminPage.on('pageerror', (e) => adminErrors.push(`[pageerror] ${e.message}`));
  adminPage.on('console', (m) => {
    if (m.type() === 'error') adminErrors.push(`[console] ${m.text()}`);
  });
  await adminPage.goto(`${BASE}/admin/`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
  await adminPage.waitForTimeout(2500);
  const adminProbe = await adminPage.evaluate(() => ({
    tabs: document.querySelectorAll('.tab').length,
    stats: document.querySelectorAll('.stat').length,
    minScore: document.querySelector('[data-cfg="interaction.minScore"]')?.value ?? null,
    brainKind: document.querySelector('[data-cfg="brain.kind"]')?.value ?? null,
    tierButtons: document.querySelectorAll('#tierBtns .btn').length,
    streamRows: document.querySelectorAll('#stream .row-item').length,
    subtitle: document.getElementById('subtitle')?.textContent ?? null,
  }));
  await adminPage.screenshot({ path: path.join(outDir, 'admin.png') });
  shots.push(path.join(outDir, 'admin.png'));
  results.push({ step: 'admin', adminProbe, adminErrors });
  await adminPage.close().catch(() => {});
} catch (err) {
  results.push({ step: 'error', error: String(err?.message || err) });
} finally {
  await page.close().catch(() => {});
}

// 完整结果落盘，方便事后回看（终端只打摘要，免得刷屏）
await writeFile(
  path.join(outDir, 'capture.json'),
  JSON.stringify({ ok: results.every((r) => !r.error), shots, results }, null, 2),
  'utf8',
);

for (const r of results) {
  if (r.error) {
    console.log(`✗ ${r.step}: ${r.error}`);
    continue;
  }
  if (r.step === 'admin') {
    const p = r.adminProbe;
    console.log(
      `· admin        标签 ${p.tabs} / 卡 ${p.stats} / 档位按钮 ${p.tierButtons} / 事件行 ${p.streamRows} / 分数线 ${p.minScore} / JS错误 ${r.adminErrors.length}`,
    );
    continue;
  }
  const bits = [
    `face=${r.face ?? '-'}`,
    `motionEarly=${r.motionEarly === undefined ? '-' : r.motionEarly}`,
    `props=${(r.props || []).length}`,
    `bubble=${r.bubbleOn}`,
  ];
  if (r.bodyBg) bits.push(`bodyBg=${r.bodyBg}`);
  console.log(`· ${r.step.padEnd(13)} ${bits.join('  ')}`);
}
console.log(`截图 ${shots.length} 张 → ${outDir}`);

// 截图完把弹幕源开回去，别留一个「停播」的状态给下一个人
await fetch(`${BASE}/api/source`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'start' }),
}).catch(() => {});

// 直接退出：连的是外部浏览器，不需要也不应该在这里 close 掉它
process.exit(0);
