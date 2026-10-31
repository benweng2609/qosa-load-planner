#!/usr/bin/env node
// 拉取两个大体积第三方库到 vendor/（发布通道限制未直接入库，此处固定版本+SHA256 校验）
// 用法：node scripts/fetch-vendor.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor');

const FILES = [
  {
    name: 'three.module.js',
    url: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
    sha256: '76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495',
    bytes: 1272972,
  },
  {
    name: 'xlsx.full.min.js',
    url: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    sha256: 'c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99',
    bytes: 881727,
  },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(VENDOR, { recursive: true });
for (const f of FILES) {
  const dest = join(VENDOR, f.name);
  try {
    const cur = statSync(dest);
    if (cur.size === f.bytes && sha256(readFileSync(dest)) === f.sha256) {
      console.log(`✓ ${f.name} 已存在且校验通过，跳过`);
      continue;
    }
  } catch { /* 不存在则下载 */ }
  console.log(`下载 ${f.name} ← ${f.url}`);
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${f.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== f.bytes || sha256(buf) !== f.sha256)
    throw new Error(`${f.name} 校验失败：期望 sha256=${f.sha256}，实际 ${sha256(buf)}`);
  writeFileSync(dest, buf);
  console.log(`✓ ${f.name} 写入并校验通过（${f.bytes} 字节）`);
}
console.log('vendor 就绪');
