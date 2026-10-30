/**
 * 重建曲库索引。
 *
 *   node tools/make-index.mjs
 *
 * 扫描 `songs.libraryDir` 下的音频文件，用 ffprobe 读时长，写 `index.json`。
 * 之后的查找/随机都走索引，不再每次扫目录。
 */
import { load, resolved } from '../src/config.mjs';
import { Library } from '../src/songs/library.mjs';

const cfg = await load();
const lib = await Library.open({
  dir: resolved(cfg.songs.libraryDir),
  stateDir: resolved(cfg.songs.stateDir),
  rebuild: true,
});

const songs = lib.list();
console.log(`\n曲库目录：${resolved(cfg.songs.libraryDir)}`);
console.log(`索引文件：${resolved(cfg.songs.stateDir)}/index.json`);
console.log(`共 ${songs.length} 首：`);
for (const s of songs) {
  const sec = Math.round((s.durationMs ?? 0) / 1000);
  console.log(`  ${s.name}${s.artist ? ` — ${s.artist}` : ''}  ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
}
if (!songs.length) console.log('  （空）把 mp3/wav 放进这个目录再跑一次');
