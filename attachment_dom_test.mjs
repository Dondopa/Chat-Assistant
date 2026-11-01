// Optional browser check: CHROME_PATH=/usr/bin/google-chrome ST_PUBLIC_DIR=/path/to/SillyTavern/public node attachment_dom_test.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('index.js',import.meta.url),'utf8');
function fixturePdf() {
    const stream='BT /F1 12 Tf 40 100 Td (Attachment PDF evidence) Tj ET';
    const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let pdf='%PDF-1.4\n',offsets=[0];
    objects.forEach((object,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});
    const xref=pdf.length;pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf);
}
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--no-sandbox']});
try {
 for(const width of [360,1280]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    await page.route('http://attachment.test/**',route=>{
        const path=new URL(route.request().url()).pathname;
        if(path.startsWith('/lib/') && process.env.ST_PUBLIC_DIR) return route.fulfill({contentType:'text/javascript',body:readFileSync(process.env.ST_PUBLIC_DIR+path)});
        return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="extensionsMenu"></div>'});
    });
    await page.goto('http://attachment.test/');
    await page.addStyleTag({content:readFileSync(new URL('style.css',import.meta.url),'utf8')});
    await page.evaluate(()=>{
        window.ready=[];window.feedback=[];
        window.testContext={chat:[{mes:'Original RP'}],chatMetadata:{},extensionSettings:{},characters:[],characterId:0,event_types:{APP_READY:'APP_READY'},eventSource:{on:(e,fn)=>{if(e==='APP_READY')ready.push(fn)}},saveSettingsDebounced(){},saveMetadata(){},setExtensionPrompt(){},registerSlashCommand(){}};
        window.SillyTavern={getContext:()=>testContext};window.toastr=Object.fromEntries(['info','warning','error','success'].map(type=>[type,m=>feedback.push(m)]));
        window.$=window.jQuery=element=>({on:(type,handler)=>element.addEventListener(type,handler)});
    });
    await page.addScriptTag({content:source.replace('    // Fallback in case APP_READY', '    window.attachmentTest = { attachmentRun };\n    // Fallback in case APP_READY')});await page.evaluate(()=>ready.forEach(fn=>fn()));
    await page.locator('#chatassist_menu_item').click();
    const chooser=page.waitForEvent('filechooser');await page.locator('#chatassist_attach').click();
    await (await chooser).setFiles({name:'<img onerror=alert(1)>.md',mimeType:'text/markdown',buffer:Buffer.from('Exact inert markdown <script>window.executed=true</script>')});
    await page.waitForFunction(()=>document.querySelector('#chatassist_attachments').textContent.includes('COMPLETE extraction'));
    assert.equal(await page.locator('#chatassist_attachments img').count(),0);
    assert.equal(await page.evaluate(()=>!!window.executed),false);
    assert.equal(await page.evaluate(()=>JSON.stringify(testContext.chat)), '[{"mes":"Original RP"}]');
    await page.locator('#chatassist_attach_clear').click();
    await page.waitForFunction(()=>document.querySelector('#chatassist_attachments').textContent.includes('No attachments'));
    if(process.env.ST_PUBLIC_DIR) {
        await page.locator('#chatassist_attach_input').setInputFiles({name:'evidence.pdf',mimeType:'application/pdf',buffer:fixturePdf()});
        await page.waitForFunction(()=>document.querySelector('#chatassist_attachments').textContent.includes('PDF text only') || feedback.some(m=>m.startsWith('Attachment:')));
        assert.ok((await page.locator('#chatassist_attachments').textContent()).includes('extracted 1/1 pages'),JSON.stringify(await page.evaluate(()=>feedback)));
        assert.ok(await page.evaluate(()=>attachmentTest.attachmentRun().docs[0].text.includes('Attachment PDF evidence')), 'actual PDF text was extracted');
    }
    console.log(width+': attachment picker, inert rendering, removal'+(process.env.ST_PUBLIC_DIR?', real PDF.js extraction':' (PDF skipped; set ST_PUBLIC_DIR)')+' PASS');
    await page.close();
 }
} finally {await browser.close();}
