import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'leak-check.mjs');

// Roda o leak-check num diretório temporário com um único arquivo.
function run(content, denylist) {
  const dir = mkdtempSync(join(tmpdir(), 'leak-'));
  try {
    writeFileSync(join(dir, 'a.txt'), content);
    const env = { ...process.env };
    delete env.LEAK_DENYLIST;
    if (denylist !== undefined) {
      writeFileSync(join(dir, '..', `${dir.split(/[\\/]/).pop()}.deny`), denylist);
      env.LEAK_DENYLIST = `${dir}.deny`;
    }
    const r = spawnSync(process.execPath, [script, '--all'], { cwd: dir, env, encoding: 'utf8' });
    if (denylist !== undefined) rmSync(`${dir}.deny`, { force: true });
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('telefone com cara de real reprova', () => {
  const r = run(`tel: ${'55' + '11987654321'}\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.txt:1: telefone/);
});

test('telefone e JID da allowlist passam', () => {
  const r = run(`tel: 55119999900${'01'}\ngrupo: 12036300000000${'01'}@g.us\ncontato: alguem@example.com\n`);
  assert.equal(r.status, 0, r.stderr);
});

test('e-mail e IP públicos reprovam, IP local passa', () => {
  assert.equal(run('a: pessoa@' + 'empresa.com.br\n').status, 1);
  assert.equal(run('a: 8.8.' + '8.8\n').status, 1);
  assert.equal(run('a: 127.0.0.1 e 192.168.0.10\n').status, 0);
});

test('termo do denylist reprova só quando LEAK_DENYLIST aponta para ele', () => {
  const content = 'um Termo-Proibido-Xyz aqui\n';
  assert.equal(run(content).status, 0);
  const r = run(content, 'termo-proibido-xyz\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.txt:1: termo da lista proibida/);
});
