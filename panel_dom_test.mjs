// Real DOM regression. Install playwright locally (do not commit node_modules), then:
// CHROME_PATH=/usr/bin/google-chrome node panel_dom_test.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), args:['--no-sandbox']});
try {
 for (const width of [360, 412, 1280]) for (const populated of [false, true]) {
  const page = await browser.newPage({viewport:{width,height:740},isMobile:width<550,hasTouch:width<550});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="extensionsMenu"></div>');
  await page.addStyleTag({content:'*{box-sizing:border-box}html{transform:translateZ(0);perspective:1000px}body{margin:0;height:100dvh;font:16px sans-serif} @media(max-width:550px){body{position:fixed;width:100%}}'});
  await page.addStyleTag({content:readFileSync(new URL('style.css',import.meta.url),'utf8')});
  await page.evaluate(populated=>{
   window.ready=[];
   const history=populated ? Array.from({length:40},()=>({role:'assistant',content:'A long existing campaign discussion. '.repeat(150)})) : [];
   window.testContext={chat:[],chatMetadata:{continuityCopilot:{sessions:[{id:1,name:'Session 1',history}],activeId:1}},extensionSettings:{},characters:[],characterId:0,name1:'User',name2:'Narrator',event_types:{APP_READY:'APP_READY'},eventSource:{on:(e,fn)=>{if(e==='APP_READY')ready.push(fn)}},saveSettingsDebounced(){},saveMetadata(){},setExtensionPrompt(){},registerSlashCommand(){}};
   window.SillyTavern={getContext:()=>testContext};
   window.$=window.jQuery=element=>({on:(type,handler)=>element.addEventListener(type,handler)});
  },populated);
  await page.addScriptTag({content:readFileSync(new URL('index.js',import.meta.url),'utf8')});
  await page.evaluate(()=>ready.forEach(fn=>fn()));
  assert.equal(await page.locator('#chatassist_panel #chatassist_campaign > summary').count(),1,'APP_READY must build the row in the real panel');
  await page.locator('#chatassist_menu_item').click();
  const geometry=await page.locator('#chatassist_campaign > summary').evaluate(summary=>{
   const r=summary.getBoundingClientRect(), d=summary.parentElement.getBoundingClientRect(), p=summary.closest('#chatassist_panel').getBoundingClientRect();
   const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
   return {height:r.height,top:r.top,bottom:r.bottom,containerBottom:d.bottom,panelBottom:p.bottom,hit:summary.contains(hit)};
  });
  assert.ok(geometry.height>=16 && geometry.top>=0 && geometry.bottom<=geometry.containerBottom && geometry.bottom<=geometry.panelBottom && geometry.hit,
   `Campaign row must be fully visible and hittable (${width}, populated=${populated}): ${JSON.stringify(geometry)}`);
  await page.locator('#chatassist_campaign > summary').click();
  assert.equal(await page.locator('#chatassist_campaign_audit').isVisible(),true,'Expanding row reveals Audit');
  await page.locator('#chatassist_campaign > summary').click();
  assert.deepEqual(errors,[]);
  console.log(`${width}px ${populated?'populated':'empty'} session: APP_READY real panel row visible, hittable and expands PASS`);
  await page.close();
 }
} finally { await browser.close(); }
