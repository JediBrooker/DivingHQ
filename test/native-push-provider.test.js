const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {generateKeyPairSync}=require('node:crypto');
const {createNativePushProvider}=require('../lib/native-push-provider');
const {validateRegistration}=require('../lib/native-push');

test('missing/invalid provider credentials fail closed and never use ambient Google credentials',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dhq-push-'));
 try{
  const invalid=path.join(dir,'key');fs.writeFileSync(invalid,'bad PEM');
  const service=path.join(dir,'service.json');fs.writeFileSync(service,JSON.stringify({project_id:'test-only',client_email:'test@example.com',private_key:'bad PEM'}));
  const p=createNativePushProvider({env:{APNS_KEY_PATH:invalid,APNS_KEY_ID:'k',APNS_TEAM_ID:'t',FCM_SERVICE_ACCOUNT_PATH:service}});
  assert.deepEqual(p.configured,{ios:false,android:false});
  assert.equal((await p.send({platform:'android'},{})).accepted,false);
  assert.deepEqual(createNativePushProvider({env:{GOOGLE_APPLICATION_CREDENTIALS:service}}).configured,{ios:false,android:false});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('APNs validates key curve and development is disabled for production-only credentials',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dhq-push-'));
 try{
  const keyPath=path.join(dir,'key');const pem=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});fs.writeFileSync(keyPath,pem);
  const p=createNativePushProvider({env:{APNS_KEY_PATH:keyPath,APNS_KEY_ID:'k',APNS_TEAM_ID:'t'}});
  assert.equal(p.configured.ios,true);
  assert.deepEqual(await p.send({platform:'ios',environment:'development'},{}),{accepted:false,reason:'environment_unconfigured'});
  fs.writeFileSync(keyPath,generateKeyPairSync('ec',{namedCurve:'secp384r1'}).privateKey.export({type:'pkcs8',format:'pem'}));
  assert.equal(createNativePushProvider({env:{APNS_KEY_PATH:keyPath,APNS_KEY_ID:'k',APNS_TEAM_ID:'t'}}).configured.ios,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('native registration rejects malformed tokens, identities and revisions',()=>{
 const valid={id:'11111111-1111-4111-8111-111111111111',revoke_key:'a'.repeat(64),platform:'ios',environment:'production',token:'b'.repeat(64),revision:1};
 validateRegistration(valid);
 for(const patch of [{id:[]},{token:'../../secret'},{revision:-1},{revision:1.5},{revoke_key:'x'},{platform:'web'},{environment:'staging'}]) assert.throws(()=>validateRegistration({...valid,...patch}),{status:400});
});
