const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

// Run the actual state machine with the OS/provider boundary controlled. This
// exercises async overlap rather than matching implementation source strings.
async function harness(saved = null, platform = 'ios') {
  const handlers = {}, calls = [], prefs = new Map(), pending = [];
  if (saved) prefs.set('divinghq.native-push.v1', JSON.stringify(saved));
  const settings = { enabled: true, environment: 'production' };
  let permission='granted', online=true, configured=true, autoToken=true;
  const auth={user:{id:'user-a'},async apiFetch(url,options){
    calls.push({url,options});
    if(options?.method==='POST') return {enabled:true};
    if(url.startsWith('/api/notifications/')) return {id:'11111111-1111-4111-8111-111111111111',action_url:'/inbox'};
    return {configured:{ios:configured,android:configured},environments:['production'],device:null};
  }};
  const bindings={
    reactive: o=>o,
    Capacitor:{getPlatform:()=> platform},registerPlugin:()=>({
      getPushEnvironment:async()=>({environment:settings.environment}),
      getNotificationStatus:async()=> settings.read ? settings.read() : ({enabled:settings.enabled}),openNotificationSettings:async()=>{},
      unregisterPush:async()=>{calls.push({nativeUnregister:true});if(settings.deleteToken) await settings.deleteToken()},
    }),
    Preferences:{get:async({key})=>({value:prefs.get(key)||null}),set:async({key,value})=>{prefs.set(key,value)}},
    PushNotifications:{
      addListener:async(name,fn)=>{handlers[name]=fn},checkPermissions:async()=>({receive:permission}),requestPermissions:async()=>({receive:permission}),
      register:async()=>{calls.push({register:true});if(autoToken) queueMicrotask(()=>handlers.registration({value:'a'.repeat(64)}));else pending.push(()=>handlers.registration({value:'a'.repeat(64)}));},
      unregister:async()=>{calls.push({unregister:true})},removeAllDeliveredNotifications:async()=>{},createChannel:async()=>{},
    },
    App:{addListener:async()=>{}},handleNativeUrl:async url=>calls.push({navigate:url}),
  };
  const key=`__nativePushTest_${randomUUID().replaceAll('-','')}`;globalThis[key]=bindings;
  const source=fs.readFileSync(require.resolve('../src/lib/native-push.js'),'utf8').replace(/^import .*$/gm,'');
  global.window={addEventListener(){}};
  global.fetch=async(url,options)=>{calls.push({url,options});if(!online)throw new Error('offline');return {ok:true}};
  const module=await import(`data:text/javascript,${encodeURIComponent(`const {reactive,Capacitor,registerPlugin,Preferences,PushNotifications,App,handleNativeUrl}=globalThis.${key};\n${source}`)}`);
  await module.initNativePush(auth,()=>{});
  return {module,auth,handlers,calls,pending,settings,prefs,set online(v){online=v},set permission(v){permission=v},set configured(v){configured=v},set autoToken(v){autoToken=v},get saved(){return JSON.parse(prefs.get('divinghq.native-push.v1'))}};
}
const next=()=>new Promise(resolve=>setImmediate(resolve));
test('native push requests permission only on explicit enable; provider and OS denial are truthful',async()=>{
 const h=await harness();assert.equal(h.calls.some(c=>c.register),false);
 h.configured=false;assert.equal((await h.module.enableNativePush()).ok,false);assert.match(h.module.nativePushState.error,/not configured/);
 h.configured=true;h.permission='denied';assert.equal((await h.module.enableNativePush()).ok,false);
 h.permission='granted';h.settings.enabled=false;assert.equal((await h.module.enableNativePush()).ok,false);assert.equal(h.saved.enabled,false);
 h.settings.enabled=true;assert.equal((await h.module.enableNativePush()).ok,true);assert.equal(h.module.nativePushState.enabled,true);
});
test('simultaneous resume refreshes share registration and do not strand a registration waiter',async()=>{
 const h=await harness();await h.module.enableNativePush();h.autoToken=false;
 const before=h.calls.filter(c=>c.register).length;
 const a=h.module.refreshNativePush(),b=h.module.refreshNativePush();await next();
 assert.equal(h.calls.filter(c=>c.register).length,before+1);h.pending.shift()();await Promise.all([a,b]);
});
test('logout while registration is pending never posts a new binding; offline revoke persists until online',async()=>{
 const h=await harness();h.autoToken=false;
 const enabling=h.module.enableNativePush();await next();assert.equal(h.pending.length,1);
 h.online=false;const disabling=h.module.disableNativePush();await next();h.auth.user=null;h.pending.shift()();await Promise.all([disabling,enabling]);
 assert.equal(h.saved.enabled,false);assert.equal(h.saved.pendingRevoke,true);
 assert.equal(h.calls.filter(c=>c.url==='/api/push/native').length,0);
 h.online=true;await h.module.refreshNativePush();assert.equal(h.saved.pendingRevoke,false);
});
test('account switch clears prior preference and re-enables only with new account and newer revision',async()=>{
 const h=await harness();await h.module.enableNativePush();const old=h.saved.revision;
 h.online=false;h.auth.user={id:'user-b'};await h.module.nativePushAccountChanged('user-b');
 assert.equal(h.saved.enabled,false);assert.equal(h.saved.pendingRevoke,true);
 h.online=true;assert.equal((await h.module.enableNativePush()).ok,true);
 const post=h.calls.filter(c=>c.url==='/api/push/native').at(-1);const payload=JSON.parse(post.options.body);
 assert.equal(payload.user_id,'user-b');assert.ok(payload.revision>old);assert.equal(h.saved.pendingRevoke,false);
});
test('notification tap fetches authorized content and cannot navigate after account changes',async()=>{
 const h=await harness();let resolve;
 h.auth.apiFetch=()=>new Promise(r=>{resolve=r});
 const tapped=h.handlers.pushNotificationActionPerformed({notification:{data:{notification_id:'11111111-1111-4111-8111-111111111111'},action_url:'https://evil.invalid'}});
 await next();h.auth.user={id:'user-b'};resolve({action_url:'/control'});await tapped;
 assert.equal(h.calls.some(c=>c.navigate),false);
});
test('mounting another consumer with same identity cannot invalidate pending enable',async()=>{
 const h=await harness();await h.module.nativePushAccountChanged('user-a');h.autoToken=false;
 const enabling=h.module.enableNativePush();await next();
 await h.module.nativePushAccountChanged('user-a');h.pending.shift()();
 assert.equal((await enabling).ok,true);assert.equal(h.module.nativePushState.enabled,true);
});
test('late old-account refresh cannot overwrite new-account notification state',async()=>{
 const h=await harness();let resolve;
 h.auth.apiFetch=()=>new Promise(r=>{resolve=r});
 const refresh=h.module.refreshNativePush();await next();h.auth.user=null;
 const changed=h.module.nativePushAccountChanged(undefined);
 resolve({configured:{ios:true},environments:['production'],device:{enabled:true,session_active:true}});
 await Promise.all([refresh,changed]);assert.equal(h.module.nativePushState.enabled,false);
});

