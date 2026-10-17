'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { DOCUMENTS } = require('../bin/storebase-skill');

test('npm allowlist includes CLI and complete skill but excludes planted credentials and application artifacts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storebase-pack-safety-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '..');
  for (const name of ['package.json', 'README.md', '.npmignore']) await fs.copyFile(path.join(source, name), path.join(root, name));
  for (const dir of ['bin', 'lib']) {
    await fs.mkdir(path.join(root, dir));
    for (const name of await fs.readdir(path.join(source, dir))) {
      if (name.endsWith('.js')) await fs.copyFile(path.join(source, dir, name), path.join(root, dir, name));
    }
  }
  const skillFiles = DOCUMENTS.map(name => `skills/storebase/${name}`);
  for (const name of skillFiles) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.copyFile(path.join(source, name), path.join(root, name));
  }
  const forbidden = [
    '.env', '.npmrc', 'release.jks', 'release.keystore', 'signing-vault.json',
    'lib/release.jks', 'lib/local.p12', 'lib/local.pfx', 'lib/local.pem', 'lib/.env',
    'bin/signing-vault.json', 'lib/local-credentials/password.txt', 'release.apk',
    'skills/storebase/.env', 'skills/storebase/signing-vault.json',
    'skills/storebase/references/session.session', 'skills/storebase/references/release.apk',
    'skills/storebase/references/release.sbd', 'skills/storebase/references/private-key.pem',
    'skills/storebase/references/extra.md', 'skills/storebase/references/secret.js',
    'skills/storebase/references/local-credentials/password.txt',
  ];
  for (const name of forbidden) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'SYNTHETIC_CREDENTIAL_CANARY');
  }
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map(f => f.path);
  assert.ok(files.includes('bin/storebase-keystore.js'));
  assert.ok(files.includes('bin/storebase-skill.js'));
  assert.ok(files.includes('lib/signing-vault.js'));
  for (const name of skillFiles) assert.ok(files.includes(name), `Missing skill document: ${name}`);
  for (const name of forbidden) assert.ok(!files.includes(name), `Unexpected credential/artifact file: ${name}`);
  assert.ok(files.every(name => name === 'package.json' || name === 'README.md' || /^(bin|lib)\/[^/]+\.js$/.test(name) || skillFiles.includes(name)));
});
