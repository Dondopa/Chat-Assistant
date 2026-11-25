import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {segments,list,read,readUrl,publicIPv4,init} from './index.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'ca-inbox-'));
let passed=0;const check=(v,label)=>{assert.ok(v,label);passed++;};
try{
 const inbox=path.join(root,'inbox');await fs.mkdir(inbox);await fs.mkdir(path.join(inbox,'novels'));
 const exact='\uFEFF# Chapter 1\r\nOriginal ü text\r\n';await fs.writeFile(path.join(inbox,'novels','one.md'),exact);
 check((await read(inbox,'novels/one.md')).text===exact,'exact Unicode BOM CRLF preserved');
 check((await list(inbox)).entries[0].type==='directory','subdirectory listing');
 for(const bad of ['../outside','/etc/passwd','novels/../one.md','a\\b','a//b','.hidden','a\0b']){assert.throws(()=>segments(bad));passed++;}
 await fs.writeFile(path.join(root,'private.txt'),'PRIVATE');await fs.symlink(path.join(root,'private.txt'),path.join(inbox,'link.txt'));await fs.symlink(root,path.join(inbox,'outside'));
 for(const bad of ['link.txt','outside/private.txt']){await assert.rejects(read(inbox,bad));passed++;}
 check(!(await list(inbox)).entries.some(e=>e.name==='outside'||e.name==='link.txt'),'listing hides symlinks');
 await fs.link(path.join(root,'private.txt'),path.join(inbox,'hard.txt'));await assert.rejects(read(inbox,'hard.txt'));passed++;
 await fs.writeFile(path.join(inbox,'invalid.txt'),Buffer.from([0xff]));await assert.rejects(read(inbox,'invalid.txt'));passed++;
 await fs.writeFile(path.join(inbox,'nul.txt'),'a\0b');await assert.rejects(read(inbox,'nul.txt'));passed++;
 await fs.writeFile(path.join(inbox,'over.txt'),'x'.repeat(10*1024*1024+1));await assert.rejects(read(inbox,'over.txt'));passed++;
 for(let i=0;i<65;i++)await fs.writeFile(path.join(inbox,'novels',i+'.txt'),'page');
 const page=await list(inbox,'novels');check(page.entries.length===50&&page.nextOffset===50,'bounded pagination');check((await list(inbox,'novels',50)).entries.length===16,'second page');
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','0.0.0.0','224.0.0.1'])check(!publicIPv4(ip),'reject nonpublic '+ip);
 check(publicIPv4('8.8.8.8'),'public IPv4 accepted');
 const originalDns=dns.lookup;let forbiddenDns=0;dns.lookup=async()=>{forbiddenDns++;throw new Error('Unexpected DNS');};
 try{
 for(const u of ['file:///etc/passwd','http://example.org/a.txt','https://user:pass@example.org/a.txt','https://127.0.0.1/a.txt','https://example.org:8443/a.txt','https://example.org/a.html','https://evil.example/a.txt']){await assert.rejects(readUrl(u,'example.org'));passed++;check(forbiddenDns===0,'invalid URL rejected before DNS');}
 }finally{dns.lookup=originalDns;}
 const lookup=dns.lookup,get=https.get;let connects=0;
 try{
  https.get=()=>{connects++;throw new Error('Unexpected outbound connection');};
  dns.lookup=async()=>[{address:'127.0.0.1',family:4}];await assert.rejects(readUrl('https://example.org/a.txt','example.org'));passed++;check(connects===0,'private DNS rejected before opening any connection');
  dns.lookup=async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}];await assert.rejects(readUrl('https://example.org/a.txt','example.org'));passed++;check(connects===0,'mixed DNS rejected before opening any connection');
  dns.lookup=async()=>[{address:'8.8.8.8',family:4}];let status=200,type='text/markdown',body=Buffer.from(exact);
  https.get=(u,options,callback)=>{connects++;options.lookup(u.hostname,{},(err,address)=>check(!err&&address==='8.8.8.8','DNS result pinned for connect'));const req=new EventEmitter();req.destroy=e=>req.emit('error',e);queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':type};res.resume=()=>{};res.destroy=()=>{};callback(res);res.emit('data',body);res.emit('end');});return req;};
  check((await readUrl('https://example.org/a.txt','example.org')).text===exact,'URL preserves exact source');
  status=302;await assert.rejects(readUrl('https://example.org/a.txt','example.org'));passed++;check(connects===2,'redirect rejected without second connection');
  status=200;type='text/html';await assert.rejects(readUrl('https://example.org/a.txt','example.org'));passed++;
  type='text/plain';body=Buffer.alloc(10*1024*1024+1,65);await assert.rejects(readUrl('https://example.org/a.txt','example.org'));passed++;
 }finally{dns.lookup=lookup;https.get=get;}
 const routes={};await init({post:(name,fn)=>routes[name]=fn});let code=200,result;
 const res={status:n=>{code=n;return res;},json:x=>{result=x;return res;}};
 await routes['/list']({body:{}},res);check(code===401,'unauthenticated route refused');
 const userRoot=path.join(root,'user-a');await fs.mkdir(userRoot);code=200;await routes['/list']({user:{profile:{handle:'a'},directories:{root:userRoot}},body:{}},res);check(code===200&&result.entries.length===0,'authenticated user gets own empty inbox');
 console.log('Inbox: '+passed+' assertions passed');
}finally{await fs.rm(root,{recursive:true,force:true});}
