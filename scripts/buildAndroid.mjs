import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertReleaseVersion } from './releaseVersion.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const toolRoot=path.join(root,'.build-tools','android');
const packageInfo=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const version=packageInfo.version;
assertReleaseVersion(version);
const jdkCandidates=fs.existsSync(path.join(toolRoot,'java'))?fs.readdirSync(path.join(toolRoot,'java'),{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>path.join(toolRoot,'java',e.name)):[];
const javaHome=process.env.JAVA_HOME||jdkCandidates[0];
const androidHome=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||path.join(toolRoot,'sdk');
if(!javaHome||!fs.existsSync(path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java')))throw new Error('需要JDK21；请设置JAVA_HOME或安装到.build-tools/android/java');
if(!fs.existsSync(path.join(androidHome,'platforms','android-36')))throw new Error('需要Android SDK36；请设置ANDROID_HOME');
const signingDir=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'lianhua-android-signing');
const signingFile=process.env.LIANHUA_ANDROID_SIGNING_FILE||path.join(signingDir,'release.properties');
const env={...process.env,JAVA_HOME:javaHome,ANDROID_HOME:androidHome,ANDROID_SDK_ROOT:androidHome,GRADLE_USER_HOME:process.env.GRADLE_USER_HOME||path.join(toolRoot,'gradle-cache'),LIANHUA_ANDROID_SIGNING_FILE:signingFile};
if(process.argv.includes('--with-device-tests'))env.LIANHUA_ANDROID_TEST_BUILD_TYPE='release';
function run(command,args,options={}){
  const result=spawnSync(command,args,{cwd:root,env,stdio:'inherit',windowsHide:true,...options});
  if(result.error)throw result.error;if(result.status!==0)throw new Error(`${path.basename(command)} 退出码 ${result.status}`);return result;
}
const java=path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java');
fs.mkdirSync(path.dirname(signingFile),{recursive:true,mode:0o700});
if(!fs.existsSync(signingFile)){
  const storeFile=path.join(path.dirname(signingFile),'lianhua-release.jks');
  if(fs.existsSync(storeFile))throw new Error('已存在签名库但缺少配置；为保护持续升级签名，未覆盖。请恢复原签名配置。');
  const secret=crypto.randomBytes(36).toString('base64url');const keyAlias='lianhua-release';
  const keytool=path.join(javaHome,'bin',process.platform==='win32'?'keytool.exe':'keytool');
  run(keytool,['-genkeypair','-keystore',storeFile,'-alias',keyAlias,'-keyalg','RSA','-keysize','4096','-validity','10950','-dname','CN=Lianhua Video Director, O=Lianhua, C=CN','-storepass:env','LIANHUA_KEY_PASSWORD','-keypass:env','LIANHUA_KEY_PASSWORD'],{env:{...env,LIANHUA_KEY_PASSWORD:secret},stdio:['ignore','ignore','pipe']});
  const prop=`storeFile=${storeFile.replaceAll('\\','/') }\nstorePassword=${secret}\nkeyAlias=${keyAlias}\nkeyPassword=${secret}\n`;
  fs.writeFileSync(signingFile,prop,{mode:0o600,flag:'wx'});
  if(process.platform==='win32'){
    const account=process.env.USERDOMAIN?`${process.env.USERDOMAIN}\\${process.env.USERNAME}`:process.env.USERNAME;
    if(account)run('icacls.exe',[path.dirname(signingFile),'/inheritance:r','/grant:r',`${account}:(OI)(CI)F`],{stdio:'ignore'});
  }
  console.log('已创建仓库外正式签名库；后续版本将继续复用。');
}
if(!process.argv.includes('--skip-web-build'))run(process.execPath,[path.join(root,'node_modules','typescript','bin','tsc'),'-b']);
if(!process.argv.includes('--skip-web-build'))run(process.execPath,[path.join(root,'node_modules','vite','bin','vite.js'),'build']);
run(process.execPath,[path.join(root,'node_modules','@capacitor','cli','bin','capacitor'),'sync','android']);
fs.writeFileSync(path.join(root,'android','local.properties'),`sdk.dir=${androidHome.replaceAll('\\','/')}\n`);
run(java,['-classpath',path.join(root,'android','gradle','wrapper','gradle-wrapper.jar'),'org.gradle.wrapper.GradleWrapperMain','--no-daemon','--console=plain','assembleRelease',...(process.argv.includes('--with-device-tests')?['assembleReleaseAndroidTest']:[])],{cwd:path.join(root,'android')});
const source=path.join(root,'android','app','build','outputs','apk','release','app-release.apk');
if(!fs.existsSync(source))throw new Error('Gradle未生成正式release APK');
const sdkTools=path.join(androidHome,'build-tools','36.0.0');
const verify=run(java,['-jar',path.join(sdkTools,'lib','apksigner.jar'),'verify','--verbose','--print-certs',source],{stdio:'pipe',encoding:'utf8'});
const report=String(verify.stdout||'')+String(verify.stderr||'');
const releaseDir=path.join(root,'release');fs.mkdirSync(releaseDir,{recursive:true});
const target=path.join(releaseDir,`莲华视频导演台-${version}-安卓版.apk`);fs.copyFileSync(source,target);
const sha256=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
fs.writeFileSync(target+'.sha256',`${sha256}  ${path.basename(target)}\n`);
fs.writeFileSync(path.join(releaseDir,`Android-${version}-签名验证.txt`),`version=${version}\nminSdk=26\ntargetSdk=36\nsha256=${sha256}\n${report}`);
console.log(`正式签名APK已生成：${target}\nSHA256: ${sha256}`);
