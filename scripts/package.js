import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
// Importing icons.js builds the small, code-drawn extension icons before packaging.
import { crc32 } from './icons.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const name = `group-share-assistant-${manifest.version}`;
const files = ['manifest.json', 'background.js', 'coordinator.js', 'core.js', 'adapter.js', 'panel.html', 'panel.css', 'panel.js', 'README.md', 'PRIVACY.md', ...[16,32,48,128].map(n => `icons/${n}.png`)];
const out = join(root, 'dist', name); await mkdir(out, { recursive: true });
const local = [], central = []; let offset = 0;
for (const file of files) {
  const bytes = await readFile(join(root, file)), packed = deflateRawSync(bytes), filename = Buffer.from(`${name}/${file}`), crc = crc32(bytes);
  await mkdir(dirname(join(out, file)), { recursive: true }); await copyFile(join(root, file), join(out, file));
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
  local.push(header, filename, packed);
  const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0x21, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42); central.push(entry, filename); offset += header.length + filename.length + packed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zipPath = join(root, 'dist', `${name}.zip`); await writeFile(zipPath, Buffer.concat([...local, directory, end]));
console.log(`Unpacked extension: ${out}\nZIP: ${zipPath}`);
