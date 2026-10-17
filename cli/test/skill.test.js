'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parseArguments, DOCUMENTS } = require('../bin/storebase-skill');
const cli = path.resolve(__dirname, '../bin/storebase-skill.js');

function run(args) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' }); }

test('skill command parses only supported nonsecret arguments', () => {
  assert.equal(parseArguments([]).command, 'help');
  assert.equal(parseArguments(['path']).command, 'path');
  assert.equal(parseArguments(['install', '--dir', './skills']).command, 'install');
  for (const args of [['path','extra'], ['install'], ['install','--dir',''], ['install','--dir','--force'], ['install','--dir','x','--force']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('bundled skill has frontmatter, complete local references and no template placeholders', async () => {
  const result = run(['path']);
  assert.equal(result.status, 0, result.stderr);
  const entry = result.stdout.trim();
  const text = await fs.readFile(entry, 'utf8');
  assert.match(text, /^---\r?\nname: storebase\r?\ndescription: .+\r?\n---/);
  assert.ok(text.split('\n').length < 500);
  for (const name of DOCUMENTS) {
    const content = await fs.readFile(path.join(path.dirname(entry), name), 'utf8');
    assert.ok(content.length > 500, name);
    assert.doesNotMatch(content, /\[TODO|SYNTHETIC_CREDENTIAL_CANARY/);
  }
  for (const match of text.matchAll(/\]\((references\/[^)]+)\)/g)) await fs.access(path.join(path.dirname(entry), match[1]));
});

test('skill installer handles spaces and Unicode, copies only documented files and refuses overwrite', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storebase-skill-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'agent skills café');
  const result = run(['install', '--dir', target]);
  assert.equal(result.status, 0, result.stderr);
  for (const name of DOCUMENTS) {
    const installed = await fs.readFile(path.join(target, 'storebase', name));
    const bundled = await fs.readFile(path.resolve(__dirname, '../skills/storebase', name));
    assert.deepEqual(installed, bundled);
  }
  const sentinel = path.join(target, 'storebase', 'keep.txt');
  await fs.writeFile(sentinel, 'keep me');
  const again = run(['install', '--dir', target]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep me');
});

test('skill installer refuses a preexisting symlink destination without touching its target', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storebase-skill-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const external = path.join(root, 'external');
  const skills = path.join(root, 'skills');
  await fs.mkdir(external); await fs.mkdir(skills);
  await fs.symlink(external, path.join(skills, 'storebase'));
  const result = run(['install', '--dir', skills]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await fs.readdir(external), []);
});
