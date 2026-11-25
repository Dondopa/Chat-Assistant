import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
export const info={id:'chat-assistant-inbox',name:'Chat Assistant document inbox',description:'Read-only per-user TXT/Markdown inbox'};
const LIMIT=10*1024*1024;
export function segments(value='') {
    if(typeof value!=='string'||value.length>1024||value.includes('\\')||value.includes('\0')||value.startsWith('/'))throw new Error('Invalid relative path');
    const parts=value?value.split('/'):[];
    if(parts.length>32||parts.some(x=>!x||x==='.'||x==='..'||x.startsWith('.')||/[\x00-\x1f]/.test(x)))throw new Error('Invalid relative path');
    return parts;
}
// Linux and Termux: pinned directory descriptors + O_NOFOLLOW at every step.
// An attacker swapping a parent symlink cannot redirect the next open outside it.
async function directory(root,parts) {
    let h=await fs.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{for(const part of parts){const next=await fs.open('/proc/self/fd/'+h.fd+'/'+part,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);await h.close();h=next;}return h;}catch(e){await h.close();throw e;}
}
export async function list(root,relative='',offset=0) {
    if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new Error('Invalid offset');
    const h=await directory(root,segments(relative));let dir;const entries=[];let count=0;
    try{dir=await fs.opendir('/proc/self/fd/'+h.fd);for await(const e of dir){if(e.name.startsWith('.')||e.isSymbolicLink()||!(e.isDirectory()||e.isFile()&&/\.(txt|md)$/i.test(e.name)))continue;if(count++<offset)continue;if(entries.length===50)return {entries,nextOffset:offset+entries.length};entries.push({name:e.name,type:e.isDirectory()?'directory':'file',path:relative?relative+'/'+e.name:e.name});}return {entries,nextOffset:null};}finally{await h.close();}
}
export async function read(root,relative) {
    const parts=segments(relative),name=parts.pop();if(!name||!/\.(txt|md)$/i.test(name))throw new Error('Only TXT and Markdown are supported');
    const parent=await directory(root,parts);let file;
    try{file=await fs.open('/proc/self/fd/'+parent.fd+'/'+name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>LIMIT)throw new Error('Unsupported file or size');
        const data=Buffer.alloc(stat.size+1);let size=0;while(size<data.length){const r=await file.read(data,size,data.length-size,size);if(!r.bytesRead)break;size+=r.bytesRead;}const after=await file.stat();if(size!==stat.size||after.nlink!==1||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw new Error('File changed during read');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data.subarray(0,size));if(text.includes('\0'))throw new Error('NUL is not allowed');return {name,text};
    }finally{await file?.close();await parent.close();}
}
export function publicIPv4(ip) {
    if(net.isIP(ip)!==4)return false;const [a,b]=ip.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51)||a===203&&b===0);
}
export async function readUrl(value,allowlist=process.env.CHAT_ASSISTANT_INBOX_URL_HOSTS||'') {
    const u=new URL(value),allowed=allowlist.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
    if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||u.hash||!allowed.includes(u.hostname)||net.isIP(u.hostname)||!/\.(txt|md)$/i.test(u.pathname))throw new Error('URL requires an administrator-allowed HTTPS hostname and TXT/MD path');
    const addresses=await dns.lookup(u.hostname,{all:true});if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)))throw new Error('URL host resolves to a prohibited address');
    const result=await new Promise((resolve,reject)=>{let deadline;const done=(fn,value)=>{clearTimeout(deadline);fn(value);};const request=https.get(u,{lookup:(_host,_options,cb)=>cb(null,addresses[0].address,4),headers:{Accept:'text/plain, text/markdown'},timeout:15000},response=>{
        if(response.statusCode!==200){response.resume();done(reject,new Error('URL requires HTTP 200; redirects are not followed'));return;}
        if(!/^text\/(?:plain|markdown)(?:;|$)/i.test(response.headers['content-type']||'')){response.destroy();done(reject,new Error('URL must return plain text or Markdown'));return;}
        const chunks=[];let bytes=0;response.on('data',chunk=>{bytes+=chunk.length;if(bytes>LIMIT){response.destroy();done(reject,new Error('URL exceeds size limit'));}else chunks.push(chunk);});response.on('end',()=>done(resolve,Buffer.concat(chunks)));response.on('error',e=>done(reject,e));
    });deadline=setTimeout(()=>request.destroy(new Error('URL deadline exceeded')),15000);request.on('timeout',()=>request.destroy(new Error('URL timeout')));request.on('error',e=>done(reject,e));});
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result);if(!text||text.includes('\0'))throw new Error('Invalid text');return {name:path.basename(u.pathname),text};
}
export async function init(router) {
    const active=new Set();
    const route=(action,fn)=>router.post('/'+action,async(req,res)=>{
        const user=req.user;
        if(!user?.profile?.handle||!user?.directories?.root)return res.status(401).json({error:'Authenticated SillyTavern user required'});
        const root=path.join(user.directories.root,'chat-assistant-inbox'),key=user.profile.handle;
        if(active.has(key))return res.status(429).json({error:'Inbox operation already running'});
        active.add(key);
        try{await fs.mkdir(root,{recursive:false,mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});return res.json(await fn(root,req.body||{}));}
        catch{return res.status(400).json({error:'Inbox request rejected: check path, file format/size, permissions or URL allowlist. No document imported.'});}
        finally{active.delete(key);}
    });
    route('list',(root,b)=>list(root,b.path,b.offset??0));route('read',(root,b)=>read(root,b.path));route('url',(_root,b)=>readUrl(b.url));
}
