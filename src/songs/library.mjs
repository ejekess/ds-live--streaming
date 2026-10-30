/**
 * 离线曲库：歌名 → 文件。
 *
 * 索引放在 stateDir，音频可以放在任意目录（比如你已有的 rvc/songs），
 * 这样不用把版权文件复制来复制去。
 *
 * 查找是"宽松匹配"：去空格标点、小写、子串双向匹配，
 * 所以"青花瓷"、"周杰伦 青花瓷"、"jay青花瓷"（别名）都能命中。
 */
import { readdir, readFile, writeFile, mkdir, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../log.mjs';

const run = promisify(execFile);
const log = logger('songs:library');

const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac']);

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[\s\u3000]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}

/** 用 ffprobe 读时长；没有 ffprobe 就按码率估算。 */
async function probeDurationMs(file, bytes) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
    ], { timeout: 8000 });
    const sec = Number(String(stdout).trim());
    if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  } catch {
    /* 没装 ffprobe 走估算 */
  }
  // 128kbps mp3 ≈ 16000 字节/秒
  return Math.round((bytes / 16000) * 1000);
}

export class Library {
  #dir;
  #stateDir;
  #indexFile;
  #songs = [];

  constructor({ dir, stateDir }) {
    this.#dir = dir;
    this.#stateDir = stateDir;
    this.#indexFile = path.join(stateDir, 'index.json');
  }

  static async open({ dir, stateDir, rebuild = false }) {
    const lib = new Library({ dir, stateDir });
    await lib.#load(rebuild);
    return lib;
  }

  async #load(rebuild) {
    await mkdir(this.#stateDir, { recursive: true });
    if (!rebuild && existsSync(this.#indexFile)) {
      try {
        const raw = JSON.parse(await readFile(this.#indexFile, 'utf8'));
        this.#songs = (raw.songs ?? []).filter((s) => existsSync(path.resolve(this.#dir, s.file)));
        if (this.#songs.length) {
          log.info(`曲库：${this.#songs.length} 首（读索引）`);
          return;
        }
      } catch (err) {
        log.warn('索引损坏，重新扫描：', err?.message);
      }
    }
    await this.rescan();
  }

  /** 扫描曲库目录，重建索引。 */
  async rescan() {
    if (!existsSync(this.#dir)) {
      log.warn(`曲库目录不存在：${this.#dir}`);
      this.#songs = [];
      return this.#songs;
    }
    const entries = await readdir(this.#dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase()));

    const songs = [];
    for (const f of files) {
      const abs = path.join(this.#dir, f.name);
      const info = await stat(abs);
      const stem = path.basename(f.name, path.extname(f.name));
      // "周杰伦 - 青花瓷" → artist=周杰伦 name=青花瓷
      const m = stem.split(/\s*[-－—]\s*/);
      const artist = m.length > 1 ? m[0].trim() : '';
      const name = m.length > 1 ? m.slice(1).join(' - ').trim() : stem.trim();
      songs.push({
        id: `lib_${norm(name)}`,
        name,
        artist,
        aliases: [stem],
        file: f.name,
        durationMs: await probeDurationMs(abs, info.size),
        bytes: info.size,
      });
    }

    this.#songs = songs;
    await writeFile(this.#indexFile, JSON.stringify({ version: 1, dir: this.#dir, songs }, null, 2) + '\n', 'utf8');
    log.info(`曲库：扫描到 ${songs.length} 首 → ${this.#indexFile}`);
    return songs;
  }

  list() {
    return this.#songs.map((s) => ({ id: s.id, name: s.name, artist: s.artist, durationMs: s.durationMs }));
  }

  get(id) {
    return this.#songs.find((s) => s.id === id) ?? null;
  }

  /** 解析成可直接播放的绝对路径 + 时长。 */
  resolve(song) {
    if (!song) return null;
    return { ...song, abs: path.resolve(this.#dir, song.file) };
  }

  /** 歌名查找：名称/别名/歌手 都能命中。 */
  find(query) {
    const q = norm(query);
    if (!q) return null;

    // 1. 完全相同
    let hit = this.#songs.find((s) => norm(s.name) === q || norm(`${s.artist}${s.name}`) === q);
    // 2. 双向子串
    if (!hit) hit = this.#songs.find((s) => norm(s.name).includes(q) || q.includes(norm(s.name)));
    // 3. 别名
    if (!hit) hit = this.#songs.find((s) => (s.aliases ?? []).some((a) => norm(a).includes(q)));
    return hit ?? null;
  }

  /** 随机（避开最近播过的），没指定歌名时用。 */
  random({ avoid = [], } = {}) {
    const avoidSet = new Set(avoid.map(norm));
    const pool = this.#songs.filter((s) => !avoidSet.has(norm(s.name)));
    const list = pool.length ? pool : this.#songs;
    if (!list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  }

  /**
   * 渲染好的成品入库：复制进曲库目录 + 更新索引。
   * 下一次点同一首就能秒播，不用再等几分钟。
   */
  async addCover({ name, artist = '', file, durationMs }) {
    if (!file || !existsSync(file)) return null;
    await mkdir(this.#dir, { recursive: true });
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const dest = path.join(this.#dir, `${safe}.mp3`);
    try {
      await copyFile(file, dest);
    } catch (err) {
      log.warn('成品入库复制失败：', err?.message);
      return null;
    }
    const entry = {
      id: `cover_${norm(name)}`,
      name,
      artist,
      aliases: [safe],
      file: `${safe}.mp3`,
      durationMs,
    };
    const idx = this.#songs.findIndex((x) => norm(x.name) === norm(name));
    if (idx >= 0) this.#songs[idx] = entry;
    else this.#songs.push(entry);
    await writeFile(this.#indexFile, JSON.stringify({ version: 1, dir: this.#dir, songs: this.#songs }, null, 2) + '\n', 'utf8');
    log.info(`成品入库：${name} → ${dest}`);
    return { ...entry, abs: dest };
  }

  get size() {
    return this.#songs.length;
  }
}

export async function openLibrary(cfg) {
  return Library.open({ dir: cfg.libraryDir, stateDir: cfg.stateDir, rebuild: cfg.rebuildIndex });
}
