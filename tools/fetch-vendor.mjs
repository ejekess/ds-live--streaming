import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const out = 'vendor/_downloads';
await mkdir(out, { recursive: true });

const jobs = [
  ['whale-girl.tar.gz', 'https://codeload.github.com/andersen216/dsh-whale-girl-live2d/tar.gz/refs/heads/main'],
  ['douyin-fetcher.tar.gz', 'https://codeload.github.com/saermart/DouyinLiveWebFetcher/tar.gz/refs/heads/main'],
];

for (const [file, url] of jobs) {
  const r = await fetch(url, { headers: { 'user-agent': 'fetch' } });
  if (!r.ok) { console.log('FAIL', file, r.status); continue; }
  await pipeline(Readable.fromWeb(r.body), createWriteStream(`${out}/${file}`));
  const s = await stat(`${out}/${file}`);
  console.log(`OK ${file} ${(s.size / 1e6).toFixed(2)}MB`);
}
