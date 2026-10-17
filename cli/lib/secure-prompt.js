'use strict';
const { stdin, stdout } = require('node:process');
const { createInterface } = require('node:readline/promises');

function hidden(label, input = stdin, output = stdout) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('Signing secrets require an interactive terminal; no password arguments or project files are accepted.'));
  }
  return new Promise((resolve, reject) => {
    let value = '';
    let done = false;
    const wasRaw = Boolean(input.isRaw);
    const finish = (error) => {
      if (done) return;
      done = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onEnd);
      try { input.setRawMode(wasRaw); } catch {}
      input.pause();
      output.write('\n');
      const result = value;
      value = '';
      if (error) reject(error); else resolve(result);
    };
    const onEnd = () => finish(new Error('Secret input cancelled.'));
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\u0003' || ch === '\u0004') return onEnd();
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else if (ch >= ' ' && ch !== '\u001b') {
          if (value.length >= 4096) return finish(new Error('Secret input is too long.'));
          value += ch;
        }
      }
    };
    output.write(`${label} (input hidden): `);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onEnd);
    try { input.setRawMode(true); input.resume(); } catch { onEnd(); }
  });
}

async function question(label) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('This operation requires an interactive terminal.');
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(label)).trim(); } finally { rl.close(); }
}

async function newPassphrase() {
  const passphrase = await hidden('New vault passphrase (at least 12 characters)');
  if ([...passphrase].length < 12) throw new Error('Vault passphrase must be at least 12 characters.');
  const confirm = await hidden('Confirm vault passphrase');
  if (passphrase !== confirm) throw new Error('Vault passphrases do not match.');
  return passphrase;
}
module.exports = { hidden, question, newPassphrase };
