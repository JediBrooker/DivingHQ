const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const express = require('express');
const jwt = require('jsonwebtoken');
const { applyTestDbDefault, assertTestDatabase } = require('./support/test-db');
applyTestDbDefault();
require('dotenv').config({ quiet: true });
assertTestDatabase();
const { createNativePush } = require('../lib/native-push');

test('native delivery ownership, revocation ordering, credentials and HTTP access', async t => {
  const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
    host: process.env.DB_HOST || process.env.PGHOST, user: process.env.DB_USER || process.env.PGUSER,
    password: process.env.DB_PASSWORD || process.env.PGPASSWORD, database: process.env.DB_DATABASE || process.env.PGDATABASE,
    port: Number(process.env.DB_PORT || process.env.PGPORT || 5432), connectionTimeoutMillis: 2000,
  });
  try { await pool.query('SELECT 1'); } catch { await pool.end(); t.skip('test Postgres unavailable'); return; }
  const suffix = randomBytes(5).toString('hex'), devices = [], users = [];
  let org, server;
  const sends = [];
  let result = { accepted: true };
  const provider = { configured: { ios: true, android: true }, environments: ['production'], send: async (d,n) => { sends.push({ d,n }); return result; } };
  const native = createNativePush({ pool, provider });
  const secret = 'native-push-integration-only';
  function body(user, changes = {}) {
    const b = { id: randomUUID(), revoke_key: randomBytes(32).toString('hex'), platform: 'ios', environment: 'production', token: randomBytes(32).toString('hex'), revision: 1, user_id: user.id, ...changes };
    devices.push(b.id); return b;
  }
  try {
    org = (await pool.query("INSERT INTO organisations(name,slug,country_code,status) VALUES($1,$1,'TST','active') RETURNING id", [`native-${suffix}`])).rows[0].id;
    for (let i=0;i<2;i++) users.push((await pool.query("INSERT INTO users(username,password,full_name,org_id,token_version,email_verified_at) VALUES($1,'x','Native test',$2,0,now()) RETURNING id", [`native-${suffix}-${i}`,org])).rows[0].id);
    const a={id:users[0],tv:0,exp:Math.floor(Date.now()/1000)+3600}, b={id:users[1],tv:0,exp:Math.floor(Date.now()/1000)+3600};
    await t.test('registration binds current user; status and notification read reject other owners', async () => {
      const device=body(a); await native.register(a,device);
      assert.equal((await native.status(a.id,device.id)).device.enabled,true);
      assert.equal((await native.status(b.id,device.id)).device,null);
      await assert.rejects(native.register(b,device), {status:409});
      const n=(await pool.query("INSERT INTO notifications(user_id,category,title) VALUES($1,'test','private') RETURNING id",[a.id])).rows[0];
      assert.equal((await native.notification(a.id,n.id)).title,'private');
      await assert.rejects(native.notification(b.id,n.id),{status:404});
      await assert.rejects(native.register(a,{...device,revoke_key:'a'.repeat(64)}),{status:403});
    });
    await t.test('offline revoke before registration prevents resurrection; fresh revision can re-enable',async()=>{
      const device=body(a); await native.revoke({...device,revision:2});
      await assert.rejects(native.register(a,device),{status:409});
      await assert.rejects(native.register(a,{...device,revision:2}),{status:409});
      await native.register(a,{...device,revision:3});
      await native.revoke({...device,revision:2});
      assert.equal((await native.status(a.id,device.id)).device.enabled,true);
      await native.revoke({...device,revision:4});
      assert.equal((await native.status(a.id,device.id)).device.enabled,false);
    });
    await t.test('account switch transfers device once; old revision cannot register or revoke new owner',async()=>{
      const device=body(a); await native.register(a,device);
      await native.register(b,{...device,user_id:b.id,revision:3});
      await native.revoke({...device,revision:2});
      await assert.rejects(native.register(a,device),{status:409});
      assert.equal((await native.status(a.id,device.id)).device,null);
      assert.equal((await native.status(b.id,device.id)).device.enabled,true);
      await native.revoke({...device,revision:4});
    });
    await t.test('token rotation drops old token and bad revoke key is powerless',async()=>{
      const device=body(a); await native.register(a,device);
      const nextToken=randomBytes(32).toString('hex');
      await native.register(a,{...device,token:nextToken});
      await native.revoke({...device,revoke_key:'b'.repeat(64),revision:99});
      const r=await pool.query('SELECT token,enabled FROM native_push_devices WHERE id=$1',[device.id]);
      assert.equal(r.rows[0].token,nextToken); assert.equal(r.rows[0].enabled,true);
      await native.revoke({...device,revision:2});
    });
    await t.test('delivery refuses expired, token-version revoked, suspended and disabled sessions',async()=>{
      const device=body(b); await native.register(b,device);
      assert.equal((await native.deliver(b.id,{id:randomUUID()},device.id)).accepted,1);
      await pool.query('UPDATE users SET token_version=1 WHERE id=$1',[b.id]);
      assert.equal((await native.status(b.id,device.id)).device.session_active,false);
      assert.equal((await native.deliver(b.id,{id:randomUUID()},device.id)).accepted,0);
      await pool.query('UPDATE users SET token_version=0,suspended_at=now() WHERE id=$1',[b.id]);
      assert.equal((await native.deliver(b.id,{id:randomUUID()},device.id)).accepted,0);
      await pool.query('UPDATE users SET suspended_at=NULL WHERE id=$1',[b.id]);
      await pool.query("UPDATE native_push_devices SET session_expires_at=now()-interval '1 second' WHERE id=$1",[device.id]);
      assert.equal((await native.deliver(b.id,{id:randomUUID()},device.id)).accepted,0);
    });
    await t.test('provider errors remain visible and permanent invalid tokens revoke only matching device',async()=>{
      const device=body(b); await native.register(b,device);
      result={accepted:false,reason:'provider_unreachable'};
      assert.deepEqual(await native.deliver(b.id,{id:randomUUID()},device.id),{accepted:0,failed:1});
      assert.equal((await native.status(b.id,device.id)).device.last_error,'provider_unreachable');
      result={accepted:false,invalid:true,reason:'UNREGISTERED'};
      await native.deliver(b.id,{id:randomUUID()},device.id);
      assert.ok((await native.status(b.id,device.id)).device.revoked_at);
      result={accepted:true};
    });
    await t.test('self-test targets only caller device and does not claim delivered, rate limit enforced',async()=>{
      const device=body(a); await native.register(a,device);
      await assert.rejects(native.test(b,device.id),{status:409});
      const sent=await native.test(a,device.id); assert.equal(sent.accepted,true);
      await assert.rejects(native.test(a,device.id),{status:409});
      assert.equal(sends.at(-1).d.id,device.id);
    });
    await t.test('real auth middleware protects registration/read/test and public revoke grants no reads',async()=>{
      const app=express(); app.use(express.json());
      const { verifyToken }=require('../lib/middleware')({pool,JWT_SECRET:secret});
      app.use(require('../routes/push')({verifyToken,push:{native}}));
      server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
      const url=`http://127.0.0.1:${server.address().port}`, device=body(a);
      let res=await fetch(`${url}/api/push/native`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(device)}); assert.equal(res.status,403);
      const token=jwt.sign({id:a.id,tv:0},secret,{expiresIn:'1h'});
      res=await fetch(`${url}/api/push/native`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(device)}); assert.equal(res.status,200);
      res=await fetch(`${url}/api/push/native/${device.id}`); assert.equal(res.status,403);
      res=await fetch(`${url}/api/push/native/revoke`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...device,revision:2})}); assert.equal(res.status,200);
      assert.equal((await native.status(a.id,device.id)).device.enabled,false);
    });
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
    if(org) await pool.query('DELETE FROM organisations WHERE id=$1',[org]);
    await pool.query('DELETE FROM native_push_installations WHERE id=ANY($1::uuid[])',[devices]);
    await pool.end();
  }
});
