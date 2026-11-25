// Real browser UI + disk-backed native-file-API fixture; no production backend.
// CHROME_PATH=/usr/bin/google-chrome node library_dom_test.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {init as inboxInit} from './server-inbox/index.js';
const inboxRoutes={};await inboxInit({post:(p,fn)=>inboxRoutes[p]=fn});
const source=readFileSync(new URL('index.js',import.meta.url),'utf8');
const css=readFileSync(new URL('style.css',import.meta.url),'utf8');
const disk=mkdtempSync(join(tmpdir(),'ca-library-test-'));
let server, failWrite=false;
async function start(port=0){
 server=createServer(async(req,res)=>{
  const reply=(status,body,type='application/json')=>{res.writeHead(status,{'Content-Type':type});res.end(body);};
  let raw='';for await(const chunk of req)raw+=chunk;
  const path=new URL(req.url,'http://local').pathname;
  if(path.startsWith('/api/plugins/chat-assistant-inbox/')){const key=path.replace('/api/plugins/chat-assistant-inbox',''),route=inboxRoutes[key];if(!route)return reply(404,'missing');let status=200;return route({body:JSON.parse(raw),user:{profile:{handle:'test'},directories:{root:disk}}},{status:n=>{status=n;return {json:x=>reply(status,JSON.stringify(x))};},json:x=>reply(status,JSON.stringify(x))});}
  if(path==='/api/files/upload'){
   if(failWrite)return reply(500,'failed');
   const {name,data}=JSON.parse(raw);if(!/^ca-library-[a-z0-9.-]+$/.test(name))return reply(400,'bad name');
   writeFileSync(join(disk,name+'.tmp'),Buffer.from(data,'base64'));renameSync(join(disk,name+'.tmp'),join(disk,name));
   return reply(200,JSON.stringify({path:'user/files/'+name}));
  }
  if(path==='/api/files/delete'){unlinkSync(join(disk,JSON.parse(raw).path.split('/').pop()));return reply(200,'{}');}
  if(path.startsWith('/user/files/')){const f=join(disk,path.split('/').pop());return existsSync(f)?reply(200,readFileSync(f),'text/plain; charset=utf-8'):reply(404,'missing');}
  if(path==='/metadata'){
   const f=join(disk,'metadata.json');if(req.method==='POST')writeFileSync(f,raw);
   return reply(200,existsSync(f)?readFileSync(f):'{}');
  }
  return reply(200,'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{transform:translateZ(0);perspective:1000px}body{margin:0;height:100dvh}@media(max-width:550px){body{position:fixed;width:100%}}</style><div id="extensionsMenu"></div>','text/html');
 });
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));return server.address().port;
}
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--no-sandbox']});
try{
 const port=await start(),url='http://127.0.0.1:'+port;
 for(const width of [360,412,1280]){
  // Isolate each viewport's persistent user data, while retaining it across restart.
  rmSync(join(disk,'ca-library-catalog.json'),{force:true});rmSync(join(disk,'metadata.json'),{force:true});
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width<550,hasTouch:width<550});
  const boot=async()=>{
   await page.goto(url);await page.addStyleTag({content:css});
   await page.evaluate(async()=>{
    window.ready=[];window.feedback=[];window.events={};
    if (innerWidth===360) Object.defineProperty(crypto,'subtle',{value:undefined}); // HTTP LAN capability profile.
    window.testContext={chatId:'A',chat:[{mes:'Unchanged RP'}],chatMetadata:await(await fetch('/metadata')).json(),extensionSettings:{},characters:[],characterId:0,event_types:{APP_READY:'APP_READY',CHAT_CHANGED:'CHAT_CHANGED'},eventSource:{on:(e,fn)=>{(events[e]??=[]).push(fn);if(e==='APP_READY')ready.push(fn)}},getRequestHeaders:()=>({'Content-Type':'application/json'}),saveSettingsDebounced(){},async saveMetadata(){const r=await fetch('/metadata',{method:'POST',body:JSON.stringify(testContext.chatMetadata)});if(!r.ok)throw Error('save failed')},setExtensionPrompt(){},registerSlashCommand(){}};
    window.SillyTavern={getContext:()=>testContext};window.toastr=Object.fromEntries(['info','warning','error','success'].map(type=>[type,m=>feedback.push(m)]));
    window.$=window.jQuery=element=>({on:(type,handler)=>element.addEventListener(type,handler)});
   });
   await page.addScriptTag({content:source});await page.evaluate(()=>ready.forEach(fn=>fn()));
   await page.locator('#chatassist_menu_item').click();await page.locator('#chatassist_library').click();
   await page.waitForFunction(()=>document.querySelector('#library_status')?.textContent.includes('documents'));
  };
  const settled=async()=>page.waitForFunction(()=>!document.querySelector('#library_import').disabled);
  const save=async()=>{await page.locator('#library_import').click();await settled();assert.match(await page.locator('#library_status').textContent(),/Saved and verified/);};
  await boot();
  const exact='\uFEFFOriginal CRLF\r\n'+('Unicode 🌍 — reference <img onerror="window.bad=true">\r\n').repeat(400)+'END_SENTINEL';
  // File input uses the actual change handler; textarea normalization must not alter the original.
  await page.locator('#library_file').setInputFiles({name:'Original.md',mimeType:'text/markdown',buffer:Buffer.from(exact)});await settled();
  await save();
  const catalog=()=>JSON.parse(readFileSync(join(disk,'ca-library-catalog.json'),'utf8'));
  let doc=catalog().documents[0];
  assert.equal(readFileSync(join(disk,doc.file),'utf8'),exact,'file import preserves exact original bytes/text through real UI');
  await page.locator('#library_list button').filter({hasText:/^Preview$/}).click();await settled();
  assert.equal(await page.locator('#library_preview').textContent(),exact);
  assert.equal(await page.locator('#library_preview img').count(),0);
  assert.equal(await page.evaluate(()=>!!window.bad),false);
  await page.locator('#library_list input[type=checkbox]').check();await settled();
  assert.deepEqual(JSON.parse(readFileSync(join(disk,'metadata.json'))).continuityCopilot.librarySelection,[doc.id]);
  assert.ok(!readFileSync(join(disk,'metadata.json'),'utf8').includes('END_SENTINEL'));
  await boot();assert.equal(await page.locator('#library_list input').isChecked(),true);
  await new Promise(resolve=>server.close(resolve));await start(port);await boot();
  await page.locator('#library_list button').filter({hasText:/^Preview$/}).click();await settled();assert.equal(await page.locator('#library_preview').textContent(),exact,'complete text survives browser reload and server restart');
  const bounds=await page.locator('#chatassist_library_dialog').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1&&bounds.height<=900);
  await page.locator('#library_list button').filter({hasText:'Edit details'}).click();await settled();await page.locator('#library_title').fill('Renamed');await page.locator('#library_details').click();await settled();
  assert.equal(catalog().documents[0].title,'Renamed');assert.equal(catalog().documents[0].file,doc.file);assert.notEqual(catalog().documents[0].revision,doc.revision);
  await page.locator('#library_list button').filter({hasText:'Edit details'}).click();await settled();await page.locator('#library_text').fill('Replacement source');
  page.once('dialog',d=>d.accept());await page.locator('#library_replace').click();await settled();doc=catalog().documents[0];assert.equal(readFileSync(join(disk,doc.file),'utf8'),'Replacement source');
  await page.locator('#library_title').fill('Failed');await page.locator('#library_text').fill('Keep this editor text');failWrite=true;await page.locator('#library_import').click();await settled();failWrite=false;
  assert.match(await page.locator('#library_status').textContent(),/Library error/);assert.equal(await page.locator('#library_text').inputValue(),'Keep this editor text');assert.equal(catalog().documents.length,1);
  page.once('dialog',d=>d.dismiss());await page.locator('#library_list button').filter({hasText:/^Delete$/}).click();await settled();assert.equal(catalog().documents.length,1);
  page.once('dialog',d=>d.accept());await page.locator('#library_list button').filter({hasText:/^Delete$/}).click();await settled();assert.equal(catalog().documents.length,0);assert.equal(existsSync(join(disk,doc.file)),false);
  await page.locator('#library_new').click();await page.locator('#library_title').fill('Pasted ideas');await page.locator('#library_text').fill('Deliberately pasted reference.');await save();assert.equal(catalog().documents[0].title,'Pasted ideas');
  // Actual mobile controls import from the server without invoking a file chooser.
  const inbox=join(disk,'chat-assistant-inbox');mkdirSync(join(inbox,'novels'),{recursive:true});writeFileSync(join(inbox,'single.md'),'# Volume 1\nServer-only source.');writeFileSync(join(inbox,'novels','one.txt'),'First nested document.');writeFileSync(join(inbox,'novels','two.md'),'Second nested document.');
  let choosers=0;page.on('filechooser',()=>choosers++);
  await page.getByText('Import without Android file picker',{exact:true}).click();
  await page.locator('#library_inbox_browse').click();await settled();await page.getByRole('button',{name:'Import: single.md',exact:true}).click();await settled();assert.ok(catalog().documents.some(d=>d.title==='single.md'));
  await page.locator('#library_inbox_path').fill('novels');page.once('dialog',d=>d.accept());await page.locator('#library_inbox_all').click();await settled();assert.ok(catalog().documents.some(d=>d.title==='one.txt')&&catalog().documents.some(d=>d.title==='two.md'));assert.equal(choosers,0);
  await page.locator('#library_budget').fill('4000');await page.locator('#library_budget').dispatchEvent('change');assert.equal(await page.evaluate(()=>testContext.extensionSettings.continuityCopilot.libraryTokenBudget),4000);
  await page.locator('#library_inspect').click();assert.match(await page.locator('#chatassist_library_inspector').textContent(),/No Library request/);await page.locator('#chatassist_library_inspector button').click();
  const sourceRow=page.locator('#library_list > div').filter({hasText:'single.md'});await sourceRow.locator('input[type=checkbox]').check();await settled();
  await page.evaluate(()=>{const settings=testContext.extensionSettings.continuityCopilot;settings.profileId='fixture';settings.streaming=false;settings.wiDiscovery=false;settings.thinkRetries=0;settings.maxTokens=2048;window.libraryRequests=[];testContext.ConnectionManagerRequestService={sendRequest:async(_p,m)=>{libraryRequests.push(m);const ref=JSON.stringify(m).match(/[0-9a-f-]{36}:[0-9a-f-]{36}@s\d+/)?.[0];return 'The source describes a server-only scene. Source: '+ref;}};});
  await page.locator('#library_close').click();await page.locator('#chatassist_input').fill('Read my selected document.');await page.locator('#chatassist_send').click();await page.waitForFunction(()=>window.libraryRequests.length>0);await page.waitForTimeout(400);
  await page.locator('#chatassist_library').click();await settled();await page.locator('#library_inspect').click();await page.waitForFunction(()=>document.querySelector('#chatassist_library_inspector pre')?.textContent.includes('reservedOutputTokens'));
  const inspection=await page.locator('#chatassist_library_inspector pre').textContent();assert.match(inspection,/Server-only source/);assert.match(inspection,/automatic/);assert.match(inspection,/payload/);assert.equal(await page.evaluate(()=>libraryRequests.length),1);await page.locator('#chatassist_library_inspector button').click();
  await page.evaluate(()=>{testContext.chatId='B';testContext.chatMetadata={};events.CHAT_CHANGED.forEach(fn=>fn());});
  assert.equal(await page.locator('#chatassist_library_dialog').count(),0);await page.locator('#chatassist_library').click();await settled();assert.equal(await page.locator('#library_list input:checked').count(),0);
  assert.equal(await page.evaluate(()=>JSON.stringify(testContext.chat)),'[{"mes":"Unchanged RP"}]');
  console.log(width+': actual Library import/paste/select/preview/rename/replace/delete/cancel/failure/chat-switch, inert text, disk reload + server restart PASS');await page.close();
 }
}finally{await browser.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(disk,{recursive:true,force:true});}
