/* Chat Assistant — Dondopa diagnostic bootstrap v2.83.1 */
(() => {
'use strict';
const LOG='[ChatAssistant-Diagnostic]';
function openPanel(){
 let p=document.getElementById('dondopa_chatassistant_diag_panel');
 if(!p){p=document.createElement('div');p.id='dondopa_chatassistant_diag_panel';
 p.style.cssText='position:fixed;z-index:100000;left:10px;right:10px;bottom:10px;max-width:520px;margin:auto;padding:18px;border-radius:12px;background:#181818;color:white;border:1px solid #777;box-shadow:0 8px 30px rgba(0,0,0,.65);font-family:sans-serif';
 p.innerHTML='<b>Chat Assistant diagnostic</b><div style="margin:10px 0 14px">SUCCESS: SillyTavern loaded the extension and the menu can open its panel.</div><button id="dondopa_chatassistant_diag_close">Close</button>';
 document.body.appendChild(p);document.getElementById('dondopa_chatassistant_diag_close').onclick=()=>p.remove();}
 p.style.display='block';console.info(LOG,'panel opened');}
function addMenu(){
 if(document.getElementById('dondopa_chatassistant_diag_menu')) return true;
 const host=document.querySelector('#extensionsMenu .list-group, #extensionsMenuDrawer .list-group, #extensionsMenu, #extensionsMenuDrawer');
 if(!host)return false;
 const item=document.createElement('div');item.id='dondopa_chatassistant_diag_menu';item.className='list-group-item flex-container flexGap5 interactable';item.tabIndex=0;
 item.innerHTML='<i class="fa-solid fa-comments"></i><span>Chat Assistant DIAGNOSTIC</span>';
 const go=e=>{e.preventDefault();e.stopPropagation();openPanel();};item.addEventListener('click',go);item.addEventListener('touchend',go,{passive:false});host.appendChild(item);console.info(LOG,'menu installed');return true;}
function boot(){console.info(LOG,'bootstrap loaded');if(addMenu())return;let n=0;const t=setInterval(()=>{if(addMenu()||++n>=60)clearInterval(t);},500);}
window.DondopaChatAssistantDiagnostic=openPanel;
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
