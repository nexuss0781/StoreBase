'use strict';

const {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { tmpdir } = require('node:os');

const CATEGORIES = Object.freeze([
  'Education',
  'Social',
  'Productivity',
  'Communication',
  'Entertainment',
  'Games',
  'Business',
  'Shopping',
  'Finance',
  'Utilities',
  'Health & Fitness',
  'Travel & Navigation',
  'AI & Machine Learning',
]);

function fail(message) {
  throw new Error(message);
}

function normalizeFingerprint(value) {
  return String(value || '').replace(/[^a-f\d]/gi, '').toUpperCase();
}

function slugify(value) {
  const slug = String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `app-${createHash('sha256').update(String(value)).digest('hex').slice(0, 10)}`;
}

async function requireFile(value, label, cwd) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`);
  const resolved = path.resolve(cwd, value.trim());
  let details;
  try {
    details = await stat(resolved);
  } catch {
    fail(`${label} does not exist: ${resolved}`);
  }
  if (!details.isFile() || details.size === 0) fail(`${label} must be a non-empty file: ${resolved}`);
  return resolved;
}

async function detectImageExtension(filePath) {
  const handle = await require('node:fs/promises').open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
    if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return '.webp';
    fail('Avatar must be a PNG, JPEG, or WebP image.');
  } finally {
    await handle.close();
  }
}

async function validateInput(raw, options = {}) {
  const cwd = options.cwd || process.cwd();
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) fail('App name is required.');
  if ([...name].length > 100) fail('App name must be 100 characters or fewer.');

  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(version)) {
    fail('Version is required and must be 1–64 safe characters (letters, numbers, dot, plus, underscore, or hyphen).');
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description) fail('Description is required.');
  if (description.length > 1000) fail('Description must be 1000 characters or fewer.');

  const categoryText = typeof raw.category === 'string' ? raw.category.trim() : '';
  const category = CATEGORIES.find((item) => item.toLocaleLowerCase('en') === categoryText.toLocaleLowerCase('en'));
  if (!category) fail(`Category must match one of: ${CATEGORIES.join(', ')}.`);

  const avatarPath = await requireFile(raw.avatar, 'Avatar file', cwd);
  const avatarExtension = await detectImageExtension(avatarPath);
  const apkPath = await requireFile(raw.apk, 'APK file', cwd);
  if (path.extname(apkPath).toLowerCase() !== '.apk') fail('APK file must have the .apk extension.');
  const apkHandle = await require('node:fs/promises').open(apkPath, 'r');
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await apkHandle.read(signature, 0, 4, 0);
    if (bytesRead !== 4 || signature.toString('hex') !== '504b0304') fail('APK file does not have a valid ZIP/APK header.');
  } finally {
    await apkHandle.close();
  }
  const keystorePath = await requireFile(raw.keystore, 'Signed keystore file', cwd);

  return {
    id: slugify(name),
    name,
    avatarPath,
    avatarExtension,
    version,
    apkPath,
    category,
    description,
    keystorePath,
    alias: typeof raw.alias === 'string' && raw.alias.trim() ? raw.alias.trim() : undefined,
  };
}

function runTool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    ...options,
  });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    fail(`${command} failed${details ? `:\n${details}` : '.'}`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function parseKeystoreEntries(output) {
  const blocks = output.split(/(?=Alias name:\s*)/i).filter((block) => /Alias name:/i.test(block));
  return blocks.flatMap((block) => {
    const alias = block.match(/Alias name:\s*([^\r\n]+)/i)?.[1]?.trim();
    const entryType = block.match(/Entry type:\s*([^\r\n]+)/i)?.[1]?.trim();
    const fingerprints = [...block.matchAll(/SHA256:\s*([A-F\d:]+)/gi)].map((match) => normalizeFingerprint(match[1]));
    if (!alias || !/PrivateKeyEntry/i.test(entryType || '') || fingerprints.length === 0) return [];
    return [{ alias, fingerprint: fingerprints[0] }];
  });
}

function parseApkSignerFingerprints(output) {
  return [...output.matchAll(/Signer\s+#\d+\s+certificate\s+SHA-256\s+digest:\s*([a-f\d:]+)/gi)]
    .map((match) => normalizeFingerprint(match[1]))
    .filter((fingerprint) => fingerprint.length === 64);
}

async function inspectKeystore(keystorePath, password) {
  if (typeof password !== 'string') fail('A keystore password is required to verify the signing certificate.');
  if (password.includes('\n') || password.includes('\r')) fail('Keystore passwords cannot contain line breaks.');
  const fs = require('node:fs');
  const folder = await require('node:fs/promises').mkdtemp(path.join(tmpdir(), 'storebase-keystore-'));
  const passwordFile = path.join(folder, 'password');
  try {
    await writeFile(passwordFile, `${password}\n`, { mode: 0o600, flag: 'wx' });
    const output = runTool('keytool', [
      '-J-Duser.language=en',
      '-J-Duser.country=US',
      '-list',
      '-v',
      '-keystore',
      keystorePath,
      '-storepass:file',
      passwordFile,
    ]);
    const entries = parseKeystoreEntries(output);
    if (!entries.length) fail('The keystore has no readable private-key entry with a SHA-256 certificate.');
    return entries;
  } finally {
    // Best-effort overwrite before removal; the temporary directory is private (0700).
    try {
      const fd = fs.openSync(passwordFile, 'r+');
      const size = fs.fstatSync(fd).size;
      fs.writeSync(fd, Buffer.alloc(size));
      fs.closeSync(fd);
    } catch {}
    await rm(folder, { recursive: true, force: true });
  }
}

function findApksigner() {
  const fs = require('node:fs');
  const pathCandidates = [];
  if (process.env.PATH) {
    for (const folder of process.env.PATH.split(path.delimiter)) pathCandidates.push(path.join(folder, 'apksigner'));
  }
  const sdkRoots = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(require('node:os').homedir(), 'Android', 'Sdk'),
    '/usr/lib/android-sdk',
    '/opt/android-sdk',
  ].filter(Boolean);
  for (const root of sdkRoots) {
    const buildTools = path.join(root, 'build-tools');
    try {
      const versions = fs.readdirSync(buildTools).sort((a, b) => {
        const aa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
        const bb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
        for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
          const difference = (bb[i] || 0) - (aa[i] || 0);
          if (difference) return difference;
        }
        return 0;
      });
      for (const version of versions) pathCandidates.push(path.join(buildTools, version, 'apksigner'));
    } catch {}
  }
  const found = pathCandidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (!found) fail('Android apksigner was not found. Install Android SDK Build Tools or add apksigner to PATH.');
  return found;
}

function verifyApkSignature(apkPath, keystoreEntry) {
  const apksigner = findApksigner();
  const output = runTool(apksigner, ['verify', '--verbose', '--print-certs', apkPath]);
  const fingerprints = parseApkSignerFingerprints(output);
  if (!fingerprints.length) fail('apksigner did not report a SHA-256 signer certificate for this APK.');
  const matchingFingerprint = fingerprints.find((fingerprint) => fingerprint === normalizeFingerprint(keystoreEntry.fingerprint));
  if (!matchingFingerprint) {
    fail(`APK signer does not match keystore alias "${keystoreEntry.alias}". The APK was not added to the app list.`);
  }
  return matchingFingerprint;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function toCatalogPath(fromDirectory, absolutePath) {
  return path.relative(fromDirectory, absolutePath).split(path.sep).join('/');
}

async function copyIfMissing(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await stat(destination);
    return;
  } catch {}
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`;
  try {
    await copyFile(source, temporary);
    try {
      await rename(temporary, destination);
    } catch (error) {
      // A concurrent publish of the identical content-addressed asset is harmless.
      try { await stat(destination); } catch { throw error; }
      await rm(temporary, { force: true });
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function releaseApp(input, options = {}) {
  const catalogPath = path.resolve(options.catalogPath || path.join(process.cwd(), 'storebase-app-list.json'));
  const catalogDirectory = path.dirname(catalogPath);
  const assetsDirectory = path.resolve(options.assetsDir || path.join(catalogDirectory, 'storebase-app-assets'));
  const certificate = normalizeFingerprint(options.signingCertificateSha256);
  if (certificate.length !== 64) fail('A verified 64-character SHA-256 signing certificate is required before release.');

  let current = { schemaVersion: 1, apps: [] };
  try {
    current = JSON.parse(await readFile(catalogPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') fail(`Cannot read app-list catalog ${catalogPath}: ${error.message}`);
  }
  if (!current || current.schemaVersion !== 1 || !Array.isArray(current.apps)) {
    fail(`Catalog ${catalogPath} must be JSON with schemaVersion: 1 and an apps array.`);
  }
  const conflicting = current.apps.find((app) => app.id === input.id && app.name !== input.name);
  if (conflicting) fail(`App id "${input.id}" is already used by "${conflicting.name}".`);

  const apkHash = await sha256File(input.apkPath);
  const avatarHash = await sha256File(input.avatarPath);
  const versionDirectory = path.join(assetsDirectory, input.id, input.version);
  const apkDestination = path.join(versionDirectory, `app-${apkHash}.apk`);
  const avatarDestination = path.join(versionDirectory, `avatar-${avatarHash}${input.avatarExtension}`);

  // Content-addressed paths ensure that a failed catalog write never corrupts the previous listing.
  await copyIfMissing(input.apkPath, apkDestination);
  await copyIfMissing(input.avatarPath, avatarDestination);

  const appRecord = {
    id: input.id,
    name: input.name,
    avatar: toCatalogPath(catalogDirectory, avatarDestination),
    version: input.version,
    apk: toCatalogPath(catalogDirectory, apkDestination),
    category: input.category,
    description: input.description,
    signingCertificateSha256: certificate,
    publishedAt: options.publishedAt || new Date().toISOString(),
  };
  const apps = current.apps.filter((app) => app.id !== input.id);
  apps.push(appRecord);
  apps.sort((a, b) => a.name.localeCompare(b.name));
  const nextCatalog = { ...current, schemaVersion: 1, updatedAt: appRecord.publishedAt, apps };
  await writeJsonAtomically(catalogPath, nextCatalog);

  return {
    app: appRecord,
    catalogPath,
    assetsDirectory,
    catalog: nextCatalog,
  };
}

module.exports = {
  CATEGORIES,
  findApksigner,
  normalizeFingerprint,
  parseApkSignerFingerprints,
  parseKeystoreEntries,
  releaseApp,
  slugify,
  validateInput,
  verifyApkSignature,
  inspectKeystore,
};
