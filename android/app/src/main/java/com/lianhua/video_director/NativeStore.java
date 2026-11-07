package com.lianhua.video_director;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import org.json.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.*;
import java.util.*;

/** Durable, partitioned state. Immutable project blocks are written before their index. */
final class NativeStore {
  final File root, assets, snapshots, blocks;
  private final File stateFile, vaultFile;
  private String lastSecretText,lastVaultHash;
  private static final String KEY_ALIAS = "lianhua-local-secrets-v1";
  NativeStore(Context context) throws Exception {
    root = new File(context.getFilesDir(), "lianhua");
    assets = new File(root, "assets"); snapshots = new File(root, "snapshots");
    blocks = new File(root, "project-library"); stateFile = new File(root, "state.json");
    vaultFile = new File(root, "secrets.enc");
    for (File f : new File[]{root, assets, snapshots, blocks, new File(root,"checkpoints")}) f.mkdirs();
  }
  static String sha(byte[] bytes) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
    StringBuilder s = new StringBuilder(); for (byte b : digest) s.append(String.format(Locale.ROOT,"%02x", b & 255)); return s.toString();
  }
  static String text(File file) throws Exception { return new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8); }
  static String shaFile(File file)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] b=new byte[64*1024];int n;while((n=in.read(b))!=-1)digest.update(b,0,n);}StringBuilder s=new StringBuilder();for(byte b:digest.digest())s.append(String.format(Locale.ROOT,"%02x",b&255));return s.toString();}
  static void atomic(File file, byte[] bytes) throws Exception {
    file.getParentFile().mkdirs(); File tmp = new File(file.getParentFile(),file.getName()+".pending");
    try(FileOutputStream out = new FileOutputStream(tmp)) { out.write(bytes); out.getFD().sync(); }
    Files.move(tmp.toPath(),file.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING,java.nio.file.StandardCopyOption.ATOMIC_MOVE);
  }
  static void atomic(File file, String text) throws Exception { atomic(file,text.getBytes(StandardCharsets.UTF_8)); }
  private SecretKey key() throws Exception {
    KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
    if(ks.containsAlias(KEY_ALIAS)) return (SecretKey)ks.getKey(KEY_ALIAS,null);
    KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
    g.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
    return g.generateKey();
  }
  private String encrypt(String value) throws Exception {
    Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE,key());
    return Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(c.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
  }
  private String decrypt(String value) throws Exception {
    String[] p=value.split(":",2); Cipher c=Cipher.getInstance("AES/GCM/NoPadding");
    c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p[0],Base64.NO_WRAP)));
    return new String(c.doFinal(Base64.decode(p[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
  }
  private JSONObject readVault() throws Exception { return vaultFile.exists()?new JSONObject(decrypt(text(vaultFile))):new JSONObject(); }
  private void writeVault(JSONObject vault) throws Exception { atomic(vaultFile,encrypt(vault.toString())); }
  private static void protect(Object node, String path, JSONObject secret, boolean restore) throws Exception {
    if(node instanceof JSONObject) {
      JSONObject o=(JSONObject)node; Iterator<String> keys=o.keys();
      while(keys.hasNext()) { String k=keys.next(); String p=path+"/"+k; Object v=o.opt(k);
        if ((k.equals("apiKey") || k.equals("accessToken") || k.equals("refreshToken")) && v instanceof String) {
          if(restore) { if(secret.has(p)) o.put(k,secret.get(p)); }
          else { secret.put(p,v); o.put(k,""); }
        } else protect(v,p,secret,restore);
      }
    } else if(node instanceof JSONArray) { JSONArray a=(JSONArray)node; for(int i=0;i<a.length();i++){Object item=a.get(i);String identity=item instanceof JSONObject?((JSONObject)item).optString("id",""):"";protect(item,path+"/"+(identity.isEmpty()?Integer.toString(i):"@"+identity),secret,restore);} }
  }
  JSONObject stripped(JSONObject source) throws Exception {
    JSONObject state=new JSONObject(source.toString()); state.remove("integrity");
    protect(state.opt("settings"),"",new JSONObject(),false);state.remove("__settingsVault"); return state;
  }
  private JSONObject hydrateSecrets(JSONObject state) throws Exception {
    String pointer=state.optString("__settingsVault");JSONObject settingsSecrets=null;
    if(!pointer.isEmpty()){if(!pointer.matches("[a-f0-9]{64}"))throw new IOException("本地密钥索引无效");settingsSecrets=new JSONObject(decrypt(text(new File(root,"vaults/"+pointer+".enc"))));lastSecretText=settingsSecrets.toString();lastVaultHash=pointer;}
    else settingsSecrets=readVault().optJSONObject("settings");
    if(settingsSecrets!=null) protect(state.opt("settings"),"",settingsSecrets,true);
    state.remove("integrity");state.remove("__settingsVault"); return state;
  }
  synchronized JSObject save(String content) throws Exception {
    JSONObject state=new JSONObject(content); if(!state.has("project")||!state.has("settings")) throw new IOException("项目状态结构无效，现有文件未修改");
    state.remove("integrity"); JSONObject secrets=new JSONObject();
    protect(state.opt("settings"),"",secrets,false);
    String secretText=secrets.toString(),vaultHash;
    if(secretText.equals(lastSecretText)&&lastVaultHash!=null)vaultHash=lastVaultHash;
    else {String encrypted=encrypt(secretText);vaultHash=sha(encrypted.getBytes(StandardCharsets.UTF_8));atomic(new File(root,"vaults/"+vaultHash+".enc"),encrypted);lastSecretText=secretText;lastVaultHash=vaultHash;}
    state.put("__settingsVault",vaultHash);
    JSONObject hashes=new JSONObject(); Map<String,JSONObject> projects=new LinkedHashMap<>();
    JSONArray list=state.optJSONArray("projects"); if(list!=null)for(int i=0;i<list.length();i++){JSONObject p=list.optJSONObject(i);if(p!=null&&!p.optBoolean("__activeProjectReference")) projects.put(p.optString("id"),p);}
    JSONObject active=state.getJSONObject("project"); projects.put(active.getString("id"),active);
    JSONArray references=new JSONArray(); String activeId=state.optString("activeProjectId",active.getString("id")); JSONObject activeRef=null;
    for(JSONObject project:projects.values()) {
      JSONObject ref=project.optJSONObject("__projectLibraryReference"); String hash; int schema;
      JSONObject canonical;
      if(ref!=null) {hash=ref.getString("hash");schema=ref.optInt("schemaVersion",24);canonical=readProject(project.getString("id"),hash).getJSONObject("project");}
      else {
        canonical=new JSONObject(project.toString()); canonical.remove("__persistedProjectHash"); canonical.remove("__projectSchemaVersion");
        schema=project.optInt("__projectSchemaVersion",state.optInt("schemaVersion",24)); String block=canonical.toString(); hash=sha(block.getBytes(StandardCharsets.UTF_8));
        File target=blockFile(hash); if(!target.exists()) atomic(target,block);
      }
      JSONObject counts=new JSONObject(); for(String k:new String[]{"sourceDocuments","scenes","storyboards","assets"})counts.put(k,canonical.optJSONArray(k)==null?0:canonical.getJSONArray(k).length());
      JSONObject entry=new JSONObject(); for(String k:new String[]{"id","name","description","createdAt","updatedAt","backgroundSuspended"})if(canonical.has(k))entry.put(k,canonical.get(k));
      entry.put("__projectLibraryReference",new JSONObject().put("hash",hash).put("schemaVersion",schema).put("counts",counts));
      references.put(entry); hashes.put(canonical.getString("id"),hash); if(canonical.getString("id").equals(activeId)) activeRef=entry;
    }
    if(activeRef==null)throw new IOException("当前项目不存在，现有文件未修改");
    state.put("projects",references); state.put("project",activeRef); state.put("activeProjectId",activeId);
    atomic(stateFile,state.toString());
    return new JSObject().put("ok",true).put("checksum",sha(state.toString().getBytes(StandardCharsets.UTF_8))).put("projectHashes",hashes);
  }
  private File blockFile(String hash) throws Exception {
    if(!hash.matches("[a-f0-9]{64}"))throw new IOException("项目存储校验值无效"); return new File(blocks,hash+".json");
  }
  synchronized JSONObject readProject(String id,String hash) throws Exception {
    String s=text(blockFile(hash)); if(!sha(s.getBytes(StandardCharsets.UTF_8)).equals(hash))throw new IOException("项目正文完整性校验失败");
    JSONObject p=new JSONObject(s);if(!p.optString("id").equals(id))throw new IOException("项目正文与索引不匹配");
    int schema=24;
    if(stateFile.exists()){JSONObject s0=new JSONObject(text(stateFile));JSONArray a=s0.optJSONArray("projects");if(a!=null)for(int i=0;i<a.length();i++){JSONObject q=a.getJSONObject(i);if(q.optString("id").equals(id))schema=q.optJSONObject("__projectLibraryReference").optInt("schemaVersion",24);}}
    return new JSONObject().put("project",p).put("schemaVersion",schema).put("hash",hash);
  }
  synchronized String load(boolean all) throws Exception {
    if(!stateFile.exists())return null; JSONObject s=new JSONObject(text(stateFile));
    JSONObject active=s.getJSONObject("project"); s.put("project",resolve(active));
    JSONArray list=s.optJSONArray("projects");if(list!=null)for(int i=0;i<list.length();i++){
      JSONObject p=list.getJSONObject(i);if(all||p.optString("id").equals(s.optString("activeProjectId")))list.put(i,resolve(p));
      else {JSONObject full=resolve(p);if(pending(full))list.put(i,full);}
    }
    return hydrateSecrets(s).toString();
  }
  boolean pending(JSONObject project){if(project.optBoolean("backgroundSuspended"))return true;JSONObject workbench=project.optJSONObject("videoWorkbench");JSONArray jobs=workbench==null?null:workbench.optJSONArray("jobs");if(jobs!=null)for(int i=0;i<jobs.length();i++)if("running".equals(jobs.optJSONObject(i).optString("status")))return true;
    JSONArray tasks=project.optJSONArray("generationTasks");if(tasks==null)return false;Set<String> statuses=new HashSet<>(Arrays.asList("draft","preparing","submitting","submitted","queued","running","unknown","reconnecting","downloading","submission-unknown"));
    for(int i=0;i<tasks.length();i++){JSONObject t=tasks.optJSONObject(i);if(t==null||t.optBoolean("historyOnly"))continue;if(statuses.contains(t.optString("status"))||t.optBoolean("customImageSavePending"))return true;JSONObject j=t.optJSONObject("videoJob");if(j!=null&&(statuses.contains(j.optString("stage"))||Arrays.asList("waiting","ready","active").contains(j.optString("batchQueueState"))||j.has("batchContinuation")||j.optBoolean("resultSelectionRequired")||j.optBoolean("cancellationPending")))return true;
      if(!t.optString("resultUrl").isEmpty()&&t.optString("resultAssetId").isEmpty()&&(j==null||j.optJSONArray("resultAssetIds")==null||j.optJSONArray("resultAssetIds").length()==0))return true;
      if(j!=null&&j.optJSONArray("resultAssetIds")!=null&&j.optJSONArray("resultAssetIds").length()>1&&!j.optBoolean("trackingStopped"))return true;
    }return false;}
  JSONObject resolve(JSONObject p) throws Exception {
    JSONObject ref=p.optJSONObject("__projectLibraryReference");if(ref==null)return p;
    JSONObject block=readProject(p.getString("id"),ref.getString("hash")).getJSONObject("project");
    block.put("__persistedProjectHash",ref.getString("hash")).put("__projectSchemaVersion",ref.optInt("schemaVersion",24));return block;
  }
  synchronized String hydrateImport(String content) throws Exception {
    JSONObject state=new JSONObject(content); if(state.optString("storageFormat").equals("lianhua-project-library-v1"))throw new IOException("请从电脑导出完整 .lhvd 项目包后导入手机");
    if(!state.has("project")||!state.has("settings"))throw new IOException("导入文件不是莲华项目");return stripped(state).toString();
  }
  synchronized JSONObject checkpoint(String method,JSONObject p) throws Exception {
    String id=p.optString("taskId",p.optString("id",p.optString("value")));File f=new File(root,"checkpoints/"+sha(id.getBytes(StandardCharsets.UTF_8))+".enc");
    if(method.startsWith("save")){
      if(f.exists()){JSONObject old=new JSONObject(decrypt(text(f))),oldJob=old.optJSONObject("videoJob"),newJob=p.optJSONObject("videoJob");
        if(oldJob!=null&&newJob!=null){JSONObject oldPrep=oldJob.optJSONObject("preparation"),newPrep=newJob.optJSONObject("preparation");int oldPhase=phase(oldPrep),newPhase=phase(newPrep);
          JSONObject oldSnapshot=oldJob.optJSONObject("snapshot"),newSnapshot=newJob.optJSONObject("snapshot");boolean chained=chain(oldSnapshot)||chain(newSnapshot);
          if(chained&&oldPhase>newPhase)throw new IOException("此链式任务已越过提交边界，不能用旧准备记录再次授权生成");
          if(chained&&oldSnapshot!=null&&newSnapshot!=null)for(String k:new String[]{"batchCompletionOrder","previousTail","batchPredecessorTaskId","continuedFrom"})if(!String.valueOf(oldSnapshot.opt(k)).equals(String.valueOf(newSnapshot.opt(k))))throw new IOException("视频提交记录的批次顺序或尾帧依赖已改变，原记录未覆盖");
          JSONObject oldClaim=oldJob.optJSONObject("batchContinuation"),newClaim=newJob.optJSONObject("batchContinuation");if(oldClaim!=null&&(newClaim==null||newClaim.optInt("revision")<oldClaim.optInt("revision")))throw new IOException("已保存的续跑认领不能被旧记录清空或回退");
          JSONArray oldResults=oldJob.optJSONArray("resultAssetIds"),newResults=newJob.optJSONArray("resultAssetIds");if(oldResults!=null&&oldResults.length()>0&&!oldResults.toString().equals(newResults==null?"":newResults.toString()))throw new IOException("已保存的成片清单不能被旧记录清空或替换");
          if(oldJob.has("resultSelectionRequired")&&!oldJob.optBoolean("resultSelectionRequired")&&newJob.optBoolean("resultSelectionRequired"))throw new IOException("已确认的成片选择不能被迟到记录回退");
          if(oldPhase>newPhase||old.optLong("updatedAt")>p.optLong("updatedAt")||oldJob.optBoolean("remoteGenerationEnded")&&!newJob.optBoolean("remoteGenerationEnded"))return new JSONObject().put("persisted",true);
          if(!oldJob.optString("remoteTaskId").isEmpty()&&newJob.optString("remoteTaskId").isEmpty())newJob.put("remoteTaskId",oldJob.optString("remoteTaskId"));
          if(!old.optString("remoteTaskId").isEmpty()&&p.optString("remoteTaskId").isEmpty())p.put("remoteTaskId",old.optString("remoteTaskId"));
        }
      }
      atomic(f,encrypt(p.toString()));return new JSONObject().put("persisted",true);
    }
    if(method.startsWith("delete")){return new JSONObject().put("deleted",!f.exists()||f.delete());}
    return f.exists()?new JSONObject(decrypt(text(f))):null;
  }
  int phase(JSONObject preparation){if(preparation==null)return 0;String phase=preparation.optString("phase");return phase.equals("acknowledged")?3:phase.equals("post-started")?2:phase.equals("preparing")?1:0;}
  boolean chain(JSONObject snapshot){return snapshot!=null&&(snapshot.has("batchCompletionOrder")||snapshot.has("previousTail")||snapshot.has("batchPredecessorTaskId"));}
  synchronized Object credential(String method,JSONObject p) throws Exception {
    JSONObject v=readVault();JSONObject tasks=v.optJSONObject("tasks");if(tasks==null)tasks=new JSONObject();String id=p.optString("taskId",p.optString("value"));
    if(method.startsWith("set")){tasks.put(id,p.optString("apiKey"));v.put("tasks",tasks);writeVault(v);return new JSObject().put("persisted",true);}
    if(method.startsWith("delete")){tasks.remove(id);v.put("tasks",tasks);writeVault(v);return true;}
    return tasks.has(id)?tasks.getString(id):null;
  }
  synchronized JSONObject snapshot(String content) throws Exception {
    JSONObject s=stripped(new JSONObject(content));if(stateFile.exists()){String pointer=new JSONObject(text(stateFile)).optString("__settingsVault");if(!pointer.isEmpty())s.put("__settingsVault",pointer);}JSONArray list=s.optJSONArray("projects");if(list!=null)for(int i=0;i<list.length();i++)list.put(i,resolve(list.getJSONObject(i)));s.put("project",resolve(s.getJSONObject("project")));
    File f=new File(snapshots,"restore-"+System.currentTimeMillis()+".json");atomic(f,s.toString());return new JSONObject().put("ok",true).put("path",f.getName());
  }
  synchronized String restore(String id) throws Exception {File f=new File(snapshots,new File(id).getName());return hydrateSecrets(new JSONObject(text(f))).toString();}
  JSONObject paths(Context c) throws Exception {
    return new JSONObject().put("dataRoot",root.getAbsolutePath()).put("defaultDataRoot",root.getAbsolutePath()).put("configuredDataRoot","").put("mode","default")
      .put("canChange",false).put("pendingRestart",false).put("sessionData",c.getCacheDir().getAbsolutePath()).put("cache",c.getCacheDir().getAbsolutePath()).put("temp",c.getCacheDir().getAbsolutePath())
      .put("logs",new File(root,"logs").getAbsolutePath()).put("assets",assets.getAbsolutePath()).put("snapshots",snapshots.getAbsolutePath()).put("encryptionAvailable",true);
  }
  synchronized JSONObject recovery() throws Exception {
    JSONArray list=new JSONArray();File[] files=snapshots.listFiles();if(files!=null)for(File f:files)list.put(new JSONObject().put("id",f.getName()).put("name",f.getName()).put("createdAt",f.lastModified()).put("size",f.length()).put("valid",true));
    return new JSONObject().put("dataRoot",root.getAbsolutePath()).put("stateFile",stateFile.getAbsolutePath()).put("stateValid",stateFile.exists()).put("stateChecksum",stateFile.exists()?sha(Files.readAllBytes(stateFile.toPath())):"")
      .put("stateSize",stateFile.length()).put("snapshots",list).put("recovery",recoveryConfig()).put("encryptionAvailable",true);
  }
  JSONObject recoveryConfig() throws Exception {File f=new File(root,"recovery.json");return f.exists()?new JSONObject(text(f)):new JSONObject().put("keepCount",20).put("allowPrivateNetwork",false);}
  synchronized JSONObject updateRecovery(JSONObject p) throws Exception {JSONObject q=recoveryConfig();Iterator<String> i=p.keys();while(i.hasNext()){String k=i.next();q.put(k,p.get(k));}atomic(new File(root,"recovery.json"),q.toString());return q;}
}
