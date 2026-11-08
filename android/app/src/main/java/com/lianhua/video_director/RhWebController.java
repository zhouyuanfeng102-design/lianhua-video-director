package com.lianhua.video_director;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.graphics.Insets;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

/** RunningHub mobile page adapter. Each saved login uses an isolated WebView
 * profile. Remote pages receive no project/native bridge or filesystem access. */
public final class RhWebController {
  public interface Callback { void resolve(Object value); void reject(String message); }
  private final Activity activity;
  private final File assets, jobsFile, uploads;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final Map<String, Page> pages = new HashMap<>();
  private final Map<String, JSONObject> jobs = new LinkedHashMap<>();
  private String pageScript;

  private static final class Page {
    WebView view; Dialog dialog; String profile, url;
    CompletableFuture<Boolean> loaded;
  }
  public RhWebController(Activity activity, File assetRoot) {
    this.activity = activity; this.assets = assetRoot;
    jobsFile = new File(assetRoot.getParentFile(), "rh-web/jobs.json");
    uploads = new File(assetRoot.getParentFile(), "rh-web/uploads"); uploads.mkdirs();
    try {
      try (InputStream in = activity.getAssets().open("rh-web.js")) { pageScript = new String(readBytes(in), StandardCharsets.UTF_8); }
      if (jobsFile.exists()) {
        JSONArray list = new JSONArray(new String(Files.readAllBytes(jobsFile.toPath()), StandardCharsets.UTF_8));
        for (int i=0;i<list.length();i++) { JSONObject job=list.getJSONObject(i); jobs.put(job.getString("id"),job); }
      }
    } catch (Exception error) { throw new IllegalStateException("RH 网页记录读取失败："+error.getMessage(), error); }
  }
  public void dispatch(String method, JSObject payload, Callback callback) {
    worker.execute(() -> {
      try {
        Object result;
        switch (method) {
          case "rhWebControl": result = control(payload); break;
          case "rhWebRequest": result = request(payload); break;
          case "rhWebDownload": result = download(payload); break;
          default: throw new IOException("RH 网页操作无效");
        }
        callback.resolve(result);
      } catch (Exception error) {
        Throwable cause=error instanceof ExecutionException && error.getCause()!=null ? error.getCause() : error;
        callback.reject(cause.getMessage()==null ? "RH 网页操作未完成" : cause.getMessage());
      }
    });
  }
  private <T> T ui(Callable<T> action) throws Exception {
    if (Looper.myLooper()==Looper.getMainLooper()) return action.call();
    CompletableFuture<T> future=new CompletableFuture<>();
    main.post(() -> { try { future.complete(action.call()); } catch(Throwable error) { future.completeExceptionally(error); } });
    return future.get(50, TimeUnit.SECONDS);
  }
  private static boolean siteUrl(String value) {
    Uri uri=Uri.parse(value); String host=uri.getHost();
    return "https".equals(uri.getScheme()) && host!=null &&
      (host.equals("runninghub.ai") || host.endsWith(".runninghub.ai") || host.equals("runninghub.cn") || host.endsWith(".runninghub.cn"));
  }
  private static String home(String site) { return "https://www.runninghub."+("cn".equals(site)?"cn":"ai")+"/zh-cn"; }
  private Page open(String account, String address, boolean visible) throws Exception {
    if (!siteUrl(address)) throw new IOException("请使用 RunningHub 国内站或国际站的 HTTPS 应用地址。");
    if (account.isEmpty()) throw new IOException("请先选择 RH 网页登录位。");
    Page page=ui(() -> {
      Page current=pages.get(account);
      if (current==null) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
          throw new IOException("当前 Android System WebView 不支持隔离网页登录位，请先更新系统 WebView。API 模式可以继续使用。");
        }
        current=new Page(); final Page target=current;
        current.profile="lianhua-rh-"+NativeStore.sha(account.getBytes(StandardCharsets.UTF_8)).substring(0,24);
        current.view=new WebView(activity);
        WebViewCompat.setProfile(current.view,current.profile);
        current.view.getSettings().setJavaScriptEnabled(true);
        current.view.getSettings().setDomStorageEnabled(true);
        current.view.getSettings().setAllowFileAccess(false);
        current.view.getSettings().setAllowContentAccess(false);
        // The existing site form is a desktop page; viewport zoom is confined
        // to that external page and never applied to the app's phone UI.
        current.view.getSettings().setUseWideViewPort(true);
        current.view.getSettings().setLoadWithOverviewMode(true);
        String ua=current.view.getSettings().getUserAgentString();
        current.view.getSettings().setUserAgentString(ua.replace("; wv", "").replace(" Version/4.0", ""));
        current.view.setWebViewClient(new WebViewClient() {
          @Override public void onPageFinished(WebView view,String url) {
            if (siteUrl(url)) view.evaluateJavascript(pageScript,null);
            if (target.loaded!=null) target.loaded.complete(true);
          }
          @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request) {
            String url=request.getUrl().toString();
            if (siteUrl(url) || !request.isForMainFrame()) return false;
            try { activity.startActivity(new Intent(Intent.ACTION_VIEW,request.getUrl())); } catch (Exception ignored) {}
            return true;
          }
        });
        current.dialog=new Dialog(activity, android.R.style.Theme_Material_Light_NoActionBar);
        LinearLayout layout=new LinearLayout(activity); layout.setOrientation(LinearLayout.VERTICAL); layout.setBackgroundColor(Color.WHITE);
        Button close=new Button(activity); close.setText("返回莲华视频导演台"); close.setMinHeight((int)(48*activity.getResources().getDisplayMetrics().density));
        close.setOnClickListener(v -> target.dialog.dismiss());
        layout.addView(close,new LinearLayout.LayoutParams(-1,-2));
        layout.addView(current.view,new LinearLayout.LayoutParams(-1,0,1));
        current.dialog.setContentView(layout);
        WindowCompat.setDecorFitsSystemWindows(current.dialog.getWindow(),false);
        ViewCompat.setOnApplyWindowInsetsListener(layout,(view,insets)->{
          Insets safe=insets.getInsets(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.displayCutout()|WindowInsetsCompat.Type.ime());
          view.setPadding(safe.left,safe.top,safe.right,safe.bottom);return insets;
        });
        pages.put(account,current);
      }
      if (visible && !current.dialog.isShowing()) { current.dialog.show(); current.dialog.getWindow().setLayout(-1,-1); }
      if (current.view.getUrl()==null || !current.view.getUrl().startsWith(address)) {
        current.loaded=new CompletableFuture<>(); current.url=address; current.view.loadUrl(address);
      }
      return current;
    });
    awaitPage(page);
    return page;
  }
  /** Page-finished and script callbacks run on the UI thread. Waiting for them
   * on that same thread leaves the login window undrawn. */
  private void awaitPage(Page page) throws Exception {
    if (page.loaded==null) return;
    CompletableFuture<Boolean> loaded=page.loaded;
    if (Looper.myLooper()==Looper.getMainLooper()) {
      throw new IOException("RH 网页登录不能停在界面线程上等待。");
    }
    loaded.get(45,TimeUnit.SECONDS);
  }
  private JSONObject execute(Page page, String operation, JSONObject arguments) throws Exception {
    String token=UUID.randomUUID().toString();
    String script=pageScript+";(()=>{const k="+JSONObject.quote(token)+";Promise.resolve().then(()=>window.__lianhuaRh.operations["+
      JSONObject.quote(operation)+"]("+arguments.toString()+")).then(value=>window.__lianhuaRh.results[k]={value},error=>window.__lianhuaRh.results[k]={error:String(error.message||error)});})();";
    ui(() -> { if (!siteUrl(page.view.getUrl())) throw new IOException("请先回到 RunningHub 页面。"); page.view.evaluateJavascript(script,null); return true; });
    long deadline=System.currentTimeMillis()+100000;
    while (System.currentTimeMillis()<deadline) {
      CompletableFuture<String> result=new CompletableFuture<>();
      main.post(() -> page.view.evaluateJavascript("JSON.stringify(window.__lianhuaRh?.results["+JSONObject.quote(token)+"]||null)",result::complete));
      String raw=result.get(10,TimeUnit.SECONDS);
      if (raw!=null && !raw.equals("null") && !raw.equals("\"null\"")) {
        Object decoded=new org.json.JSONTokener(raw).nextValue();
        JSONObject envelope=new JSONObject(String.valueOf(decoded));
        ui(() -> { page.view.evaluateJavascript("delete window.__lianhuaRh.results["+JSONObject.quote(token)+"]",null); return true; });
        if (envelope.has("error")) throw new IOException(envelope.optString("error"));
        Object value=envelope.opt("value"); return value instanceof JSONObject ? (JSONObject)value : new JSONObject();
      }
      // Observe the same command. This does not execute or submit it again.
      Thread.sleep(150);
    }
    throw new IOException("RH 网页操作等待超时。已交到网页的任务不会重复提交，请在网页核对。");
  }
  private Object control(JSObject payload) throws Exception {
    String action=payload.optString("action"), account=payload.optString("accountId"), site=payload.optString("site","ai");
    if (action.equals("forget")) {
      return ui(() -> {
        Page page=pages.remove(account);
        String profile="lianhua-rh-"+NativeStore.sha(account.getBytes(StandardCharsets.UTF_8)).substring(0,24);
        if (page!=null) { page.dialog.dismiss(); page.view.destroy(); }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) ProfileStore.getInstance().deleteProfile(profile);
        return new JSObject().put("running",true).put("message","已删除这个登录位保存的网页登录。");
      });
    }
    String address=action.equals("read")?payload.optString("url"):home(site);
    // A session query keeps the current app page instead of replacing it.
    Page current=ui(() -> pages.get(account));
    if (action.equals("session") && current!=null) address=ui(() -> current.view.getUrl());
    Page page=open(account,address,action.equals("login"));
    JSONObject result=execute(page,action.equals("read")?"read":"session",new JSONObject());
    if (!action.equals("read")) result.put("open",true).put("running",true);
    return result;
  }
  private JSObject response(Object value) { return new JSObject().put("status",200).put("body",String.valueOf(value)).put("bodyEncoding","text").put("contentType","application/json"); }
  private void saveJobs() throws Exception { NativeStore.atomic(jobsFile,new JSONArray(jobs.values()).toString()); }
  private JSONObject publicJob(JSONObject job) throws Exception {
    JSONObject out=new JSONObject(); for (String key:new String[]{"id","client_id","status","message","upstream_task_id"}) if(job.has(key))out.put(key,job.get(key));
    if (job.has("file")) out.put("result_url","http://rhweb.localhost/v1/videos/"+job.getString("id")+"/content");
    return out;
  }
  private Object request(JSObject payload) throws Exception {
    Uri uri=Uri.parse(payload.optString("url"));
    if (!"rhweb.localhost".equals(uri.getHost())) throw new IOException("RH 网页地址无效。");
    String path=uri.getPath(),method=payload.optString("method","GET");
    if ("/v1/assets".equals(path) && "POST".equalsIgnoreCase(method)) {
      JSONObject item=payload.getJSONObject("multipart").getJSONArray("files").getJSONObject(0);
      String data=item.getString("dataUrl"), id=UUID.randomUUID().toString();
      File file=new File(uploads,id+".json"); NativeStore.atomic(file,item.toString());
      return response(new JSONObject().put("upload_id",id));
    }
    if ("/v1/videos".equals(path) && "POST".equalsIgnoreCase(method)) {
      JSONObject body=new JSONObject(payload.optString("body","{}"));
      for(JSONObject job:jobs.values()) if(job.optString("client_id").equals(body.optString("client_id"))) return response(publicJob(job));
      Page page=open(body.getString("account_id"),body.getString("page_url"),false);
      JSONObject prepared=new JSONObject(body.toString()); JSONArray fields=prepared.optJSONArray("fields");
      if (fields!=null) for(int i=0;i<fields.length();i++) {
        JSONObject field=fields.getJSONObject(i); String kind=field.optString("kind"),value=field.optString("value");
        if ((kind.equals("image")||kind.equals("audio"))&&!value.isEmpty()) {
          if(!value.matches("[a-fA-F0-9-]{36}"))throw new IOException("网页参考素材标识无效。");
          JSONObject file=new JSONObject(NativeStore.text(new File(uploads,value+".json")));
          field.put("value",file.getString("dataUrl")).put("fileName",file.optString("fileName","reference"));
        }
      }
      JSONObject quote=execute(page,"prepare",prepared);
      String id=UUID.randomUUID().toString();
      JSONObject job=new JSONObject().put("id",id).put("client_id",body.getString("client_id")).put("account_id",body.getString("account_id"))
        .put("page_url",body.getString("page_url")).put("status","submission_unknown").put("message","已交到网页，等待任务编号。");
      jobs.put(id,job); saveJobs();
      // A persistent unknown state is created before the one run click.
      JSONObject result=execute(page,"submit",body);
      for(Iterator<String> it=result.keys();it.hasNext();) {String key=it.next();job.put(key,result.get(key));}
      if(result.optString("status").equals("running"))job.put("message",job.optString("message")+" "+quote.optString("quote"));
      saveJobs(); return response(publicJob(job));
    }
    JSONObject found=null;
    if(path!=null&&path.startsWith("/v1/videos/by-client/")) {
      String client=Uri.decode(path.substring("/v1/videos/by-client/".length()));
      for(JSONObject job:jobs.values())if(job.optString("client_id").equals(client))found=job;
      if(found==null)return response(new JSONObject().put("client_id",client));
    } else if(path!=null&&path.startsWith("/v1/videos/")) found=jobs.get(path.substring("/v1/videos/".length()));
    if(found==null) return new JSObject().put("status",404).put("body","{\"message\":\"找不到这条网页任务\"}");
    if(!found.has("file")&&!found.optString("status").equals("failed")) refresh(found);
    return response(publicJob(found));
  }
  private void refresh(JSONObject job) throws Exception {
    Page page=open(job.getString("account_id"),job.getString("page_url"),false);
    if(job.optString("upstream_task_id").isEmpty()) {
      JSONObject recovered=execute(page,"recover",new JSONObject().put("client_id",job.getString("client_id")));
      for(Iterator<String> it=recovered.keys();it.hasNext();) {String key=it.next();job.put(key,recovered.get(key));}
      saveJobs(); if(job.optString("upstream_task_id").isEmpty())return;
    }
    String webapp=Uri.parse(job.getString("page_url")).getLastPathSegment();
    JSONObject result=execute(page,"output",new JSONObject().put("webappId",webapp).put("taskId",job.getString("upstream_task_id")));
    if(result.optBoolean("failed")) { job.put("status","failed").put("message","网页任务已失败。");saveJobs();return; }
    String file=result.optString("fileUrl");
    if(!file.isEmpty()) {
      JSONObject managed=fetchMedia(page,file,result.optString("token"),job.getString("id")+".mp4");
      job.put("file",managed.getString("relativePath")).put("media",managed).put("status","succeeded").put("message","成片已保存到素材库。"); saveJobs();
    } else {job.put("status","running").put("message","网页任务仍在生成。");saveJobs();}
  }
  private JSONObject fetchMedia(Page page,String address,String token,String name) throws Exception {
    String absolute=new URL(new URL(page.url),address).toString();
    String cookie=ui(() -> WebViewCompat.getProfile(page.view).getCookieManager().getCookie(absolute));
    URL source=new URL(absolute); HttpURLConnection connection=null;
    for(int redirects=0;redirects<6;redirects++) {
      connection=(HttpURLConnection)source.openConnection();connection.setConnectTimeout(30000);connection.setReadTimeout(120000);connection.setInstanceFollowRedirects(false);
      if(!token.isEmpty())connection.setRequestProperty("Authorization","Bearer "+token);
      if(cookie!=null)connection.setRequestProperty("Cookie",cookie);
      int status=connection.getResponseCode();
      if(status>=300&&status<400) {URL next=new URL(source,connection.getHeaderField("Location")); if(!next.getHost().equals(source.getHost())){token="";cookie=null;}connection.disconnect();source=next;continue;}
      if(status<200||status>=300) {connection.disconnect();throw new IOException("网页成片下载失败（"+status+"）");}
      break;
    }
    if(connection==null)throw new IOException("成片下载未开始。");
    String type=connection.getContentType();if(type!=null&&(type.contains("text/html")||type.contains("application/json"))){connection.disconnect();throw new IOException("网页返回的内容还不是视频文件。");}
    File temp=new File(assets,".rh-"+UUID.randomUUID()+".part"); MessageDigest digest=MessageDigest.getInstance("SHA-256");
    try(InputStream input=connection.getInputStream(); FileOutputStream output=new FileOutputStream(temp)) {
      byte[] buffer=new byte[65536];int read;while((read=input.read(buffer))!=-1){output.write(buffer,0,read);digest.update(buffer,0,read);}output.getFD().sync();
    } finally {connection.disconnect();}
    StringBuilder hash=new StringBuilder();for(byte b:digest.digest())hash.append(String.format(Locale.ROOT,"%02x",b&255));
    String extension=type!=null&&type.contains("webm")?".webm":type!=null&&type.contains("quicktime")?".mov":".mp4";
    String relative="video/"+hash+extension;File file=new File(assets,relative);file.getParentFile().mkdirs();
    Files.move(temp.toPath(),file.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    return new JSONObject().put("fileName",name).put("relativePath",relative).put("checksum",hash.toString()).put("sizeBytes",file.length())
      .put("mediaType","video").put("mimeType",type==null?"video/mp4":type).put("managed",true).put("missing",false).put("url","lianhua-asset://local/"+relative);
  }
  private Object download(JSObject payload) throws Exception {
    String path=Uri.parse(payload.optString("url")).getPath();
    String prefix="/v1/videos/",suffix="/content";
    if(path==null||!path.startsWith(prefix)||!path.endsWith(suffix))throw new IOException("RH 成片地址无效。");
    JSONObject job=jobs.get(path.substring(prefix.length(),path.length()-suffix.length()));
    if(job==null||!job.has("media"))throw new IOException("这条网页任务还没有成片文件。");
    return job.getJSONObject("media");
  }
  private static byte[] readBytes(InputStream in) throws IOException {ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1)out.write(b,0,n);return out.toByteArray();}
  public void destroy() {main.post(() -> {for(Page page:pages.values()){page.dialog.dismiss();page.view.destroy();}pages.clear();});worker.shutdown();}
}
