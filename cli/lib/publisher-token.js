'use strict';
const { stdin, stdout } = require('node:process');
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

function fail(message) {
  throw new Error(message);
}

function readHiddenToken(input = stdin, output = stdout) {
  if (!input.isTTY || typeof input.setRawMode !== 'function' || !output.isTTY) {
    return Promise.reject(new Error('Set STOREBASE_GATEWAY_PUBLISH_TOKEN in the environment for non-interactive use.'));
  }
  return new Promise((resolve, reject) => {
    let value = '';
    let finished = false;
    const cleanup = () => {
      input.removeListener('data', onData);
      try { input.setRawMode(false); } catch {}
      input.pause();
      output.write('\n');
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') return finish(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && value.length < 256) value += character;
      }
    };
    output.write('StoreBase gateway publisher key (input hidden): ');
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    input.on('data', onData);
  });
}

async function getPublisherEnvironment(env = process.env, input = stdin, output = stdout) {
  let token = env.STOREBASE_GATEWAY_PUBLISH_TOKEN;
  if (token === undefined || token === '') token = await readHiddenToken(input, output);
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    fail('STOREBASE_GATEWAY_PUBLISH_TOKEN must be a high-entropy 32–256 character token using letters, numbers, underscores, or hyphens.');
  }
  const runtimeEnv = { STOREBASE_GATEWAY_PUBLISH_TOKEN: token };
  if (typeof env.STOREBASE_GATEWAY_URL === 'string' && env.STOREBASE_GATEWAY_URL) {
    runtimeEnv.STOREBASE_GATEWAY_URL = env.STOREBASE_GATEWAY_URL;
  }
  return runtimeEnv;
}

module.exports = { TOKEN_PATTERN, getPublisherEnvironment, readHiddenToken };
