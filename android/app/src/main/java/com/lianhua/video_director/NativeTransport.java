package com.lianhua.video_director;

import android.net.Uri;
import android.util.Base64;
import okhttp3.*;
import okio.ByteString;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;

/** Cancellable native transport. No automatic model request retry is enabled. */
final class NativeTransport {
  interface Events {void send(String event,JSONObject value);}
  final NativeStore store;final NativeFiles files;final Events events;
  final Map<String,Call> calls=new ConcurrentHashMap<>();final Map<String,WebSocket> sockets=new ConcurrentHashMap<>();
  NativeTransport(NativeStore store,NativeFiles files,Events events){this.store=store;this.files=files;this.events=events;}
  OkHttpClient client(boolean timeout)throws Exception {
    boolean allow=store.recoveryConfig().optBoolean("allowPrivateNetwork");
    return new OkHttpClient.Builder().retryOnConnectionFailure(false).followRedirects(true).followSslRedirects(false)
      .connectTimeout(30,TimeUnit.SECONDS).readTimeout(timeout?600:0,TimeUnit.SECONDS).writeTimeout(600,TimeUnit.SECONDS)
      .dns(host->{List<InetAddress> list=Dns.SYSTEM.lookup(host);if(!allow)for(InetAddress a:list)if(a.isAnyLocalAddress()||a.isLoopbackAddress()||a.isLinkLocalAddress()||a.isSiteLocalAddress()||a.isMulticastAddress())throw new UnknownHostException("本地网络访问未开启，请在存储与恢复设置中允许私有网络");return list;}).build();
  }
  Request request(JSONObject p)throws Exception {
    String url=p.optString("url",p.optString("value"));if(!url.matches("(?i)^https?://.*"))throw new IOException("只允许 HTTP(S) 接口地址");
    String method=p.optString("method","POST").toUpperCase(Locale.ROOT);Request.Builder b=new Request.Builder().url(url);
    JSONObject headers=p.optJSONObject("headers");if(headers!=null){Iterator<String> i=headers.keys();while(i.hasNext()){String k=i.next();b.header(k,headers.optString(k));}}
    RequestBody body=null;JSONObject multipart=p.optJSONObject("multipart");
    if(multipart!=null){MultipartBody.Builder m=new MultipartBody.Builder().setType(MultipartBody.FORM);Object fields=multipart.opt("fields");
      if(fields instanceof JSONObject){JSONObject f=(JSONObject)fields;Iterator<String> i=f.keys();while(i.hasNext()){String k=i.next();m.addFormDataPart(k,f.optString(k));}}
      else if(fields instanceof JSONArray){JSONArray f=(JSONArray)fields;for(int i=0;i<f.length();i++){JSONObject q=f.getJSONObject(i);m.addFormDataPart(q.getString("name"),q.optString("value"));}}
      JSONArray f=multipart.optJSONArray("files");if(f!=null)for(int i=0;i<f.length();i++){JSONObject q=f.getJSONObject(i);String d=q.getString("dataUrl");m.addFormDataPart(q.optString("fieldName",q.optString("name","file")),q.optString("fileName","image.png"),RequestBody.create(NativeFiles.data(d),MediaType.parse(NativeFiles.dataMime(d))));}
      body=m.build();b.removeHeader("Content-Type");
    }else if(!method.equals("GET")&&!method.equals("HEAD")){
      String data=p.optString("body","");byte[] bytes=p.optString("bodyEncoding").equals("base64")?Base64.decode(data,Base64.DEFAULT):data.getBytes(StandardCharsets.UTF_8);
      body=RequestBody.create(bytes,MediaType.parse(headers==null?"application/json":headers.optString("Content-Type","application/json")));
    }
    return b.method(method,body).build();
  }
  JSONObject perform(JSONObject p)throws Exception {
    Request r=request(p);String id=p.optString("requestId",UUID.randomUUID().toString());Call c=client(!p.optBoolean("noTimeout")).newCall(r);calls.put(id,c);
    try(Response response=c.execute()){
      ResponseBody rb=response.body();byte[] bytes=rb==null?new byte[0]:rb.bytes();String ct=response.header("Content-Type","");String responseType=p.optString("responseType","text");
      boolean binary=responseType.equals("base64")||(responseType.equals("auto")&&!ct.matches("(?i).*(json|text|xml|javascript).*"));
      return new JSONObject().put("status",response.code()).put("body",binary?Base64.encodeToString(bytes,Base64.NO_WRAP):new String(bytes,StandardCharsets.UTF_8))
        .put("bodyEncoding",binary?"base64":"text").put("contentType",ct).put("requestContentType",r.body()==null?"":String.valueOf(r.body().contentType())).put("requestBytes",r.body()==null?0:r.body().contentLength());
    }finally{calls.remove(id);}
  }
  JSONObject download(JSONObject p)throws Exception {
    JSONObject req=new JSONObject(p.toString()).put("method","GET");Request r=request(req);String id=p.optString("requestId",UUID.randomUUID().toString());Call c=client(!p.optBoolean("noTimeout")).newCall(r);calls.put(id,c);
    File stage=new File(files.context.getCacheDir(),"download-"+UUID.randomUUID());
    try(Response response=c.execute()){
      if(!response.isSuccessful()||response.body()==null)throw new IOException("媒体下载失败：HTTP "+response.code());
      String ct=response.header("Content-Type","application/octet-stream").split(";",2)[0];String fileName=p.optString("fileName","");
      if(fileName.isEmpty())fileName=Uri.parse(r.url().toString()).getLastPathSegment();if(fileName==null||fileName.isEmpty())fileName="生成结果";
      String disposition=response.header("Content-Disposition","");if(disposition.contains("filename=")){String n=disposition.substring(disposition.indexOf("filename=")+9).split(";",2)[0].replace("\"","");if(!n.isEmpty())fileName=n;}
      try(InputStream in=response.body().byteStream();OutputStream out=new FileOutputStream(stage)){byte[] b=new byte[64*1024];int n;long done=0,total=response.body().contentLength(),last=0;
        while((n=in.read(b))!=-1){if(c.isCanceled())throw new IOException("下载已取消");out.write(b,0,n);done+=n;if(System.currentTimeMillis()-last>500){last=System.currentTimeMillis();events.send("downloadProgress",new JSONObject().put("requestId",id).put("loaded",done).put("total",total));}}
      }
      byte[] header=new byte[16];int headerLength;try(InputStream in=new FileInputStream(stage)){headerLength=in.read(header);}
      if((p.optBoolean("allowVideoArchive")||p.optBoolean("archiveHint"))&&headerLength>4&&header[0]=='P'&&header[1]=='K')return archiveVideos(stage,p,fileName);
      if(ct.equals("application/octet-stream")){if(headerLength>12&&new String(header,4,4,StandardCharsets.US_ASCII).equals("ftyp"))ct="video/mp4";else ct=NativeFiles.mime(fileName);}
      if(!fileName.contains("."))fileName+="."+NativeFiles.extension(ct);
      return files.storeFile(stage,fileName,ct,p.optString("projectId"));
    }finally{calls.remove(id);stage.delete();}
  }
  JSONObject archiveVideos(File archiveFile,JSONObject p,String archive)throws Exception {
    JSONArray videos=new JSONArray();try(java.util.zip.ZipInputStream in=new java.util.zip.ZipInputStream(new FileInputStream(archiveFile))){java.util.zip.ZipEntry e;while((e=in.getNextEntry())!=null){String m=NativeFiles.mime(e.getName());if(!e.isDirectory()&&m.startsWith("video/")){File temp=new File(files.context.getCacheDir(),"archive-video-"+UUID.randomUUID());try{try(OutputStream out=new FileOutputStream(temp)){byte[] b=new byte[64*1024];int n;while((n=in.read(b))!=-1)out.write(b,0,n);}videos.put(files.storeFile(temp,new File(e.getName()).getName(),m,p.optString("projectId")));}finally{temp.delete();}}}}
    if(videos.length()==0)throw new IOException("压缩包内没有支持的视频文件");JSONObject first=videos.getJSONObject(0);JSONArray rest=new JSONArray();for(int i=1;i<videos.length();i++)rest.put(videos.get(i));return first.put("additionalVideos",rest).put("archiveFileName",archive);
  }
  String image(JSONObject p)throws Exception {JSONObject q=new JSONObject(p.toString()).put("method","GET").put("responseType","base64");if(!q.has("url"))q.put("url",q.optString("value"));JSONObject r=perform(q);if(r.getInt("status")>=400)throw new IOException("图片下载失败：HTTP "+r.getInt("status"));return "data:"+r.optString("contentType","image/png").split(";",2)[0]+";base64,"+r.getString("body");}
  boolean cancel(String id){Call c=calls.remove(id);if(c==null)return false;c.cancel();return true;}
  void watch(JSONObject p)throws Exception {
    String id=p.getString("watchId");Request.Builder r=new Request.Builder().url(p.getString("url"));JSONObject h=p.optJSONObject("headers");if(h!=null){Iterator<String>i=h.keys();while(i.hasNext()){String k=i.next();r.header(k,h.optString(k));}}
    WebSocket socket=client(false).newWebSocket(r.build(),new WebSocketListener(){
      void emit(String type,Object data,String message){try{JSONObject e=new JSONObject().put("watchId",id).put("type",type);if(data!=null)e.put("data",data);if(message!=null)e.put("message",message);events.send("videoProgress",e);}catch(Exception ignored){}}
      @Override public void onOpen(WebSocket s,Response response){emit("connected",null,null);}
      @Override public void onMessage(WebSocket s,String text){Object data=text;try{data=new JSONTokener(text).nextValue();}catch(Exception ignored){}emit("message",data,null);}
      @Override public void onMessage(WebSocket s,ByteString b){onMessage(s,b.utf8());}
      @Override public void onClosed(WebSocket s,int code,String reason){sockets.remove(id);emit("disconnected",null,reason);}
      @Override public void onFailure(WebSocket s,Throwable t,Response r){sockets.remove(id);emit("error",null,t.getMessage());}
    });sockets.put(id,socket);
  }
  boolean unwatch(String id){WebSocket s=sockets.remove(id);if(s==null)return false;s.close(1000,"用户停止查询");return true;}
  void close(){for(Call c:calls.values())c.cancel();for(WebSocket s:sockets.values())s.close(1000,"应用关闭");calls.clear();sockets.clear();}
}
