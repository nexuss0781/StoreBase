'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { getPublisherEnvironment, readHiddenToken } = require('../lib/publisher-token');

function fakeTerminal() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.rawMode = false;
  input.setRawMode = (enabled) => { input.rawMode = enabled; };
  input.setEncoding = () => {};
  input.resume = () => {};
  input.pause = () => {};
  const output = { isTTY: true, text: '', write(value) { this.text += value; } };
  return { input, output };
}

test('uses a valid publisher token from environment without prompting or mutating it', async () => {
  const env = {
    STOREBASE_GATEWAY_PUBLISH_TOKEN: 'a'.repeat(48),
    STOREBASE_GATEWAY_URL: 'https://gateway.example.test',
    OTHER_SECRET: 'leave-out-of-request-env',
  };
  const runtimeEnv = await getPublisherEnvironment(env);
  assert.deepEqual(runtimeEnv, {
    STOREBASE_GATEWAY_PUBLISH_TOKEN: 'a'.repeat(48),
    STOREBASE_GATEWAY_URL: 'https://gateway.example.test',
  });
  assert.equal(env.STOREBASE_GATEWAY_PUBLISH_TOKEN, 'a'.repeat(48));
});

test('rejects a malformed environment token instead of silently prompting', async () => {
  await assert.rejects(
    getPublisherEnvironment({ STOREBASE_GATEWAY_PUBLISH_TOKEN: 'too-short' }),
    /32–256 character token/,
  );
});

test('requires an environment token for non-interactive runs', async () => {
  await assert.rejects(getPublisherEnvironment({}, { isTTY: false }), /non-interactive use/);
});

test('reads a missing token through a hidden prompt and never echoes it', async () => {
  const { input, output } = fakeTerminal();
  const token = 'abc_DEF-0123456789'.repeat(3);
  const pending = readHiddenToken(input, output);
  setImmediate(() => input.emit('data', `${token}\n`));
  assert.equal(await pending, token);
  assert.equal(output.text, 'StoreBase gateway publisher key (input hidden): \n');
  assert.equal(input.rawMode, false);
});

test('rejects an invalid token entered at the hidden prompt', async () => {
  const { input, output } = fakeTerminal();
  const pending = getPublisherEnvironment({}, input, output);
  setImmediate(() => input.emit('data', 'short-token\n'));
  await assert.rejects(pending, /32–256 character token/);
  assert.equal(output.text, 'StoreBase gateway publisher key (input hidden): \n');
});
