'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const copies = [
  ['packages/domain/index.js', 'miniapp/shared/domain.js'],
  ['packages/domain/index.js', 'cloudfunctions/api/shared/domain.js'],
  ['packages/migration/index.js', 'cloudfunctions/api/shared/migration.js']
];

for (const [source, target] of copies) {
  const sourcePath = path.join(root, source);
  const targetPath = path.join(root, target);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

console.log(`Shared modules synchronized (${copies.length} files).`);
