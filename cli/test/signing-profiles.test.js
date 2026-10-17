'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { hidden } = require('../lib/secure-prompt');
const { importProfile, entryForProfile, profileName, loadProfileEntry } = require('../lib/signing-profiles');
const { parseArguments } = require('../bin/storebase-keystore');
const { parseArguments: parsePublish } = require('../bin/storebase-publish');
const { validateInput } = require('../lib/publisher');
const CERT = 'AB'.repeat(32);

test('keystore command parses lifecycle options and never accepts password arguments', () => {
  assert.deepEqual(parseArguments(['import', 'release', '--file', 'test.jks', '--alias', 'release', '--replace']),
    { command:'import', name:'release', file:'test.jks', alias:'release', replace:true });
  for (const command of ['list', 'rekey', 'location']) assert.equal(parseArguments([command]).command, command);
  assert.throws(() => parseArguments(['import','release','--file','x','--password','secret']), /Password arguments/);
  assert.throws(() => parseArguments(['remove','../bad']), /Profile names/);
  assert.throws(() => profileName('constructor'), /Reserved/);
  assert.equal(parsePublish(['--signing-profile','shared']).options['signing-profile'],'shared');
});

test('hidden secret prompt never echoes input and restores raw mode on success/cancellation/EOF', async () => {
  for (const ending of ['\r', '\u0003', 'end']) {
    const input = new EventEmitter(); input.isTTY=true; input.isRaw=false;
    input.setRawMode=(v)=>{input.isRaw=v;}; input.setEncoding=()=>{}; input.resume=()=>{}; input.pause=()=>{};
    let text=''; const output={isTTY:true,write:(s)=>{text+=s;}};
    const promise=hidden('Test password',input,output);
    input.emit('data','synthetic-secret');
    if (ending==='end') input.emit('end'); else input.emit('data',ending);
    if (ending==='\r') assert.equal(await promise,'synthetic-secret'); else await assert.rejects(promise,/cancelled/);
    assert.equal(text.includes('synthetic-secret'),false); assert.equal(input.isRaw,false);
    assert.equal(input.listenerCount('data'),0);
  }
  await assert.rejects(hidden('password',{isTTY:false},{isTTY:false}),/interactive terminal/);
});

test('profile import validates identical private temp bytes then wipes and removes its temp copy', async (t) => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'storebase-profile-test-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'input.jks'); await fs.writeFile(file,'synthetic-keystore'); let temp;
  const profile=await importProfile(file,'store-secret','key-secret','release',{
    inspect:async(p,password)=>{temp=p;assert.equal(password,'store-secret');assert.equal(await fs.readFile(p,'utf8'),'synthetic-keystore');return [{alias:'release',fingerprint:CERT}];},
    verify:async(p,store,alias,key)=>{assert.equal(p,temp);assert.equal(key,'key-secret');},
  });
  assert.equal(profile.keystore,Buffer.from('synthetic-keystore').toString('base64'));
  await assert.rejects(fs.stat(temp),{code:'ENOENT'});
  assert.equal(await fs.readFile(file,'utf8'),'synthetic-keystore');
  const data={profiles:{shared:profile}};
  assert.deepEqual(entryForProfile(data,'shared'),{alias:'release',fingerprint:CERT});
  const entry=await loadProfileEntry('shared',{prompt:async()=> 'synthetic-unlock',vault:{read:async()=>data}});
  assert.deepEqual(entry,{alias:'release',fingerprint:CERT});assert.equal(profile.storePassword,'');assert.equal(profile.keystore,'');
  assert.throws(()=>entryForProfile(data,'missing'),/not found/);
});

test('profile allows app versions without a project keystore and invalid certificate is rejected', async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'storebase-profile-input-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const avatar=path.join(root,'icon.png'),apk=path.join(root,'app.apk');
  await fs.writeFile(avatar,Buffer.from([137,80,78,71,13,10,26,10]));await fs.writeFile(apk,Buffer.from([80,75,3,4]));
  const input={name:'Example',version:'1.0',avatar,apk,category:'Games',description:'Synthetic test'};
  for(const version of ['1.0','2.0']) {
    const result=await validateInput({...input,version},{signingProfile:{alias:'release',fingerprint:CERT}});
    assert.equal(result.keystorePath,undefined);
  }
  await assert.rejects(validateInput(input,{signingProfile:{alias:'release',fingerprint:'bad'}}),/Invalid signing profile/);
});

test('real synthetic JKS import checks both store and private-key passwords without logging either', {skip:spawnSync('keytool',['-help']).error?'Java keytool unavailable':false}, async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'storebase-synthetic-jks-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'test.jks');
  const env={...process.env,SB_TEST_STORE:'synthetic-store-password',SB_TEST_KEY:'synthetic-key-password'};
  const result=spawnSync('keytool',['-genkeypair','-alias','release','-keystore',file,'-storetype','JKS','-keyalg','RSA','-keysize','2048','-validity','1','-dname','CN=StoreBase Synthetic Test','-storepass:env','SB_TEST_STORE','-keypass:env','SB_TEST_KEY'],{env,encoding:'utf8'});
  assert.equal(result.status,0);
  const profile=await importProfile(file,env.SB_TEST_STORE,env.SB_TEST_KEY,'release');
  assert.match(profile.fingerprint,/^[A-F0-9]{64}$/);
  await assert.rejects(importProfile(file,'wrong-password',env.SB_TEST_KEY,'release'),e=>!e.message.includes(env.SB_TEST_KEY)&&/Could not inspect/.test(e.message));
  await assert.rejects(importProfile(file,env.SB_TEST_STORE,'wrong-password','release'),/Could not unlock/);
});
