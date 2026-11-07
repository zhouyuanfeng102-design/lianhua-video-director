package com.lianhua.video_director;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.*;
import androidx.core.graphics.Insets;
import com.getcapacitor.*;
import java.io.*;
import java.util.*;

public final class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle state){
    registerPlugin(LianhuaNativePlugin.class);super.onCreate(state);
    bridge.getWebView().getSettings().setTextZoom(100);
    WindowCompat.setDecorFitsSystemWindows(getWindow(),false);
    ViewCompat.setOnApplyWindowInsetsListener(bridge.getWebView(),(view,insets)->{
      Insets bars=insets.getInsets(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.displayCutout());
      Insets keyboard=insets.getInsets(WindowInsetsCompat.Type.ime());view.setPadding(bars.left,bars.top,bars.right,Math.max(bars.bottom,keyboard.bottom));return WindowInsetsCompat.CONSUMED;
    });
    bridge.setWebViewClient(new BridgeWebViewClient(bridge){
      @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
        Uri url=request.getUrl();
        if("lianhua-asset".equals(url.getScheme())||"https".equals(url.getScheme())&&"localhost".equals(url.getHost())&&url.getPath().startsWith("/_lianhua_asset/"))return asset(request);return super.shouldInterceptRequest(view,request);
      }
    });
    getOnBackPressedDispatcher().addCallback(this,new OnBackPressedCallback(true){@Override public void handleOnBackPressed(){PluginHandle handle=bridge.getPlugin("LianhuaNative");if(handle!=null)((LianhuaNativePlugin)handle.getInstance()).back();}});
  }
  private WebResourceResponse asset(WebResourceRequest request){try{
    String requestedPath=request.getUrl().getPath();if(requestedPath.startsWith("/_lianhua_asset/"))requestedPath=requestedPath.substring("/_lianhua_asset/".length());else requestedPath=requestedPath.replaceFirst("^/","");
    File root=new File(getFilesDir(),"lianhua/assets").getCanonicalFile();File f=new File(root,requestedPath).getCanonicalFile();
    if(!f.getPath().startsWith(root.getPath()+File.separator)||!f.isFile())return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
    long length=f.length(),start=0,end=length-1;String range=request.getRequestHeaders().get("Range");if(range==null)range=request.getRequestHeaders().get("range");
    if(range!=null&&range.startsWith("bytes=")){String[] values=range.substring(6).split("-",2);if(!values[0].isEmpty())start=Long.parseLong(values[0]);if(values.length>1&&!values[1].isEmpty())end=Math.min(end,Long.parseLong(values[1]));}
    if(start<0||start>=length||end<start)return new WebResourceResponse("text/plain","UTF-8",416,"Range Not Satisfiable",Collections.singletonMap("Content-Range","bytes */"+length),new ByteArrayInputStream(new byte[0]));
    FileInputStream input=new FileInputStream(f);long skipped=0;while(skipped<start){long n=input.skip(start-skipped);if(n<=0)break;skipped+=n;}final long count=end-start+1;
    InputStream bounded=new FilterInputStream(input){long left=count;@Override public int read()throws IOException{if(left<=0)return -1;int value=super.read();if(value>=0)left--;return value;}@Override public int read(byte[] b,int off,int len)throws IOException{if(left<=0)return -1;int n=super.read(b,off,(int)Math.min(len,left));if(n>0)left-=n;return n;}};
    Map<String,String> headers=new HashMap<>();headers.put("Access-Control-Allow-Origin","https://localhost");headers.put("Accept-Ranges","bytes");headers.put("Content-Length",Long.toString(count));headers.put("Cache-Control","private, max-age=3600");
    if(range!=null)headers.put("Content-Range","bytes "+start+"-"+end+"/"+length);
    return new WebResourceResponse(NativeFiles.mime(f.getName()),null,range==null?200:206,range==null?"OK":"Partial Content",headers,bounded);
  }catch(Exception e){return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}}
}
