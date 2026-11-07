package com.lianhua.video_director;

import android.content.*;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.zip.*;

/** content:// imports are copied into private managed storage immediately. */
final class NativeFiles {
  final NativeStore store; final Context context;
  NativeFiles(Context context,NativeStore store){this.context=context;this.store=store;}
  File managed(String relative) throws Exception {
    String r=relative.replace('\\','/');if(r.startsWith("lianhua-asset:"))r=Uri.parse(r).getPath().replaceFirst("^/","");
    File f=new File(store.assets,r).getCanonicalFile();String base=store.assets.getCanonicalPath()+File.separator;
    if(!f.getPath().startsWith(base))throw new IOException("资产路径越界");return f;
  }
  static String mime(String file) {
    String ext=MimeTypeMap.getFileExtensionFromUrl(file.replace(" ",""));String mime=MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase(Locale.ROOT));
    return mime==null?"application/octet-stream":mime;
  }
  static String extension(String mime){String e=MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);return e==null?"bin":e;}
  static String safeName(String name){String s=new File(name).getName().replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]","_").trim();return s.isEmpty()?"资产":s;}
  static byte[] data(String url)throws Exception{int i=url.indexOf(',');if(i<0)throw new IOException("媒体内容格式无效");return Base64.decode(url.substring(i+1),Base64.DEFAULT);}
  static String dataMime(String url){int end=url.indexOf(';');return end>5?url.substring(5,end):"application/octet-stream";}
  JSONObject result(File file,String mime) throws Exception {
    String relative=store.assets.toPath().relativize(file.toPath()).toString().replace('\\','/');
    String kind=mime.startsWith("video/")?"video":mime.startsWith("audio/")?"audio":"image";
    return new JSONObject().put("fileName",file.getName()).put("relativePath",relative).put("checksum",NativeStore.shaFile(file))
      .put("sizeBytes",file.length()).put("mediaType",kind).put("mimeType",mime).put("managed",true).put("missing",false).put("url","lianhua-asset://local/"+relative);
  }
  JSONObject storeBytes(byte[] bytes,String name,String mime,String projectId)throws Exception {
    String hash=NativeStore.sha(bytes);String kind=mime.startsWith("video/")?"video":mime.startsWith("audio/")?"audio":"image";
    String directory=(projectId==null||projectId.isEmpty()?"imports":"projects/"+safeName(projectId))+"/"+kind;
    File dir=new File(store.assets,directory);dir.mkdirs();String n=safeName(name==null?"资产":name);
    if(!n.contains("."))n+="."+extension(mime);File f=new File(dir,n);
    if(f.exists()&&!NativeStore.shaFile(f).equals(hash)){int dot=n.lastIndexOf('.');n=n.substring(0,dot)+"-"+hash+n.substring(dot);f=new File(dir,n);}
    if(!f.exists())NativeStore.atomic(f,bytes);return result(f,mime);
  }
  JSONObject storeFile(File source,String name,String mime,String projectId)throws Exception {
    String hash=NativeStore.shaFile(source),kind=mime.startsWith("video/")?"video":mime.startsWith("audio/")?"audio":"image";
    File dir=new File(store.assets,(projectId==null||projectId.isEmpty()?"imports":"projects/"+safeName(projectId))+"/"+kind);dir.mkdirs();String n=safeName(name==null?"资产":name);if(!n.contains("."))n+="."+extension(mime);
    File target=new File(dir,n);if(target.exists()&&!NativeStore.shaFile(target).equals(hash)){int dot=n.lastIndexOf('.');target=new File(dir,n.substring(0,dot)+"-"+hash+n.substring(dot));}
    if(!target.exists()){File pending=new File(dir,target.getName()+".pending-"+UUID.randomUUID());try(InputStream in=new FileInputStream(source);FileOutputStream out=new FileOutputStream(pending)){byte[] b=new byte[64*1024];int len;while((len=in.read(b))!=-1)out.write(b,0,len);out.getFD().sync();}Files.move(pending.toPath(),target.toPath(),java.nio.file.StandardCopyOption.ATOMIC_MOVE);}
    return result(target,mime);
  }
  JSONObject importData(JSONObject payload)throws Exception {
    String url=payload.optString("dataUrl");if(!url.isEmpty())return storeBytes(data(url),payload.optString("fileName","资产"),dataMime(url),payload.optString("projectId"));
    String u=payload.optString("uri",payload.optString("value"));if(u.isEmpty())throw new IOException("尚未选择文件");
    Uri uri=Uri.parse(u);String name=payload.optString("fileName");
    if(name.isEmpty())try(Cursor c=context.getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(c!=null&&c.moveToFirst())name=c.getString(0);}
    String m=context.getContentResolver().getType(uri);if(m==null)m=mime(name);
    File stage=new File(context.getCacheDir(),"media-import-"+UUID.randomUUID());try(InputStream in=context.getContentResolver().openInputStream(uri);OutputStream out=new FileOutputStream(stage)){byte[] b=new byte[64*1024];int len;while((len=in.read(b))!=-1)out.write(b,0,len);}try{return storeFile(stage,name,m,payload.optString("projectId"));}finally{stage.delete();}
  }
  static byte[] read(InputStream in)throws IOException {if(in==null)throw new IOException("无法读取文件");ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[64*1024];int n;while((n=in.read(b))!=-1)out.write(b,0,n);return out.toByteArray();}
  JSONObject readData(JSONObject payload)throws Exception {
    File f=managed(payload.optString("relativePath",payload.optString("value")));byte[] b=Files.readAllBytes(f.toPath());String checksum=NativeStore.sha(b);
    if(!payload.optString("expectedChecksum").isEmpty()&&!checksum.equals(payload.optString("expectedChecksum")))throw new IOException("参考资产内容已变化，请重新选择当前资产");
    String m=mime(f.getName());return new JSONObject().put("dataUrl","data:"+m+";base64,"+Base64.encodeToString(b,Base64.NO_WRAP)).put("mimeType",m).put("sizeBytes",b.length).put("checksum",checksum);
  }
  JSONObject status(String path)throws Exception {File f=managed(path);return f.exists()?result(f,mime(f.getName())).put("exists",true):new JSONObject().put("exists",false).put("missing",true);}
  private void paths(Object value,Set<String> paths)throws Exception {
    if(value instanceof JSONObject){JSONObject o=(JSONObject)value;String p=o.optString("relativePath");if(!p.isEmpty())paths.add(p);Iterator<String> k=o.keys();while(k.hasNext())paths(o.opt(k.next()),paths);}
    else if(value instanceof JSONArray){JSONArray a=(JSONArray)value;for(int i=0;i<a.length();i++)paths(a.opt(i),paths);}
  }
  JSONObject exportPackage(String content,File destination)throws Exception {
    JSONObject s=store.stripped(new JSONObject(content));s.put("project",store.resolve(s.getJSONObject("project")));JSONArray projects=s.optJSONArray("projects");
    if(projects!=null)for(int i=0;i<projects.length();i++)projects.put(i,store.resolve(projects.getJSONObject(i)));
    Set<String> paths=new LinkedHashSet<>();paths(s,paths);JSONArray assets=new JSONArray();int count=0,missing=0;
    try(ZipOutputStream out=new ZipOutputStream(new FileOutputStream(destination))){
      entry(out,"project.json",s.toString().getBytes(StandardCharsets.UTF_8));
      for(String p:paths){File f=managed(p);JSONObject a=new JSONObject().put("relativePath",p);if(!f.isFile()){a.put("missing",true);missing++;}else{out.putNextEntry(new ZipEntry("assets/"+p));try(InputStream in=new FileInputStream(f)){byte[] b=new byte[64*1024];int n;while((n=in.read(b))!=-1)out.write(b,0,n);}out.closeEntry();a.put("checksum",NativeStore.shaFile(f)).put("sizeBytes",f.length());count++;}assets.put(a);}
      entry(out,"manifest.json",new JSONObject().put("format","lianhua-project-package").put("version",1).put("assets",assets).toString().getBytes(StandardCharsets.UTF_8));
    }
    return new JSONObject().put("assetCount",count).put("missingCount",missing);
  }
  private void entry(ZipOutputStream out,String name,byte[] bytes)throws Exception{out.putNextEntry(new ZipEntry(name));out.write(bytes);out.closeEntry();}
  String importPackage(InputStream source)throws Exception {
    BufferedInputStream buffered=new BufferedInputStream(source);buffered.mark(8192);int first,scanned=0;do{first=buffered.read();scanned++;}while(first>=0&&Character.isWhitespace((char)first)&&scanned<8192);buffered.reset();
    if(first=='{')try(InputStream json=buffered){return store.hydrateImport(new String(read(json),StandardCharsets.UTF_8));}
    File stage=new File(context.getCacheDir(),"project-import-"+UUID.randomUUID());stage.mkdirs();String state=null;JSONObject manifest=null;
    try(ZipInputStream in=new ZipInputStream(buffered)){
      ZipEntry e;while((e=in.getNextEntry())!=null){File f=new File(stage,e.getName()).getCanonicalFile();if(!f.getPath().startsWith(stage.getCanonicalPath()+File.separator))throw new IOException("项目包路径越界");
        if(e.isDirectory()){f.mkdirs();continue;}f.getParentFile().mkdirs();try(OutputStream out=new FileOutputStream(f)){byte[] b=new byte[64*1024];int n;while((n=in.read(b))!=-1)out.write(b,0,n);}in.closeEntry();}
      state=NativeStore.text(new File(stage,"project.json"));manifest=new JSONObject(NativeStore.text(new File(stage,"manifest.json")));
      if(!manifest.optString("format").equals("lianhua-project-package"))throw new IOException("不是兼容的莲华项目包");
      String hydrated=store.hydrateImport(state);JSONArray assets=manifest.optJSONArray("assets");
      if(assets!=null)for(int i=0;i<assets.length();i++){JSONObject a=assets.getJSONObject(i);if(a.optBoolean("missing"))continue;String p=a.getString("relativePath");File sourceFile=new File(stage,"assets/"+p).getCanonicalFile();
        if(!sourceFile.getPath().startsWith(stage.getCanonicalPath()+File.separator))throw new IOException("项目包资产路径越界");
        if(!a.optString("checksum").isEmpty()&&!NativeStore.shaFile(sourceFile).equals(a.getString("checksum")))throw new IOException("项目包资产完整性校验失败："+p);
      }
      Map<String,String> moves=new HashMap<>();if(assets!=null)for(int i=0;i<assets.length();i++){JSONObject a=assets.getJSONObject(i);if(!a.optBoolean("missing")){String p=a.getString("relativePath");File sourceFile=new File(stage,"assets/"+p);File target=managed(p);String hash=NativeStore.shaFile(sourceFile);
        if(target.exists()&&!NativeStore.shaFile(target).equals(hash)){String n=target.getName();int dot=n.lastIndexOf('.');String unique=(dot<0?n:n.substring(0,dot))+"-"+hash+(dot<0?"":n.substring(dot));target=new File(target.getParentFile(),unique);moves.put(p,store.assets.toPath().relativize(target.toPath()).toString().replace('\\','/'));}
        if(!target.exists()){target.getParentFile().mkdirs();Files.copy(sourceFile.toPath(),target.toPath());}
      }}
      JSONObject imported=new JSONObject(hydrated);remap(imported,moves);return imported.toString();
    }finally{delete(stage);}
  }
  void remap(Object node,Map<String,String> moves)throws Exception{if(node instanceof JSONObject){JSONObject o=(JSONObject)node;Iterator<String> i=o.keys();while(i.hasNext()){String k=i.next();Object v=o.get(k);if(v instanceof String){String s=(String)v;if(moves.containsKey(s))o.put(k,moves.get(s));else if(s.startsWith("lianhua-asset://local/")){String p=s.substring("lianhua-asset://local/".length());if(moves.containsKey(p))o.put(k,"lianhua-asset://local/"+moves.get(p));}}else remap(v,moves);}}else if(node instanceof JSONArray){JSONArray a=(JSONArray)node;for(int i=0;i<a.length();i++)remap(a.get(i),moves);}}
  static void delete(File f){File[] children=f.listFiles();if(children!=null)for(File c:children)delete(c);f.delete();}
}
