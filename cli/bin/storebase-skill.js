#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const source = path.resolve(__dirname, '..', 'skills', 'storebase');
const DOCUMENTS = [
  'SKILL.md',
  'references/cli-workflows.md',
  'references/runtime-and-android.md',
  'references/updates-and-development.md',
];

function parseArguments(args) {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) return { command: 'help' };
  if (args.length === 1 && args[0] === 'path') return { command: 'path' };
  if (args.length === 3 && args[0] === 'install' && args[1] === '--dir' && args[2].trim() && !args[2].startsWith('--')) {
    return { command: 'install', root: path.resolve(args[2]) };
  }
  throw new Error('Use storebase-skill path or storebase-skill install --dir <skills-root>.');
}

async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.command === 'help') {
    process.stdout.write(`StoreBase agent skill\n\nUsage:\n  storebase-skill path\n  storebase-skill install --dir <skills-root>\n\npath prints the bundled SKILL.md location. install copies the skill into the\nstorebase child of the chosen root. Existing destinations are never overwritten.\nEnable or reload the skill in your agent separately when required.\n`);
    return;
  }
  if (options.command === 'path') {
    await fs.access(path.join(source, 'SKILL.md'));
    process.stdout.write(`${path.join(source, 'SKILL.md')}\n`);
    return;
  }
  // Read only the explicitly packaged documents, never arbitrary local files.
  const documents = await Promise.all(DOCUMENTS.map(async name => [name, await fs.readFile(path.join(source, name))]));
  await fs.mkdir(options.root, { recursive: true });
  const destination = path.join(options.root, 'storebase');
  try {
    await fs.mkdir(destination);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Skill destination already exists; review or back it up before replacing it: ${destination}`);
    throw error;
  }
  try {
    for (const [name, content] of documents) {
      const file = path.join(destination, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, { flag: 'wx' });
    }
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`StoreBase skill installed: ${path.join(destination, 'SKILL.md')}\nEnable or reload it using your agent's skill settings when required.\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`storebase-skill: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { parseArguments, main, DOCUMENTS };
