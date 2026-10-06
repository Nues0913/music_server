#!/usr/bin/env bash
set -euo pipefail

# Resolve the project independently of the caller's working directory.
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Please install Node.js 22.12+ first.' >&2; exit 1; }

node --input-type=module - "$project_root" <<'NODE'
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const root = process.argv[2];
for (const directory of ['data/db', 'data/audio', 'data/inbox', 'data/container/db', 'data/container/audio', 'data/container/inbox']) {
  mkdirSync(join(root, directory), { recursive: true });
}
// Nginx serves files from this bind mount as an unprivileged user.
chmodSync(join(root, 'data/container/audio'), 0o755);
const rootEnv = join(root, '.env');
const hostEnv = join(root, 'api/.env');
const token = () => randomBytes(32).toString('hex');
const read = path => readFileSync(path, 'utf8');
const line = (text, key) => text.split(/\r?\n/).find(value => value.startsWith(`${key}=`) && value.slice(key.length + 1).trim());
if (!existsSync(rootEnv)) {
  const template = read(join(root, '.env.example'));
  writeFileSync(rootEnv, template.replace(/^API_TOKEN=.*$/m, `API_TOKEN=${token()}`).replace(/^ADMIN_TOKEN=.*$/m, `ADMIN_TOKEN=${token()}`), { mode: 0o600 });
}
const apiLine = line(read(rootEnv), 'API_TOKEN');
if (!apiLine) throw new Error('Root .env must define a non-empty API_TOKEN');
let adminLine = line(read(rootEnv), 'ADMIN_TOKEN');
if (!adminLine) {
  adminLine = `ADMIN_TOKEN=${token()}`;
  appendFileSync(rootEnv, `\n${adminLine}\n`);
}
if (!existsSync(hostEnv)) {
  const template = read(join(root, 'api/.env.example'));
  writeFileSync(hostEnv, template.replace(/^API_TOKEN=.*$/m, () => apiLine).replace(/^ADMIN_TOKEN=.*$/m, () => adminLine), { mode: 0o600 });
} else if (!line(read(hostEnv), 'ADMIN_TOKEN')) {
  appendFileSync(hostEnv, `\n${adminLine}\n`);
}
console.log('Created data directories and missing environment files. Existing settings were preserved.');
NODE
