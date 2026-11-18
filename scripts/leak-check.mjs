// Barra dados privados no repositório. Uso: node scripts/leak-check.mjs [--all]
// Padrão: arquivos do git (rastreados + novos não ignorados). --all: todos fora de node_modules/.next/.git.
// A lista proibida vem só do arquivo apontado por LEAK_DENYLIST (um regex por linha); nunca fica no repo.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const all = process.argv.includes('--all');

const regexLines = (path) =>
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => new RegExp(l, 'i'));

let deny = [];
const denyPath = process.env.LEAK_DENYLIST;
if (denyPath) {
  if (existsSync(denyPath)) deny = regexLines(denyPath);
  else console.error(`aviso: LEAK_DENYLIST aponta para arquivo inexistente, lista proibida ignorada`);
}
const allow = regexLines(join(here, 'leak-allow.txt'));

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);
function walk(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const files = all
  ? walk(cwd)
  : git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      .split('\0')
      .filter((f) => f && existsSync(join(cwd, f)));

const PHONE = /\b55\d{10,11}\b/g;
const JID = /\d+(?::\d+)?@(?:s\.whatsapp\.net|g\.us|lid|c\.us)/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi;
const IPV4 = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d]|\.\d)/g;

const isPublicIp = (ip) => {
  const o = ip.split('.').map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  return !(a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254));
};

const findings = [];
const report = (where, line, reason) => findings.push(`${where}:${line}: ${reason}`);
const allowed = (v) => allow.some((r) => r.test(v));

function scanText(where, text, patterns) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    for (const r of deny) if (r.test(line)) report(where, n, `termo da lista proibida (${r.source.length} caracteres de regex)`);
    if (!patterns) return;
    const jids = new Set();
    for (const [re, kind] of [
      [JID, 'JID'],
      [PHONE, 'telefone'],
      [EMAIL, 'e-mail'],
      [IPV4, 'IPv4 público'],
    ]) {
      for (const m of line.matchAll(re)) {
        const v = m[0];
        if (kind === 'JID') jids.add(v);
        if (kind === 'e-mail' && jids.has(v)) continue; // já avaliado como JID
        if (kind === 'IPv4 público' && !isPublicIp(v)) continue;
        if (!allowed(v)) report(where, n, `${kind} fora da allowlist: ${v}`);
      }
    }
  });
}

for (const f of files) {
  for (const r of deny) if (r.test(f)) report(f, 0, 'caminho casa com a lista proibida');
  const buf = readFileSync(join(cwd, f));
  if (buf.subarray(0, 8000).includes(0)) continue; // binário
  scanText(f, buf.toString('utf8'), basename(f) !== 'pnpm-lock.yaml');
}

if (deny.length) scanText('git-log', git(['log', '--format=%B']), false);

if (findings.length) {
  console.error(findings.join('\n'));
  console.error(`\nleak-check: ${findings.length} achado(s)`);
  process.exit(1);
}
console.log('leak-check: 0 achados');
