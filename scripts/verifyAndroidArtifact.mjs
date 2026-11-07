import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import yauzl from 'yauzl';

const root=process.cwd();
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const apk=path.join(root,'release',`莲华视频导演台-${version}-安卓版.apk`);
const expected=new Map();
function add(directory,prefix){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name),name=prefix+'/'+entry.name;if(entry.isDirectory())add(file,name);else expected.set(name,file);}}
add(path.join(root,'dist'),'assets/public');
for(const name of ['rh-web.js','rh-tv.js','capacitor.config.json'])expected.set('assets/'+name,path.join(root,'android/app/src/main/assets',name));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const verified=[];
await new Promise((resolve,reject)=>yauzl.open(apk,{lazyEntries:true},(error,zip)=>{
  if(error)return reject(error);
  zip.on('error',reject);zip.on('end',resolve);
  zip.on('entry',entry=>{
    const source=expected.get(entry.fileName);
    if(!source){zip.readEntry();return;}
    zip.openReadStream(entry,(error,stream)=>{
      if(error)return reject(error);
      const chunks=[];stream.on('data',chunk=>chunks.push(chunk));stream.on('error',reject);
      stream.on('end',()=>{try{assert.equal(hash(Buffer.concat(chunks)),hash(fs.readFileSync(source)),`APK contains stale bytes: ${entry.fileName}`);expected.delete(entry.fileName);verified.push(entry.fileName);zip.readEntry();}catch(error){zip.close();reject(error);}});
    });
  });zip.readEntry();
}));
assert.equal(expected.size,0,'APK is missing built frontend or native page assets: '+[...expected.keys()].join(', '));
const report={version,apk,verifiedFiles:verified.length,frontendAndPageScriptsMatch:true,sha256:hash(fs.readFileSync(apk)),deviceTest:false};
fs.writeFileSync(path.join(root,'release','android-content-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
