package com.lianhua.video_director;

import android.app.Activity;
import android.content.*;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

@CapacitorPlugin(name="LianhuaNative")
public final class LianhuaNativePlugin extends Plugin {
  NativeStore store;NativeFiles files;NativeTransport network;NativeMedia media;RhWebController rhWeb;RhTvController rhTv;
  final ExecutorService io=Executors.newFixedThreadPool(6);final ExecutorService state=Executors.newSingleThreadExecutor();
  final AtomicInteger activeTransfers=new AtomicInteger();final Map<String,File> exports=new ConcurrentHashMap<>();
  static final class FileTransfer{File file;String name,mime;long size,received;}
  final Map<String,FileTransfer> fileTransfers=new ConcurrentHashMap<>();
  @Override public void load(){try{
    store=new NativeStore(getContext());files=new NativeFiles(getContext(),store);
    NativeTransport.Events events=(name,data)->{try{notifyListeners(name,JSObject.fromJSONObject(data));}catch(Exception ignored){}};
    network=new NativeTransport(store,files,events);media=new NativeMedia(getContext(),files,events);rhWeb=new RhWebController(getActivity(),store.assets);rhTv=new RhTvController(getActivity(),store.assets);
  }catch(Exception e){throw new IllegalStateException("安卓本地存储初始化失败",e);}}
  void resolve(PluginCall call,Object value){JSObject result=new JSObject();result.put("value",value==null?JSONObject.NULL:value);call.resolve(result);}
  void reject(PluginCall call,Throwable error){String message=error.getMessage();call.reject(message==null?error.toString():message);}
  JSONObject payload(PluginCall call){return call.getObject("payload",new JSObject());}
  String scalar(JSONObject p){return p.optString("value");}
  boolean transfer(String m){return m.equals("request")||m.equals("videoRequest")||m.equals("downloadImage")||m.equals("downloadGeneratedMedia")||m.equals("renderWorkbenchTimeline")||m.equals("extractWorkbenchFrames");}
  void foreground(boolean begin){try{if(begin){if(activeTransfers.getAndIncrement()==0){Intent i=new Intent(getContext(),NativeTransferService.class);if(Build.VERSION.SDK_INT>=26)getContext().startForegroundService(i);else getContext().startService(i);}}else if(activeTransfers.decrementAndGet()<=0){activeTransfers.set(0);getContext().stopService(new Intent(getContext(),NativeTransferService.class));}}catch(Exception ignored){}}
  @PluginMethod public void invoke(PluginCall call){
    String method=call.getString("method","");JSONObject p=payload(call);
    if(method.equals("rhtvControl")&&p.optString("action").equals("import-result")&&!p.has("path")){getActivity().runOnUiThread(()->choose(call,"rhtvControl"));return;}
    if(method.startsWith("rhtv")){delegateRhTv(call,method,p);return;}
    if(method.startsWith("rhWeb")){getActivity().runOnUiThread(()->{try{rhWeb.dispatch(method,JSObject.fromJSONObject(p),new RhWebController.Callback(){public void resolve(Object value){LianhuaNativePlugin.this.resolve(call,value);}public void reject(String message){call.reject(message);}});}catch(Exception e){reject(call,e);}});return;}
    if(method.equals("openFile")||((method.equals("importMedia")||method.equals("relinkMedia")||method.equals("importProjectPackage"))&&!p.has("dataUrl")&&!p.has("uri"))){getActivity().runOnUiThread(()->choose(call,method));return;}
    if(method.equals("saveFile")||method.equals("saveMedia")||method.equals("exportProjectPackage")){io.execute(()->prepareExport(call,method,p));return;}
    ExecutorService executor=method.equals("saveState")||method.startsWith("load")||method.contains("Checkpoint")||method.contains("Credential")||method.contains("Restore")||method.contains("recovery")?state:io;
    executor.execute(()->{boolean active=transfer(method);if(active)foreground(true);try{resolve(call,dispatch(method,p));}catch(Throwable e){reject(call,e);}finally{if(active)foreground(false);}});
  }
  void delegateRhTv(PluginCall call,String method,JSONObject p){getActivity().runOnUiThread(()->{try{rhTv.dispatch(method,JSObject.fromJSONObject(p),new RhTvController.Callback(){public void resolve(Object value){LianhuaNativePlugin.this.resolve(call,value);}public void reject(String message){call.reject(message);}});}catch(Exception e){reject(call,e);}});}
  Object dispatch(String m,JSONObject p)throws Exception {
    switch(m){
      case "beginFileTransfer":{String id=UUID.randomUUID().toString();FileTransfer t=new FileTransfer();t.file=new File(getContext().getCacheDir(),"bridge-import-"+id);t.name=p.optString("fileName","导入文件");t.mime=p.optString("mimeType","application/octet-stream");t.size=p.optLong("sizeBytes");t.file.createNewFile();fileTransfers.put(id,t);return new JSONObject().put("transferId",id);}
      case "appendFileTransfer":{FileTransfer t=fileTransfers.get(p.getString("transferId"));if(t==null)throw new IOException("文件传输会话已结束");synchronized(t){if(t.received!=p.optLong("offset"))throw new IOException("文件分块顺序不一致，原文件未导入");byte[] b=android.util.Base64.decode(p.getString("base64"),android.util.Base64.DEFAULT);try(FileOutputStream out=new FileOutputStream(t.file,true)){out.write(b);}t.received+=b.length;return new JSONObject().put("receivedBytes",t.received);}}
      case "finishFileTransfer":{FileTransfer t=fileTransfers.get(p.getString("transferId"));if(t==null)throw new IOException("文件传输会话已结束");if(t.received!=t.size)throw new IOException("文件传输未完成，原文件未导入");try(FileOutputStream out=new FileOutputStream(t.file,true)){out.getFD().sync();}return new JSONObject().put("uri",Uri.fromFile(t.file).toString()).put("fileName",t.name).put("mimeType",t.mime);}
      case "abortFileTransfer":{FileTransfer t=fileTransfers.remove(p.getString("transferId"));return t==null||t.file.delete();}
      case "loadState":return store.load(true);
      case "loadWorkspaceState":return store.load(false);
      case "loadProject":return store.readProject(p.getString("projectId"),p.getString("hash"));
      case "saveState":return store.save(p.getString("content"));
      case "storagePaths":case "resetStorageLocation":return store.paths(getContext());
      case "selectStorageLocation":throw new IOException("安卓数据保存在应用专属目录；请使用完整项目包导入导出进行迁移");
      case "recoveryStatus":return store.recovery();
      case "updateRecoveryConfig":return store.updateRecovery(p);
      case "createRestorePoint":return store.snapshot(p.getString("content"));
      case "restoreSnapshot":return store.restore(scalar(p));
      case "noteActiveProject":return true;
      case "readFile":try(InputStream in=getContext().getContentResolver().openInputStream(Uri.parse(scalar(p)))){return new String(NativeFiles.read(in),StandardCharsets.UTF_8);}
      case "importMedia":case "relinkMedia":return files.importData(p);
      case "importProjectPackage":{
        byte[] b=p.has("dataUrl")?NativeFiles.data(p.getString("dataUrl")):null;
        InputStream source=b==null?getContext().getContentResolver().openInputStream(Uri.parse(p.getString("uri"))):new ByteArrayInputStream(b);
        try(InputStream in=source){String name=p.optString("fileName");if(name.toLowerCase(Locale.ROOT).endsWith(".json"))return store.hydrateImport(new String(NativeFiles.read(in),StandardCharsets.UTF_8));return files.importPackage(in);}
      }
      case "storeGeneratedImage":case "storeVideoReferenceImage":case "storeGeneratedAudio":case "storeVideoReferenceVideo":return files.importData(p);
      case "readManagedImageDataUrl":case "readVideoReferenceImage":case "readManagedAudioDataUrl":case "readManagedVideoDataUrl":return files.readData(p);
      case "assetStatus":return files.status(scalar(p));
      case "getImageThumbnail":return media.thumbnail(p,false);
      case "getVideoThumbnail":return media.thumbnail(p,true);
      case "cancelVideoThumbnails":return 0;
      case "revealAsset":{
        File f=files.managed(scalar(p));Uri uri=FileProvider.getUriForFile(getContext(),getContext().getPackageName()+".fileprovider",f);
        Intent intent=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,NativeFiles.mime(f.getName())).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_ACTIVITY_NEW_TASK);getContext().startActivity(intent);return true;
      }
      case "request":case "videoRequest":return network.perform(p);
      case "submitVideoTask":{
        JSONObject q=new JSONObject(p.toString()).put("url",p.optString("endpoint"));if(p.opt("body") instanceof JSONObject)q.put("body",p.getJSONObject("body").toString());JSONObject r=network.perform(q);Object body;try{body=new JSONTokener(r.getString("body")).nextValue();}catch(Exception e){body=new JSONObject().put("raw",r.getString("body"));}return new JSONObject().put("status",r.getInt("status")).put("body",body);
      }
      case "cancelModelRequest":case "cancelVideoRequest":return network.cancel(scalar(p));
      case "downloadImage":return network.image(p);
      case "downloadGeneratedMedia":return network.download(p);
      case "watchVideoProgress":network.watch(p);return null;
      case "unwatchVideoProgress":return network.unwatch(scalar(p));
      case "setVideoTaskCredential":case "getVideoTaskCredential":case "deleteVideoTaskCredential":return store.credential(m,p);
      case "saveVideoTaskCheckpoint":case "getVideoTaskCheckpoint":return store.checkpoint(m,p);
      case "deleteVideoTaskCheckpoint":return store.checkpoint(m,p).optBoolean("deleted");
      case "videoWorkbenchStatus":return new JSONObject().put("available",true).put("ffmpeg",false).put("ffprobe",false).put("source","system").put("message","安卓原生媒体引擎：支持抽帧、裁剪、直接拼接、尺寸帧率与固定音量BGM；交叉淡化、自动闪避和淡入淡出请在电脑版导出");
      case "probeWorkbenchVideo":return media.probe(p);
      case "extractWorkbenchFrames":return media.extract(p);
      case "renderWorkbenchTimeline":return media.render(p);
      case "cancelWorkbenchJob":return media.cancel(scalar(p));
      case "openExternal":{
        String url=scalar(p);if(!url.matches("(?i)^https?://.*"))throw new IOException("只允许打开 HTTP(S) 链接");getContext().startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));return null;
      }
      case "requestClose":getActivity().runOnUiThread(()->notifyListeners("beforeClose",new JSObject().put("requestId",scalar(p))));return true;
      case "completeBeforeClose":{
        if(!p.optBoolean("ok")){notifyListeners("closeCancelled",new JSObject().put("requestId",p.optString("requestId")));return false;}
        if(p.optInt("pendingTasks")>0&&!p.optBoolean("chooseForceClose")){getActivity().runOnUiThread(()->new android.app.AlertDialog.Builder(getActivity()).setTitle("任务仍在执行").setMessage("退出后本机处理将停止，远端已提交任务保留，可重新打开继续查询。是否退出？").setNegativeButton("返回",(d,w)->notifyListeners("closeCancelled",new JSObject().put("requestId",p.optString("requestId")))).setPositiveButton("退出",(d,w)->getActivity().finishAndRemoveTask()).show());return false;}
        getActivity().runOnUiThread(()->getActivity().finishAndRemoveTask());return true;
      }
      case "restartApp":getActivity().runOnUiThread(()->getActivity().recreate());return true;
      case "exitApp":getActivity().runOnUiThread(()->getActivity().finishAndRemoveTask());return true;
      default:throw new IOException("安卓原生能力尚未实现："+m);
    }
  }
  void choose(PluginCall call,String method){Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");if(method.equals("rhtvControl"))intent.setType("video/*");else if(method.equals("importMedia")||method.equals("relinkMedia"))intent.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/*","video/*","audio/*"});startActivityForResult(call,intent,"fileChosen");}
  @ActivityCallback private void fileChosen(PluginCall call,ActivityResult result){if(call==null)return;if(result.getResultCode()!=Activity.RESULT_OK||result.getData()==null||result.getData().getData()==null){resolve(call,null);return;}
    Uri uri=result.getData().getData();try{getContext().getContentResolver().takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Exception ignored){}
    String method=call.getString("method","");if(method.equals("openFile")){resolve(call,uri.toString());return;}
    JSONObject p=payload(call);try{p.put("uri",uri.toString());if(method.equals("rhtvControl")){p.put("path",uri.toString());delegateRhTv(call,method,p);return;}if(method.equals("importProjectPackage")){try(android.database.Cursor cursor=getContext().getContentResolver().query(uri,new String[]{android.provider.OpenableColumns.DISPLAY_NAME},null,null,null)){if(cursor!=null&&cursor.moveToFirst())p.put("fileName",cursor.getString(0));}}}catch(Exception e){reject(call,e);return;}
    io.execute(()->{try{resolve(call,dispatch(method,p));}catch(Exception e){reject(call,e);}});
  }
  void prepareExport(PluginCall call,String method,JSONObject p){try{
    File temp=new File(getContext().getCacheDir(),"export-"+UUID.randomUUID());String name,mime;
    if(method.equals("exportProjectPackage")){JSONObject info=files.exportPackage(p.getString("content"),temp);p.put("assetCount",info.getInt("assetCount")).put("missingCount",info.getInt("missingCount"));name=p.optString("fileName","莲华项目")+".lhvd";mime="application/octet-stream";}
    else if(method.equals("saveFile")){NativeStore.atomic(temp,p.optString("content"));name=p.optString("defaultPath","莲华视频导演台项目.json");mime=NativeFiles.mime(name);}
    else {String relative=p.optString("relativePath"),source=p.optString("sourceUrl");
      if(relative.isEmpty()&&source.startsWith("data:")){
        NativeStore.atomic(temp,NativeFiles.data(source));name=p.optString("fileName","媒体文件");mime=p.optString("mimeType",NativeFiles.dataMime(source));
      }else{
        if(relative.isEmpty()&&source.startsWith("lianhua-asset://local/"))relative=Uri.parse(source).getPath().replaceFirst("^/","");
        if(relative.isEmpty()&&source.startsWith("https://localhost/_lianhua_asset/"))relative=Uri.parse(source).getPath().substring("/_lianhua_asset/".length());
        if(relative.isEmpty()){JSONObject asset=network.download(new JSONObject().put("url",source).put("fileName",p.optString("fileName","媒体文件")));relative=asset.getString("relativePath");}
        File f=files.managed(relative);Files.copy(f.toPath(),temp.toPath());name=p.optString("fileName",f.getName());mime=p.optString("mimeType",NativeFiles.mime(name));
      }
    }
    exports.put(call.getCallbackId(),temp);JSObject updated=new JSObject();Iterator<String> keys=p.keys();while(keys.hasNext()){String k=keys.next();updated.put(k,p.get(k));}call.getData().put("payload",updated);
    String finalName=NativeFiles.safeName(name),finalMime=mime;getActivity().runOnUiThread(()->{Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(finalMime).putExtra(Intent.EXTRA_TITLE,finalName);startActivityForResult(call,i,"exportChosen");});
  }catch(Exception e){reject(call,e);}}
  @ActivityCallback private void exportChosen(PluginCall call,ActivityResult result){if(call==null)return;File f=exports.remove(call.getCallbackId());if(result.getResultCode()!=Activity.RESULT_OK||result.getData()==null||result.getData().getData()==null){if(f!=null)f.delete();resolve(call,null);return;}
    Uri uri=result.getData().getData();io.execute(()->{try(InputStream in=new FileInputStream(f);OutputStream out=getContext().getContentResolver().openOutputStream(uri,"wt")){byte[] buffer=new byte[64*1024];int n;while((n=in.read(buffer))!=-1)out.write(buffer,0,n);out.flush();JSONObject p=payload(call);resolve(call,call.getString("method").equals("exportProjectPackage")?new JSONObject().put("path",uri.toString()).put("assetCount",p.optInt("assetCount")).put("missingCount",p.optInt("missingCount")):uri.toString());}catch(Exception e){reject(call,e);}finally{if(f!=null)f.delete();}});
  }
  void back(){notifyListeners("backButton",new JSObject());}
  @Override protected void handleOnDestroy(){if(network!=null)network.close();if(media!=null)media.close();if(rhWeb!=null)rhWeb.destroy();if(rhTv!=null)rhTv.destroy();for(FileTransfer t:fileTransfers.values())t.file.delete();fileTransfers.clear();for(File f:exports.values())f.delete();exports.clear();getContext().stopService(new Intent(getContext(),NativeTransferService.class));io.shutdownNow();state.shutdown();super.handleOnDestroy();}
}
