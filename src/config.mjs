/**
 * 配置：默认值写在代码里，`config/config.json` 覆盖它。
 *
 * 所有可热改的项都在 `HOT_KEYS` 里，管控台改完即刻生效、并落盘，
 * 省得每次调一个「最多每分钟回几条」都要重启进程。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from './log.mjs';

const log = logger('config');
export const ROOT = path.resolve(import.meta.dirname, '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 8787,
    /** 非空时，写接口要求带 X-Admin-Token。默认只监听本机，所以默认空着能直接用。 */
    adminToken: '',
  },
  source: {
    /** mock | replay | exec | cdp */
    kind: 'mock',
    replay: { file: 'data/sample-live.jsonl', speed: 1, loop: false },
    exec: { command: '', args: [], cwd: '' },
    cdp: {
      roomUrl: '',
      /** 用本机已装的浏览器，避免下载 Chromium。msedge / chrome / 留空自动 */
      browserChannel: 'msedge',
      headless: false,
      userDataDir: 'data/browser-profile',
      /** 页面打开后等这么久再开始收帧 */
      warmupMs: 6000,
    },
  },
  avatar: {
    /** 舞台高度（px）。OBS 浏览器源建议 1080。 */
    height: 820,
    corner: 'br',
    lookAtCursor: false,
    talkMouth: true,
    /** 气泡最长停留，0 = 跟随动作时长 */
    bubbleTtlMs: 0,
    maxWidthRatio: 0.9,
  },
  reaction: {
    /** 两条演出之间的最小间隔 */
    cooldownMs: 800,
    maxPerMinute: 45,
    /** 同一人同一礼物在这个窗口内合并成连击 */
    comboWindowMs: 4500,
    /** 连击数量达到这些值时额外播报一次 */
    announceComboAt: [3, 10, 52, 1314],
    /** 各档位的独立冷却，避免大礼刷屏时把画面糊死 */
    tierCooldownMs: { 1: 2600, 2: 1800, 3: 900, 4: 350, 5: 0 },
  },
  interaction: {
    enabled: true,
    /** 两次主动搭话的最小间隔 */
    minIntervalMs: 7000,
    maxPerMinute: 5,
    /** 攒一小段弹幕再挑，避免对第一句话就抢答 */
    pickWindowMs: 2200,
    /** 打分低于这个值就不理 */
    minScore: 7,
    ignore: {
      maxLength: 60,
      patterns: ['加微', '加v', '代刷', '卖号', '返利', '兼职'],
    },
    /** 进场欢迎（默认关，人多时很吵） */
    greetEnter: false,
  },
  brain: {
    /** rules | llm */
    kind: 'rules',
    persona: {
      name: '小鲸鱼',
      /** 规则脑的说话风格：句尾语气词池 */
      tone: ['呀', '呢', '哦', '啦'],
    },
    llm: {
      enabled: false,
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      timeoutMs: 6000,
      /** 输出长度硬上限（字），超过直接截断，防「烧 token」 */
      maxOutputChars: 42,
      maxCallsPerMinute: 4,
      maxCallsPerDay: 200,
      /** 只把被挑中的那一条送出去，且不带历史 */
      includeHistory: false,
    },
  },
  /** 语音合成。clipsDir 默认指向已有的语音库，目录不存在会自动降级为实时合成。 */
  voice: {
    enabled: true,
    python: 'python',
    pythonPath: 'data/pylibs',
    voice: 'zh-CN-XiaoyiNeural',
    pitch: '+12Hz',
    rate: '-20%',
    clipsDir: 'D:/space/deepseek/qq-bridge/audio',
    cacheDir: 'data/voice/cache',
    preferClips: true,
    duckRatio: 0.3,
    maxLen: 60,
  },
  /** 点歌与翻唱。 */
  songs: {
    /** 点歌功能总开关。关掉后代码仍保留，随时能打开 */
    enabled: false,
    // ★ 这是「成品翻唱库」：放已经做好的翻唱。原曲不在这里，
    // 原曲是 sing.py 的素材，由它自己找/下载。
    libraryDir: 'data/songs/covers',
    stateDir: 'data/songs',
    queueFile: 'data/songs/queue.json',
    quotaFile: 'data/songs/quota.json',
    renderedDir: 'data/songs/rendered',
    /** placeholder = 合成音占位（无需 RVC）；rvc = 调 sing.py 真渲染 */
    renderer: 'placeholder',
    renderTimeoutMs: 600000,
    maxQueue: 5,
    minGapMs: 90000,
    gapAfterAnnounceMs: 1500,
    randomAvoidLast: 3,
    creditTtlMs: 300000,
    grantWindowMs: 10000,
    dailyLimit: { 3: 3, 4: 8, 5: 0 },
    maxSongLen: 20,
    blacklist: [],
    homophoneRules: [],
    singMotion: 'aidale',
    rebuildIndex: false,
    rvc: {
      python: 'python',
      script: 'D:/space/deepseek/qq-bridge/tools/sing.py',
      cwd: 'D:/space/deepseek/qq-bridge',
      env: {},
    },
    placeholder: { delayMs: 8000, seconds: 6 },
  },
  /** 猜词小游戏：送指定礼物 / 达到档位就开一局。 */
  games: {
    enabled: true,
    /** reverse = 观众藏词她来问；forward = 她描述观众猜 */
    mode: 'reverse',
    /** 礼物名精确匹配；留空则用下面 minTier 判断 */
    triggerGifts: [],
    minTier: 4,
    cooldownMs: 120000,
    hintCount: 3,
    /** 各阶段时长。合计约 90 秒，可在管控台调 */
    phases: {
      // forward 用
      introMs: 4000, hintGapMs: 12000, optionsMs: 45000, revealMs: 8000,
      // reverse 用
      pickMs: 10000, askMs: 4000, answerMs: 15000, rounds: 5,
      // 决策：每轮结束问模型「继续问还是猜」
      decideTimeoutMs: 6000, maxGuesses: 3,
    },
  },
  gifts: {
    catalog: 'config/gifts.json',
    /** 礼物 id/名称 → 自定义档位，优先级高于内置目录 */
    overrides: {},
  },
};