test('account changes during OS permission confirmation cannot opt in the new account',async()=>{
 const h=await harness();let reads=0,resolve;
 h.settings.read=()=>{if(++reads===2)return new Promise(r=>{resolve=r});return {enabled:true}};
 const enabling=h.module.enableNativePush();await next();h.auth.user={id:'user-b'};resolve({enabled:true});
 assert.equal((await enabling).ok,false);assert.equal(h.saved.enabled,false);
 assert.equal(h.calls.some(c=>c.url==='/api/push/native'),false);
});

test('Android account B waits for actual token deletion before creating a replacement',async()=>{
 const h=await harness(null,'android');await h.module.enableNativePush();let finish;
 h.settings.deleteToken=()=>new Promise(resolve=>{finish=resolve});
 const disabling=h.module.disableNativePush();await next();
 assert.equal(h.saved.enabled,false);assert.equal(h.saved.pendingUnregister,true);
 h.auth.user={id:'user-b'};
 const before=h.calls.filter(c=>c.register).length;
 const enabling=h.module.enableNativePush();await next();
 assert.equal(h.calls.filter(c=>c.register).length,before);
 assert.equal(h.calls.filter(c=>c.unregister).length,0,'never use early-resolving Capacitor Android unregister');
 finish();await disabling;assert.equal((await enabling).ok,true);
 assert.equal(h.calls.filter(c=>c.register).length,before+1);
 assert.equal(h.saved.pendingUnregister,false);
});
test('failed Android token cleanup stays durable and blocks enable until a later successful retry',async()=>{
 const h=await harness(null,'android');await h.module.enableNativePush();
 h.settings.deleteToken=async()=>{throw new Error('offline SDK')};
 await h.module.disableNativePush();assert.equal(h.saved.pendingUnregister,true);
 const before=h.calls.filter(c=>c.register).length;
 assert.equal((await h.module.enableNativePush()).ok,false);assert.equal(h.calls.filter(c=>c.register).length,before);
 const saved=h.saved;const restarted=await harness(saved,'android');
 assert.equal(restarted.saved.enabled,false);assert.equal(restarted.saved.pendingUnregister,false);
 assert.equal(restarted.calls.some(c=>c.register),false,'restart must preserve opt-out after cleanup');
});
