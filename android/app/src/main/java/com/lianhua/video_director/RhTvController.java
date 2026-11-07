package com.lianhua.video_director;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Color;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** rhTV's existing free-only protocol over an isolated Android WebView.
 * The native journal is synced before acknowledging the sole upstream POST.
 * A lost receipt remains unknown; neither reload nor polling resubmits it. */
public final class RhTvController {
  public interface Callback { void resolve(Object value); void reject(String message); }
  private static final String ORIGIN="http://rhtv.localhost", ENTRY="https://rhtv.runninghub.ai/projects?model=476";
  private final Activity activity;
  private final File assets, root, uploads, journal;
  private final Handler main=new Handler(Looper.getMainLooper());
  private final ScheduledExecutorService worker=Executors.newSingleThreadScheduledExecutor();
  private final Map<String,JSONObject> jobs=new LinkedHashMap<>();
  private final Map<String,Page> pages=new HashMap<>();
  private final String pageScript;
  private volatile boolean automatic, running, destroyed;
  private static final class Page { WebView view; Dialog dialog; CompletableFuture<Boolean> loaded; }

  public RhTvController(Activity activity, File assetRoot) {
    this.activity=activity;assets=assetRoot;root=new File(assetRoot.getParentFile(),"rhtv");
    uploads=new File(root,"uploads");uploads.mkdirs();journal=new File(root,"jobs.json");
    try {
      try(InputStream in=activity.getAssets().open("rh-tv.js")){pageScript=new String(readBytes(in),StandardCharsets.UTF_8);}
      if(journal.exists()) {
        JSONObject saved=new JSONObject(NativeStore.text(journal)); automatic=saved.optBoolean("automatic");
        JSONArray list=saved.getJSONArray("jobs");
        for(int i=0;i<list.length();i++) {
          JSONObject job=list.getJSONObject(i);
          if(!validId(job.optString("id"))||!validId(job.optString("client_id"))||!job.has("request"))throw new IOException("rhTV 任务日志损坏，未启动恢复");
          if(Arrays.asList("preparing","submitting").contains(job.optString("status")))job.put("status",hasTask(job)?"running":job.optBoolean("submission_started")?"submission_unknown":"paused").put("message","上次执行中断；仅恢复原任务，不自动重投。");
          jobs.put(job.getString("id"),job);
        }
        save();
      }
    } catch(Exception error){throw new IllegalStateException("rhTV 本地记录读取失败："+error.getMessage(),error);}
    worker.scheduleWithFixedDelay(() -> {try{tick();}catch(Exception ignored){}},5,5,TimeUnit.SECONDS);
  }
  public void dispatch(String method, JSObject payload, Callback callback) {
    if(method.equals("rhtvControl")&&(payload.optString("action").equals("stop")||payload.optString("action").equals("automation")&&!payload.optBoolean("enabled"))) {
      automatic=false;
      main.post(() -> {for(Page page:pages.values())page.view.evaluateJavascript("window.__lianhuaRhTv?.operations.pause()",null);});
    }
    worker.execute(() -> {
      try { if(destroyed)throw new IOException("rhTV 网页桥接已停止");
        Object result;
        if(method.equals("rhtvControl"))result=control(payload);
        else if(method.equals("rhtvRequest")){running=true;try{result=request(payload);}catch(Exception error){result=response(new JSONObject().put("message",message(error)),409);}}
        else if(method.equals("rhtvDownload"))result=download(payload);
        else throw new IOException("不支持的 rhTV 操作");
        callback.resolve(result);
      }catch(Exception error){callback.reject(message(error));}
    });
  }
  private static String message(Throwable error){Throwable cause=error instanceof ExecutionException&&error.getCause()!=null?error.getCause():error;return cause.getMessage()==null?"rhTV 网页操作未完成":cause.getMessage();}
  private static boolean validId(String id){return id.matches("[a-zA-Z0-9_-]{1,120}");}
  private static boolean terminal(JSONObject job){return Arrays.asList("succeeded","failed","cancelled").contains(job.optString("status"));}
  private static boolean hasTask(JSONObject job){return job.optJSONObject("upstream")!=null&&!job.optJSONObject("upstream").optString("task_id").isEmpty();}
  private <T>T ui(Callable<T> action)throws Exception{CompletableFuture<T> f=new CompletableFuture<>();main.post(()->{try{f.complete(action.call());}catch(Throwable e){f.completeExceptionally(e);}});return f.get(50,TimeUnit.SECONDS);}
  private static boolean site(String address){Uri uri=Uri.parse(address==null?"":address);String host=uri.getHost();return "https".equals(uri.getScheme())&&host!=null&&(host.equals("runninghub.ai")||host.endsWith(".runninghub.ai"));}
  private Page open(String key,String address,boolean visible)throws Exception{
    if(!site(address))throw new IOException("rhTV 原网页地址无效");
    Page page=ui(()->{
      Page current=pages.get(key);
      if(current==null){
        if(!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)||!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT))throw new IOException("当前 Android System WebView 不支持 rhTV 隔离登录与网页请求观察，请先更新系统 WebView。");
        current=new Page();final Page target=current;current.view=new WebView(activity);WebViewCompat.setProfile(current.view,"lianhua-rhtv");
        current.view.getSettings().setJavaScriptEnabled(true);current.view.getSettings().setDomStorageEnabled(true);current.view.getSettings().setAllowFileAccess(false);current.view.getSettings().setAllowContentAccess(false);
        current.view.getSettings().setUseWideViewPort(true);current.view.getSettings().setLoadWithOverviewMode(true);
        String ua=current.view.getSettings().getUserAgentString();current.view.getSettings().setUserAgentString(ua.replace("; wv","").replace(" Version/4.0",""));
        WebViewCompat.addDocumentStartJavaScript(current.view,pageScript,new HashSet<>(Arrays.asList("https://rhtv.runninghub.ai","https://www.runninghub.ai")));
        current.view.setWebViewClient(new WebViewClient(){
          @Override public void onPageFinished(WebView view,String url){if(site(url))view.evaluateJavascript(pageScript,null);if(target.loaded!=null)target.loaded.complete(true);}
          @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){if(site(request.getUrl().toString())||!request.isForMainFrame())return false;try{activity.startActivity(new Intent(Intent.ACTION_VIEW,request.getUrl()));}catch(Exception ignored){}return true;}
        });
        current.dialog=new Dialog(activity,android.R.style.Theme_Material_Light_NoActionBar);
        LinearLayout layout=new LinearLayout(activity);layout.setOrientation(LinearLayout.VERTICAL);layout.setBackgroundColor(Color.WHITE);
        Button close=new Button(activity);close.setText("返回莲华视频导演台");close.setMinHeight((int)(48*activity.getResources().getDisplayMetrics().density));close.setOnClickListener(v->target.dialog.dismiss());
        layout.addView(close,new LinearLayout.LayoutParams(-1,-2));layout.addView(current.view,new LinearLayout.LayoutParams(-1,0,1));current.dialog.setContentView(layout);
        WindowCompat.setDecorFitsSystemWindows(current.dialog.getWindow(),false);
        ViewCompat.setOnApplyWindowInsetsListener(layout,(view,insets)->{Insets safe=insets.getInsets(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.displayCutout()|WindowInsetsCompat.Type.ime());view.setPadding(safe.left,safe.top,safe.right,safe.bottom);return insets;});
        pages.put(key,current);
      }
      if(visible&&!current.dialog.isShowing()){current.dialog.show();current.dialog.getWindow().setLayout(-1,-1);}
      if(current.view.getUrl()==null||!current.view.getUrl().equals(address)){current.loaded=new CompletableFuture<>();current.view.loadUrl(address);}
      return current;
    });
    if(page.loaded!=null)page.loaded.get(45,TimeUnit.SECONDS);return page;
  }
  private JSONObject evaluate(Page page,String expression)throws Exception{
    CompletableFuture<String> f=new CompletableFuture<>();main.post(()->page.view.evaluateJavascript("JSON.stringify("+expression+")",f::complete));
    String raw=f.get(10,TimeUnit.SECONDS);if(raw==null||raw.equals("null")||raw.equals("\"null\""))return new JSONObject();
    return new JSONObject(String.valueOf(new JSONTokener(raw).nextValue()));
  }
  private JSONObject execute(Page page,String operation,JSONObject arguments,JSONObject job)throws Exception{
    String token=UUID.randomUUID().toString();String quoted=JSONObject.quote(token);
    String script=pageScript+";(()=>{const k="+quoted+";Promise.resolve().then(()=>window.__lianhuaRhTv.operations["+JSONObject.quote(operation)+"]("+arguments+")).then(value=>window.__lianhuaRhTv.results[k]={value},error=>window.__lianhuaRhTv.results[k]={error:String(error.message||error)});})();";
    ui(()->{if(!site(page.view.getUrl()))throw new IOException("请先回到 rhTV 网页");page.view.evaluateJavascript(script,null);return true;});
    String boundaryToken="";long deadline=System.currentTimeMillis()+180000;
    while(System.currentTimeMillis()<deadline&&!destroyed){
      JSONObject envelope=evaluate(page,"({result:window.__lianhuaRhTv?.results["+quoted+"]||null,boundary:window.__lianhuaRhTv?.boundary||null})");
      JSONObject boundary=envelope.optJSONObject("boundary");
      if(operation.equals("submit")&&boundary!=null&&!boundary.optString("token").equals(boundaryToken)){
        boundaryToken=boundary.getString("token");boolean allowed=automatic&&running&&job!=null&&!job.optBoolean("submission_started")&&!terminal(job);
        if(allowed){job.put("upstream",boundary.getJSONObject("upstream")).put("quote",boundary.getJSONObject("quote")).put("reference_receipt",boundary.getJSONArray("reference_receipt")).put("submission_started",true).put("status","submitting").put("message","零费用与引用已核实，已记录唯一提交边界；回执丢失不重投。");save();}
        final String ack=boundaryToken;final boolean permit=allowed;
        ui(()->{page.view.evaluateJavascript("window.__lianhuaRhTv.operations.acknowledge("+new JSONObject().put("token",ack).put("allowed",permit)+")",null);return true;});
      }
      JSONObject result=envelope.optJSONObject("result");
      if(result!=null){ui(()->{page.view.evaluateJavascript("delete window.__lianhuaRhTv.results["+quoted+"]",null);return true;});if(result.has("error"))throw new IOException(result.optString("error"));JSONObject value=result.optJSONObject("value");return value==null?new JSONObject():value;}
      Thread.sleep(120); // Observe this same command; never execute it again.
    }
    throw new IOException("rhTV 操作等待超时；保留原任务，不自动重投。");
  }
  private void save()throws Exception{NativeStore.atomic(journal,new JSONObject().put("automatic",automatic).put("jobs",new JSONArray(jobs.values())).toString());}
  private JSONObject get(String id)throws Exception{JSONObject job=jobs.get(id);if(job==null)throw new IOException("未找到原 rhTV 任务");return job;}
  private JSONObject publicJob(JSONObject job)throws Exception{
    JSONObject request=job.getJSONObject("request"),out=new JSONObject();
    for(String key:new String[]{"id","client_id","status","message","created_at","handed_off","automatic","submission_started","quote"})if(job.has(key))out.put(key,job.get(key));
    out.put("mode",request.getString("mode")).put("reference_count",request.getJSONArray("references").length());
    JSONArray refs=new JSONArray();JSONArray original=request.getJSONArray("references");for(int i=0;i<original.length();i++){JSONObject ref=new JSONObject(original.getJSONObject(i).toString());String upload=ref.getString("upload_id");ref.remove("upload_id");ref.put("checksum",upload.split("_")[0]);refs.put(ref);}out.put("references",refs);
    JSONObject upstream=job.optJSONObject("upstream");if(upstream!=null)out.put("upstream_task_id",upstream.optString("task_id")).put("page_url",upstream.optString("page_url"));
    if(job.optString("status").equals("succeeded"))out.put("result_url",ORIGIN+"/v1/videos/"+job.getString("id")+"/content");
    return out.put("terminal_confirmed",terminal(job)).put("cancellation_confirmed",job.optString("status").equals("cancelled"));
  }
  private JSONObject status()throws Exception{JSONArray list=new JSONArray();List<JSONObject> sorted=new ArrayList<>(jobs.values());Collections.reverse(sorted);for(JSONObject job:sorted)list.put(publicJob(job));return new JSONObject().put("running",running).put("endpoint",ORIGIN).put("browser","Android System WebView · rhTV 独立登录位").put("automatic_submission",automatic).put("automation_supported",true).put("live_site_verified",false).put("message",automatic?"已启用原图上传、零费用提交及原任务跟踪；实站联调待验收。":"自动提交已暂停；原任务记录与占位保留。").put("jobs",list);}
  private Object control(JSObject payload)throws Exception{
    String action=payload.optString("action"),id=payload.optString("jobId");
    if(action.equals("status"))return status();
    if(action.equals("start")){running=true;return status();}
    if(action.equals("stop")){running=false;automatic=false;save();return status();}
    if(action.equals("login")){running=true;open("login",ENTRY,true);return status();}
    if(action.equals("automation")){automatic=payload.getBoolean("enabled");running=true;save();return status();}
    JSONObject job=get(id);
    if(action.equals("materials")){shareMaterials(job);return status();}
    if(action.equals("import-result")){importResult(job,payload.getString("path"));return status();}
    if(action.equals("cancel")){cancel(job);return status();}
    if(action.equals("confirm-not-submitted")){if(hasTask(job)||terminal(job))throw new IOException("已取得原任务编号或任务已结束，不能标记未提交");close(id);job.put("status","cancelled").put("message","用户已在原网页核实未提交，已取消本机任务。");save();return status();}
    if(action.equals("confirm-ended")){if(!job.optBoolean("handed_off")||terminal(job))throw new IOException("仅可核实已交接且未结束的原任务");close(id);job.put("status","failed").put("message","用户已核实原任务失败或取消；没有请求退款或重新提交。");save();return status();}
    if(action.equals("retry")){if(terminal(job))throw new IOException("原任务已经结束");if(hasTask(job)){job.put("status","running").put("next_check",0);}else{if(job.optBoolean("submission_started")||!job.optBoolean("automatic"))throw new IOException("原任务是否已提交不明确，未重新提交");close(id);job.put("handed_off",false).put("status","waiting_review");}save();return status();}
    if(action.equals("prepare")||action.equals("handoff")){
      if(terminal(job))throw new IOException("原任务已经结束");
      if(job.optBoolean("handed_off")){String address=job.optJSONObject("upstream")==null?ENTRY:job.getJSONObject("upstream").optString("page_url",ENTRY);open(id,address,true);return status();}
      for(JSONObject other:jobs.values())if(other!=job&&other.optBoolean("handed_off")&&!terminal(other))throw new IOException("同账号原网页任务尚未结束");
      job.put("handed_off",true).put("status","submission_unknown").put("message","已记录人工网页交接边界，请核对原网页。");save();
      Page page=open(id,ENTRY,true);JSONObject result=execute(page,"prepare",new JSONObject().put("job",job).put("files",files(job)).put("manual",true),job);
      job.put("status","waiting_review").put("message",result.optString("message"));save();return status();
    }
    throw new IOException("rhTV 控制操作无效");
  }
  private static JSObject response(Object body,int code){return new JSObject().put("status",code).put("body",body.toString()).put("bodyEncoding","text").put("contentType","application/json");}
  private JSONObject body(JSObject payload)throws Exception{Object raw=payload.opt("body");return raw instanceof JSONObject?(JSONObject)raw:new JSONObject(raw==null?"{}":String.valueOf(raw));}
  private Object request(JSObject payload)throws Exception{
    Uri uri=Uri.parse(payload.getString("url"));if(!ORIGIN.equals(uri.getScheme()+"://"+uri.getAuthority())||uri.getQuery()!=null||uri.getFragment()!=null)throw new IOException("只接受受管 rhTV 本机协议地址");
    String path=uri.getPath(),method=payload.optString("method","GET").toUpperCase(Locale.ROOT);
    if(method.equals("GET")&&"/v1/health".equals(path))return response(new JSONObject().put("protocol_version",1).put("ready",true),200);
    if(method.equals("GET")&&"/v1/session".equals(path))return response(status(),200);
    if(method.equals("GET")&&"/v1/capabilities".equals(path))return response(new JSONObject().put("model_key","minimax-h3-rh-enhanced").put("automatic_submission",automatic).put("automation_supported",true).put("max_images",9).put("cost_policy","free_only").put("verified",false),200);
    if(method.equals("POST")&&"/v1/assets".equals(path)){
      String data;if(payload.optJSONObject("multipart")!=null)data=payload.getJSONObject("multipart").getJSONArray("files").getJSONObject(0).getString("dataUrl");else data=body(payload).getString("data_url");
      java.util.regex.Matcher match=java.util.regex.Pattern.compile("^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$").matcher(data);if(!match.matches())throw new IOException("仅支持 PNG、JPEG、WebP 原图");
      byte[] bytes=Base64.decode(match.group(2),Base64.DEFAULT);String checksum=NativeStore.sha(bytes),upload=checksum+"_"+match.group(1);NativeStore.atomic(new File(uploads,upload),bytes);
      return response(new JSONObject().put("upload_id",upload).put("checksum",checksum).put("size_bytes",bytes.length),200);
    }
    if(method.equals("POST")&&"/v1/videos".equals(path))return response(accept(body(payload)),200);
    if(path!=null&&path.startsWith("/v1/videos/by-client/")){String client=Uri.decode(path.substring(21));for(JSONObject job:jobs.values())if(job.optString("client_id").equals(client))return response(publicJob(job),200);return response(new JSONObject().put("message","桥接日志未找到原任务；不会自动重新提交"),404);}
    if(path!=null&&path.startsWith("/v1/videos/")){String tail=path.substring(11);boolean cancellation=tail.endsWith("/cancel");String id=cancellation?tail.substring(0,tail.length()-7):tail;JSONObject job=get(id);if(cancellation&&method.equals("POST"))cancel(job);else if(method.equals("GET")&&hasTask(job)&&!terminal(job)&&!job.optString("status").equals("download_failed"))refresh(job);else if(!method.equals("GET"))throw new IOException("不支持的 rhTV 请求");return response(publicJob(job),200);}
    return response(new JSONObject().put("message","不支持的 rhTV 本机端点"),404);
  }
  private Object canonical(Object value)throws Exception{if(value instanceof JSONObject){JSONObject out=new JSONObject();List<String> keys=new ArrayList<>();((JSONObject)value).keys().forEachRemaining(keys::add);Collections.sort(keys);for(String key:keys)out.put(key,canonical(((JSONObject)value).get(key)));return out;}if(value instanceof JSONArray){JSONArray out=new JSONArray();for(int i=0;i<((JSONArray)value).length();i++)out.put(canonical(((JSONArray)value).get(i)));return out;}return value;}
  private JSONObject accept(JSONObject request)throws Exception{
    if(request.optInt("protocol_version")!=1||!request.optString("model_key").equals("minimax-h3-rh-enhanced")||!request.optString("cost_policy").equals("free_only")||!validId(request.optString("client_id"))||request.optString("prompt").trim().isEmpty())throw new IOException("rhTV 原任务协议无效");
    String fingerprint=NativeStore.sha(canonical(request).toString().getBytes(StandardCharsets.UTF_8));
    for(JSONObject old:jobs.values())if(old.optString("client_id").equals(request.getString("client_id"))){if(!old.optString("fingerprint").equals(fingerprint))throw new IOException("同一原任务标识对应不同输入，未重复生成");return publicJob(old);}
    JSONArray refs=request.getJSONArray("references");for(int i=0;i<refs.length();i++)asset(refs.getJSONObject(i).getString("upload_id"));
    JSONObject job=new JSONObject().put("id",UUID.randomUUID().toString()).put("client_id",request.getString("client_id")).put("request",new JSONObject(request.toString())).put("fingerprint",fingerprint).put("created_at",System.currentTimeMillis()).put("status","waiting_review").put("handed_off",false).put("automatic",false).put("submission_started",false).put("message","原稿、原图及参数已保存，等待自动执行或人工准备网页。");jobs.put(job.getString("id"),job);save();return publicJob(job);
  }
  private File asset(String upload)throws Exception{if(!upload.matches("[a-f0-9]{64}_(png|jpeg|webp)"))throw new IOException("原图标识无效");File file=new File(uploads,upload);if(!file.isFile()||!NativeStore.shaFile(file).equals(upload.split("_")[0]))throw new IOException("原图已丢失或发生变化");return file;}
  private JSONArray files(JSONObject job)throws Exception{JSONArray result=new JSONArray(),refs=job.getJSONObject("request").getJSONArray("references");for(int i=0;i<refs.length();i++){String id=refs.getJSONObject(i).getString("upload_id");result.put(new JSONObject().put("upload_id",id).put("base64",Base64.encodeToString(Files.readAllBytes(asset(id).toPath()),Base64.NO_WRAP)));}return result;}
  private void cancel(JSONObject job)throws Exception{if(terminal(job))return;if(job.optBoolean("handed_off")&&(!job.optBoolean("automatic")||job.optBoolean("submission_started")))job.put("status","submission_unknown").put("message","网页已交接，无法确认远端取消；保留原任务占位。");else job.put("status","cancelled").put("message","已取消本机待提交任务，未发出生成请求。");save();}
  private void tick()throws Exception{
    if(!running||destroyed)return;
    JSONObject selected=null;for(JSONObject job:jobs.values())if(!terminal(job)&&job.optBoolean("handed_off")){selected=job;break;}
    if(selected==null&&automatic)for(JSONObject job:jobs.values())if(job.optString("status").equals("waiting_review")&&!job.optBoolean("handed_off")){selected=job;break;}
    if(selected==null)return;
    if(hasTask(selected)){if(!selected.optString("status").equals("download_failed")&&selected.optLong("next_check")<=System.currentTimeMillis())refresh(selected);return;}
    if(selected.optBoolean("handed_off")){
      if(selected.optBoolean("submission_started")&&selected.optJSONObject("upstream")!=null) {
        try{Page page=open(selected.getString("id"),selected.getJSONObject("upstream").optString("page_url",ENTRY),false);JSONObject recovered=execute(page,"recover",new JSONObject().put("job",selected),selected);if(recovered.optJSONObject("upstream")!=null&&recovered.getJSONObject("upstream").has("task_id")){selected.put("upstream",recovered.getJSONObject("upstream")).put("status","running").put("message","已从原网页恢复任务编号，未重新提交。");save();}}
        catch(Exception ignored){}
      }
      return;
    }
    if(!automatic)return;
    JSONObject job=selected;job.put("automatic",true).put("handed_off",true).put("status","preparing").put("message","正在 rhTV 网页填写原稿、上传原图。");save();
    try{Page page=open(job.getString("id"),ENTRY,false);execute(page,"prepare",new JSONObject().put("job",job).put("files",files(job)).put("manual",false),job);if(!automatic||!running)throw new IOException("自动提交已暂停");JSONObject result=execute(page,"submit",new JSONObject().put("job",job),job);if(result.optJSONObject("upstream")!=null)job.put("upstream",result.getJSONObject("upstream"));job.put("status",hasTask(job)?"running":"submission_unknown").put("message",hasTask(job)?"已取得 rhTV 原任务编号，正在跟踪。":"回执未确认，保留原任务占位，不重投。");save();}
    catch(Exception error){job.put("status",hasTask(job)?"running":job.optBoolean("submission_started")?"submission_unknown":"paused").put("message","rhTV 自动执行暂停："+message(error)+"；不会重复提交。");save();}
  }
  private void refresh(JSONObject job)throws Exception{
    try{JSONObject upstream=job.getJSONObject("upstream");Page page=open(job.getString("id"),upstream.getString("page_url"),false);JSONObject result=execute(page,"poll",new JSONObject().put("job",job),job);
      if(result.optString("status").equals("failed")){job.put("status","failed").put("message",result.optString("message"));save();close(job.getString("id"));return;}
      if(!result.optString("status").equals("succeeded")){job.put("status","running").put("next_check",System.currentTimeMillis()+5000).put("message",result.optString("message","原任务排队或生成中。"));save();return;}
      job.put("status","downloading").put("message","原任务已完成，正在下载成片。");save();
      try{JSONObject media=fetchMedia(page,result.getString("url"));job.put("media",media).put("status","succeeded").put("message","原任务成片已下载并可入库。");save();close(job.getString("id"));}
      catch(Exception error){job.put("status","download_failed").put("message","原任务已生成，下载暂停："+message(error)+"；可继续原任务下载，不重新生成。");save();}
    }catch(Exception error){job.put("status","reconnecting").put("next_check",System.currentTimeMillis()+30000).put("message","原任务查询暂停："+message(error)+"；没有重新提交。");save();}
  }
  private JSONObject fetchMedia(Page page,String address)throws Exception{
    URL source=new URL(address);if(!source.getProtocol().equals("https"))throw new IOException("rhTV 成片必须使用 HTTPS 地址");
    String cookie=ui(()->WebViewCompat.getProfile(page.view).getCookieManager().getCookie(address));HttpURLConnection connection=null;
    for(int redirect=0;redirect<6;redirect++){connection=(HttpURLConnection)source.openConnection();connection.setConnectTimeout(30000);connection.setReadTimeout(120000);connection.setInstanceFollowRedirects(false);if(cookie!=null)connection.setRequestProperty("Cookie",cookie);int status=connection.getResponseCode();if(status>=300&&status<400){URL next=new URL(source,connection.getHeaderField("Location"));if(!next.getProtocol().equals("https"))throw new IOException("成片重定向不是 HTTPS");if(!next.getHost().equals(source.getHost()))cookie=null;connection.disconnect();source=next;connection=null;continue;}if(status<200||status>=300){connection.disconnect();throw new IOException("rhTV 成片下载失败（"+status+"）");}break;}
    if(connection==null)throw new IOException("成片下载重定向过多");File temp=new File(root,"download-"+UUID.randomUUID()+".part");try{try(InputStream input=connection.getInputStream();FileOutputStream output=new FileOutputStream(temp)){copy(input,output);output.getFD().sync();}return storeMedia(temp);}finally{connection.disconnect();temp.delete();}
  }
  private JSONObject storeMedia(File source)throws Exception{
    if(source.length()==0||source.length()>2L*1024*1024*1024)throw new IOException("原任务视频为空或超过 2 GB");
    MediaMetadataRetriever retriever=new MediaMetadataRetriever();String mime;
    try{retriever.setDataSource(source.getAbsolutePath());if(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)==null)throw new IOException("所选文件没有视频轨道");mime=retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE);}finally{retriever.release();}
    String ext=mime!=null&&mime.contains("webm")?".webm":mime!=null&&mime.contains("quicktime")?".mov":".mp4";String checksum=NativeStore.shaFile(source),relative="video/"+checksum+ext;File target=new File(assets,relative);target.getParentFile().mkdirs();Files.copy(source.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING);
    return new JSONObject().put("fileName","rhTV-"+checksum.substring(0,12)+ext).put("relativePath",relative).put("checksum",checksum).put("sizeBytes",target.length()).put("mediaType","video").put("mimeType",mime==null?"video/mp4":mime).put("managed",true).put("missing",false).put("url","lianhua-asset://local/"+relative);
  }
  private void importResult(JSONObject job,String address)throws Exception{if(!job.optBoolean("handed_off")||terminal(job))throw new IOException("仅可导入已交接且未结束的原任务成片");File temp=new File(root,"import-"+UUID.randomUUID()+".part");try{Uri uri=Uri.parse(address);try(InputStream in="content".equals(uri.getScheme())?activity.getContentResolver().openInputStream(uri):new FileInputStream("file".equals(uri.getScheme())?uri.getPath():address);FileOutputStream out=new FileOutputStream(temp)){if(in==null)throw new IOException("未读取到所选成片");copy(in,out);out.getFD().sync();}job.put("media",storeMedia(temp)).put("status","succeeded").put("message","用户已导入原任务成片，视频轨道已读取。");save();close(job.getString("id"));}finally{temp.delete();}}
  private Object download(JSObject payload)throws Exception{Uri uri=Uri.parse(payload.getString("url"));String path=uri.getPath();if(!ORIGIN.equals(uri.getScheme()+"://"+uri.getAuthority())||path==null||!path.matches("/v1/videos/[a-f0-9-]{36}/content"))throw new IOException("rhTV 结果地址不属于原任务");JSONObject job=get(path.substring(11,path.length()-8));if(!job.optString("status").equals("succeeded")||!job.has("media"))throw new IOException("原任务尚无可用结果");JSONObject media=job.getJSONObject("media");File file=new File(assets,media.getString("relativePath"));if(!file.isFile()||!NativeStore.shaFile(file).equals(media.getString("checksum")))throw new IOException("原任务成片丢失或损坏");return media;}
  private void shareMaterials(JSONObject job)throws Exception{File folder=new File(activity.getCacheDir(),"rhtv-materials/"+job.getString("id"));folder.mkdirs();JSONArray refs=new JSONArray(),original=job.getJSONObject("request").getJSONArray("references");ArrayList<Uri> files=new ArrayList<>();for(int i=0;i<original.length();i++){JSONObject ref=new JSONObject(original.getJSONObject(i).toString());String upload=ref.getString("upload_id"),ext=upload.substring(upload.indexOf('_')+1),name="slot-"+(ref.optInt("slot_index")+1)+"."+ext;File target=new File(folder,name);Files.copy(asset(upload).toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING);ref.put("file_name",name);refs.put(ref);files.add(FileProvider.getUriForFile(activity,activity.getPackageName()+".fileprovider",target));}JSONObject manifest=new JSONObject(job.getJSONObject("request").toString()).put("references",refs);File file=new File(folder,"manifest.json");NativeStore.atomic(file,manifest.toString());files.add(FileProvider.getUriForFile(activity,activity.getPackageName()+".fileprovider",file));ui(()->{Intent share=new Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*").putParcelableArrayListExtra(Intent.EXTRA_STREAM,files).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);activity.startActivity(Intent.createChooser(share,"导出原任务素材与清单"));return true;});}
  private void close(String id)throws Exception{ui(()->{Page page=pages.remove(id);if(page!=null){page.dialog.dismiss();page.view.destroy();}return true;});}
  private static void copy(InputStream input,OutputStream output)throws IOException{byte[] b=new byte[65536];int n;while((n=input.read(b))!=-1)output.write(b,0,n);}
  private static byte[] readBytes(InputStream input)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();copy(input,out);return out.toByteArray();}
  public void destroy(){destroyed=true;running=false;automatic=false;main.post(()->{for(Page page:pages.values()){page.dialog.dismiss();page.view.destroy();}pages.clear();});worker.shutdownNow();}
}