/** 允许管控台热改的路径。 */
const HOT_KEYS = new Set([
  'avatar.height',
  'avatar.corner',
  'reaction.cooldownMs',
  'reaction.maxPerMinute',
  'reaction.comboWindowMs',
  'reaction.tierCooldownMs',
  'interaction.enabled',
  'interaction.minIntervalMs',
  'interaction.maxPerMinute',
  'interaction.minScore',
  'interaction.greetEnter',
  'brain.kind',
  'brain.llm.enabled',
  'brain.llm.maxCallsPerMinute',
  'brain.llm.maxCallsPerDay',
  'voice.enabled',
  'voice.duckRatio',
  'songs.renderer',
  'songs.minGapMs',
  'songs.gapAfterAnnounceMs',
  'songs.maxQueue',
  'songs.blacklist',
  'games.enabled',
  'games.minTier',
  'games.cooldownMs',
  'games.phases',
  'games.reverse',
  'games.triggerGifts',
]);

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, patch) {
  if (!isObject(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function getByPath(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

export function setByPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (!isObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[last] = value;
}

let state = structuredClone(DEFAULTS);

export async function load() {
  await mkdir(CONFIG_DIR, { recursive: true });
  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
      state = deepMerge(structuredClone(DEFAULTS), raw);
      log.info(`已载入 ${path.relative(ROOT, CONFIG_FILE)}`);
      // 老配置里没有新段落（voice/songs）就回写一次，否则用户在文件里找不到可改的项
      const missingSections = ['voice', 'songs'].filter((k) => !(k in raw));
      if (missingSections.length) {
        await save();
        log.info(`已把新增配置段写入文件：${missingSections.join(', ')}`);
      }
    } catch (err) {
      log.error('配置解析失败，改用默认值：', err);
    }
  } else {
    await save();
    log.info('未找到配置，已生成默认 config/config.json');
  }
  validate(state);
  return state;
}

export function get() {
  return state;
}

/** 热改：只接受白名单里的路径，改完落盘。 */
export async function patch(updates) {
  const applied = {};
  const rejected = [];
  for (const [key, value] of Object.entries(updates || {})) {
    if (!HOT_KEYS.has(key)) {
      rejected.push(key);
      continue;
    }
    setByPath(state, key, value);
    applied[key] = value;
  }
  if (Object.keys(applied).length) await save();
  return { applied, rejected };
}

export async function save() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function resolved(rel) {
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

function validate(cfg) {
  const port = Number(cfg.server.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`server.port 非法：${cfg.server.port}`);
  if (!['mock', 'replay', 'exec', 'cdp'].includes(cfg.source.kind)) throw new Error(`source.kind 非法：${cfg.source.kind}`);
  if (!['rules', 'llm'].includes(cfg.brain.kind)) throw new Error(`brain.kind 非法：${cfg.brain.kind}`);
  cfg.avatar.height = Math.max(240, Math.min(2160, Number(cfg.avatar.height) || 820));
  return cfg;
}
