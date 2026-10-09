import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { createMaintenanceDatabaseConfig } from './database-connection.mjs';

const { Pool } = pg;
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.resolve(backendRoot, '.env') });
const repoRoot = path.resolve(backendRoot, '..');
const manifestPath = path.resolve(backendRoot, 'config/homepage-image-paths.txt');
const imageRoot = path.resolve(repoRoot, 'frontend/images');
const allowed = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]);
const maxBytes = 25 * 1024 * 1024;

function validSignature(bytes, mime) {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

const pool = new Pool(createMaintenanceDatabaseConfig(process.env, 2));

try {
  const paths = (await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const assets = paths.map((sourcePath) => ({ sourcePath, file: path.resolve(repoRoot, sourcePath) }));
  let imported = 0;
  let skipped = 0;
  let totalBytes = 0;
  for (const { sourcePath, file } of assets) {
    const relativePath = path.relative(imageRoot, file);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`Manifest path escapes frontend/images: ${sourcePath}`);
    }
    const info = await stat(file);
    const mime = allowed.get(path.extname(file).toLowerCase());
    if (info.size > maxBytes) throw new Error(`${sourcePath} exceeds the 25 MB database asset limit.`);
    const bytes = await readFile(file);
    if (!validSignature(bytes, mime)) throw new Error(`${sourcePath} has invalid ${mime} file contents.`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const existing = await pool.query('SELECT encode(digest(image_data, \'sha256\'), \'hex\') AS digest FROM media_assets WHERE source_path = $1', [sourcePath]);
    if (existing.rows[0]?.digest === digest) { skipped++; continue; }
    await pool.query(
      `INSERT INTO media_assets (original_name, mime_type, byte_size, image_data, alt_text, source_path)
       VALUES ($1, $2, $3, $4, '', $5)
       ON CONFLICT (source_path) WHERE source_path IS NOT NULL
       DO UPDATE SET original_name = EXCLUDED.original_name, mime_type = EXCLUDED.mime_type,
         byte_size = EXCLUDED.byte_size, image_data = EXCLUDED.image_data, created_at = NOW()`,
      [path.basename(file), mime, bytes.length, bytes, sourcePath],
    );
    imported++;
    totalBytes += bytes.length;
  }
  process.stdout.write(`Site image import complete: ${imported} inserted/updated, ${skipped} unchanged, ${assets.length} checked, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB written.\n`);
} finally {
  await pool.end();
}
