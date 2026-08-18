// Runs every test in this directory and reports one line each.
//
//   npm test              all of them
//   npm test stops plan   only files whose name contains "stops" or "plan"
//
// There is no framework. Each test file is a plain script that prints its own
// checks and exits non-zero on failure, which is why they can also be run one
// at a time with bare node when one of them is being debugged:
//
//   node --import ./tests/register.mjs tests/stopplan.test.mjs
//
// Two environment quirks are handled here rather than in every file. The
// loader teaches Node the extensionless imports the app source uses, and
// NODE_PATH points at tests/stubs so a checkout without vps-bot/node_modules
// installed can still load the bot modules — node_modules wins when it is
// there, because NODE_PATH is only consulted after it.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);

const files = readdirSync(HERE)
  .filter(f => /\.test\.(mjs|cjs)$/.test(f))
  .filter(f => !filters.length || filters.some(x => f.includes(x)))
  .sort();

if (!files.length) {
  console.error(filters.length ? `no test matches ${filters.join(', ')}` : 'no tests found');
  process.exit(1);
}

const env = { ...process.env, NODE_PATH: join(HERE, 'stubs') };

function run(file) {
  const args = file.endsWith('.mjs')
    ? ['--import', join(HERE, 'register.mjs'), join(HERE, file)]
    : [join(HERE, file)];
  return new Promise(resolve => {
    const p = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (out += d));
    p.on('close', code => resolve({ file, code, out }));
  });
}

let failed = 0;
const detail = [];
for (const file of files) {
  const r = await run(file);
  // The last non-empty line is the file's own verdict.
  const last = r.out.trim().split('\n').filter(Boolean).pop() || '(no output)';
  const ok = r.code === 0;
  if (!ok) { failed++; detail.push(r); }
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${file.padEnd(26)} ${ok ? last : last.slice(0, 90)}`);
}

// Only failures get their full output, so a green run stays one screen.
for (const r of detail) {
  console.log(`\n───── ${r.file} ─────`);
  console.log(r.out.split('\n').filter(l => !/^\s*ok\s/.test(l)).join('\n').trim());
}

console.log(failed ? `\n${failed} of ${files.length} FAILED` : `\nall ${files.length} passed`);
process.exit(failed ? 1 : 0);
