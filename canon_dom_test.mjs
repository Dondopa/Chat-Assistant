// Actual Canon Director + existing Author Note UI; disk-backed native metadata fixture.
// CHROME_PATH=/usr/bin/google-chrome node canon_dom_test.mjs
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('index.js',import.meta.url),'utf8'),css=readFileSync(new URL('style.css',import.meta.url),'utf8');
const gameplay=JSON.parse(readFileSync(new URL('fixtures/canon-gameplay.json',import.meta.url),'utf8')).messages;
const disk=mkdtempSync(join(tmpdir(),'canon-dom-')),file=join(disk,'chat.json');
const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;if(req.url==='/metadata'){if(req.method==='POST')writeFileSync(file,raw);res.setHeader('Content-Type','application/json');res.end(readFileSync(file));}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="extensionsMenu"></div>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--no-sandbox']});
try{
for(const width of [360,412,1280]){
 writeFileSync(file,JSON.stringify({note_prompt:'Existing prose directive\nKeep this untouched.',note_depth:4}));
 const page=await browser.newPage({viewport:{width,height:900},isMobile:width<550,hasTouch:width<550});
 const boot=async()=>{
  await page.goto('http://127.0.0.1:'+server.address().port);await page.addStyleTag({content:css});
  await page.evaluate(async gameplay=>{
   window.ready=[];window.events={};window.feedback=[];window.calls=[];
   window.testContext={chatId:'canon-A',chat:gameplay,chatMetadata:await(await fetch('/metadata')).json(),extensionSettings:{continuityCopilot:{profileId:'test',streaming:false,directorMode:'off'}},characters:[],characterId:0,event_types:{APP_READY:'APP_READY',CHAT_CHANGED:'CHAT_CHANGED'},eventSource:{on:(e,fn)=>{(events[e]??=[]).push(fn);if(e==='APP_READY')ready.push(fn)}},getRequestHeaders:()=>({'Content-Type':'application/json'}),saveSettingsDebounced(){},async saveMetadata(){await fetch('/metadata',{method:'POST',body:JSON.stringify(testContext.chatMetadata)})},async reloadCurrentChat(){testContext.chatMetadata=await(await fetch('/metadata')).json();if(window.fireReloadChange)events.CHAT_CHANGED.forEach(fn=>fn())},updateChatMetadata(v,replace){testContext.chatMetadata=replace?v:{...testContext.chatMetadata,...v}},setExtensionPrompt(){},registerSlashCommand(){},ConnectionManagerRequestService:{async sendRequest(_p,m){calls.push(m);if(window.testError)throw new Error('API request failed',{cause:Object.assign(new Error(window.testError),{status:429})});if(window.testReplies)return JSON.stringify(window.testReplies.shift()||{repairs:[]});return JSON.stringify({records:[{kind:'agreement',subject:'Current wager',facet:'attempts',text:'Three attempts; keep the other negotiated conditions in view.',epistemic:'observed',phase:'active',confidence:'medium',audience:'player',provenance:'dialogue',refs:['chat:7#1']},{kind:'cue',subject:'Current scene',facet:'guidance',text:'Preserve all wager conditions and one missed attack. Do not decide the remaining attempts or treat a bracket transfer as completed. Off-screen activity is unknown.',epistemic:'inference',phase:'active',confidence:'medium',audience:'director',provenance:'mixed',refs:['chat:7#1','chat:8#1','chat:9#1']}],retire:[],summary:'Director-only fixture result; no canonical baseline has been retrieved.',cueAssessment:'A managed cue is needed; keep unrelated prose.'});}}};
   window.SillyTavern={getContext:()=>testContext};window.toastr=Object.fromEntries(['info','warning','error','success'].map(k=>[k,m=>feedback.push(m)]));window.$=window.jQuery=element=>({on:(type,handler)=>element.addEventListener(type,handler)});
  },gameplay);
  await page.addScriptTag({content:source});await page.evaluate(()=>ready.forEach(fn=>fn()));await page.locator('#chatassist_menu_item').click();await page.locator('#chatassist_canon').click();await page.waitForFunction(()=>document.querySelector('#canon_pending')?.textContent);
 };
 await boot();assert.equal(await page.locator('#canon_player').isChecked(),true);assert.equal(await page.locator('#canon_actions').isVisible(),false);
 await page.locator('#canon_player').uncheck();await page.locator('details').filter({has:page.locator('#canon_continuity')}).locator('summary').click();await page.locator('#canon_continuity').fill('Selected continuity — fixture');await page.locator('#canon_characters').fill('Bunyon Irons');await page.locator('#canon_config').click();await page.waitForFunction(()=>document.querySelector('#canon_status').textContent.includes('Configuration saved'));
 await page.locator('[data-operation=initialize]').click();await page.waitForFunction(()=>document.querySelector('#canon_status').textContent.includes('ready for review'));
 assert.equal(await page.evaluate(()=>testContext.chatMetadata.continuityCopilot.campaignLedger.narrative.records.length),0);

 // Imperfect live-shaped responses exercise the actual Initialize / diagnostics / partial Apply path.
 const priorMetadata=await page.evaluate(()=>structuredClone(testContext.chatMetadata));
 await page.evaluate(()=>{const bad={kind:'divergence',subject:'<img src=x onerror=alert(1)>',facet:'causal assessment',text:'An unresolved classification.',epistemic:'inference',phase:'unknown',confidence:'low',audience:'director',provenance:'mixed',refs:['chat:7#1'],initiator:'NPC',decision:'Player accepts',consequence:'Unresolved'};window.badCandidate=bad;window.testReplies=[{records:[bad],retire:[],summary:'Needs correction',cueAssessment:''},{repairs:[]},{repairs:[]}];});
 await page.locator('[data-operation=initialize]').click();await page.waitForFunction(()=>document.querySelector('#canon_status').textContent.includes('failed:'));
 assert.equal(await page.locator('#canon_accept').isEnabled(),false);assert.equal(await page.locator('#canon_diagnostics').isVisible(),true);
 await page.locator('#canon_diagnostics summary').click();let diagnostics=await page.locator('#canon_diagnostics pre').textContent();
 assert.match(diagnostics,/classification/);assert.match(diagnostics,/missing/);assert.match(diagnostics,/recordIndex/);assert.match(diagnostics,/canon_compatible_improvisation/);assert.equal(await page.locator('#canon_diagnostics img').count(),0);

 await page.evaluate(()=>{window.testError='Rate limit reached; api_key="PRIVATE_FIXTURE" Authorization: Bearer AUTH_FIXTURE';});
 await page.locator('[data-operation=initialize]').click();await page.waitForFunction(()=>document.querySelector('#canon_status').textContent.includes('HTTP 429'));
 diagnostics=await page.locator('#canon_diagnostics pre').textContent();
 assert.match(diagnostics,/"httpStatus": 429/);assert.match(diagnostics,/"failureStage": "transport"/);assert.match(diagnostics,/estimatedInputTokens/);assert.match(diagnostics,/systemPromptCharacters/);assert.match(diagnostics,/requestedMaxOutputTokens/);assert.match(diagnostics,/"structuredOutputRequested": false/);assert.ok(!diagnostics.includes('PRIVATE_FIXTURE')&&!diagnostics.includes('AUTH_FIXTURE'));
 assert.equal(await page.locator('#canon_accept').isEnabled(),false);await page.evaluate(()=>{delete window.testError;});
 await page.evaluate(()=>{window.testReplies=[{records:[{kind:'agreement',subject:'Wager',facet:'attempts',text:'Three attempts.',epistemic:'observed',phase:'active',confidence:'medium',audience:'player',provenance:'dialogue',refs:['chat:7#1']},badCandidate],retire:[],summary:'Incomplete assessment',cueAssessment:'Unresolved; no cue.'},{repairs:[]},{repairs:[]}];});
 await page.locator('[data-operation=initialize]').click();await page.waitForFunction(()=>document.querySelector('#canon_status').textContent.includes('INCOMPLETE analysis ready'));
 assert.match(await page.locator('#canon_pending').textContent(),/INCOMPLETE/);assert.match(await page.locator('#canon_pending').textContent(),/rejected/);assert.equal(await page.locator('#canon_accept').isEnabled(),true);
 assert.equal(await page.evaluate(()=>testContext.chatMetadata.continuityCopilot.campaignLedger.narrative.records.length),0);
 await page.locator('#canon_player').check();assert.equal(await page.locator('#canon_diagnostics').isVisible(),false);await page.locator('#canon_player').uncheck();
 await page.locator('#canon_accept').click();await page.waitForFunction(()=>document.querySelector('#canon_status').textContent.includes('Narrative state saved and verified'));
 assert.equal(JSON.parse(readFileSync(file)).continuityCopilot.campaignLedger.narrative.records.length,1);assert.deepEqual(JSON.parse(readFileSync(file)).continuityCopilot.campaignLedger.narrative.coverage,{});
 await page.evaluate(async prior=>{testContext.chatMetadata=prior;await testContext.saveMetadata();delete window.testReplies;},priorMetadata);
 await page.locator('[data-operation=initialize]').click();await page.waitForFunction(()=>document.querySelector('#canon_status').textContent.startsWith('Analysis ready for review'));
 await page.locator('.canon_pending_source').first().click();assert.ok((await page.locator('.canon_source_dialog pre').textContent()).includes('Original retrieved source'));await page.getByRole('button',{name:'Close source',exact:true}).click();
 await page.locator('#canon_accept').click();await page.waitForFunction(()=>document.querySelector('#canon_status').textContent.includes('Narrative state saved and verified'));
 assert.equal(JSON.parse(readFileSync(file)).continuityCopilot.campaignLedger.narrative.records.length,2);
 const restartPort=server.address().port;await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>server.listen(restartPort,'127.0.0.1',resolve));
 await boot();await page.locator('#canon_player').uncheck();await page.locator('#canon_cue').click();await page.waitForSelector('#chatassist_an_dialog');
 assert.equal(await page.evaluate(()=>testContext.chatMetadata.note_prompt),'Existing prose directive\nKeep this untouched.');
 await page.locator('#chatassist_an_cancel').click();assert.equal(await page.evaluate(()=>testContext.chatMetadata.note_prompt),'Existing prose directive\nKeep this untouched.');
 await page.locator('#canon_cue').click();await page.locator('#chatassist_an_apply').click();await page.waitForFunction(()=>feedback.some(x=>x.includes('Author’s Note saved and verified')));
 let saved=JSON.parse(readFileSync(file));assert.ok(saved.note_prompt.startsWith('Existing prose directive\nKeep this untouched.'));assert.equal(saved.note_depth,4);assert.equal((saved.note_prompt.match(/\[CANON DIRECTOR\]/g)||[]).length,1);
 await page.locator('#canon_cue').click();assert.equal(await page.locator('#chatassist_an_dialog').count(),0);assert.match(await page.locator('#canon_status').textContent(),/already current/);
 await page.locator('#canon_player').check();assert.equal(await page.locator('#canon_cue').isVisible(),false);assert.ok(!(await page.locator('#canon_records').textContent()).includes('Off-screen activity'));assert.ok((await page.locator('#canon_records').textContent()).includes('Three attempts'));
 await page.locator('#canon_player').uncheck();await page.evaluate(()=>testContext.chat[7].mes='Edited wager');await page.locator('#canon_reconcile').click();await page.waitForFunction(()=>document.querySelector('#canon_status').textContent.includes('Stale records'));await page.locator('#canon_cue').click();await page.waitForFunction(()=>document.querySelector('#canon_status').textContent.includes('source-valid cue'));await page.locator('#canon_player').check();assert.equal(await page.locator('#canon_records').textContent(),'');await page.locator('#canon_player').uncheck();
 const box=await page.locator('#chatassist_canon_dialog').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1&&box.height<=900);
 await page.evaluate(original=>{testContext.chat[7].mes=original;window.fireReloadChange=true;},gameplay[7].mes);
 await page.locator('details').filter({has:page.locator('#canon_records')}).locator('summary').click();page.once('dialog',d=>d.accept());await page.locator('#canon_records button').filter({hasText:/^Retire$/}).first().click();
 await page.waitForFunction(()=>testContext.chatMetadata.continuityCopilot.campaignLedger.narrative.records.length===1&&!document.querySelector('#chatassist_canon_dialog'));
 await page.locator('#chatassist_canon').click();await page.waitForSelector('#canon_pending');
 await page.evaluate(()=>{testContext.chatId='canon-B';testContext.chatMetadata={note_prompt:''};events.CHAT_CHANGED.forEach(fn=>fn());});assert.equal(await page.locator('#chatassist_canon_dialog').count(),0);assert.equal(await page.locator('.canon_source_dialog').count(),0);
 console.log(width+': APP_READY real Canon Director configuration/analysis/source inspection/accept/reload, managed Author Note Apply/Cancel/no-op/staleness, spoiler view and chat isolation PASS');await page.close();
}
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));rmSync(disk,{recursive:true,force:true});}
