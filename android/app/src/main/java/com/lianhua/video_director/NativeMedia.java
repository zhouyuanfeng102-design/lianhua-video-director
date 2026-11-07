package com.lianhua.video_director;

import android.content.Context;
import android.graphics.*;
import android.media.MediaMetadataRetriever;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.*;
import android.util.Base64;
import androidx.media3.common.*;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.effect.Presentation;
import androidx.media3.transformer.*;
import org.json.*;
import java.io.*;
import java.nio.*;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;

/** Native decoding and hardware accelerated H.264/AAC timeline export. */
final class NativeMedia {
  final Context context;final NativeFiles files;final NativeTransport.Events events;
  final Handler main=new Handler(Looper.getMainLooper());
  final Map<String,Transformer> renders=new ConcurrentHashMap<>();final Set<String> cancelled=ConcurrentHashMap.newKeySet();
  NativeMedia(Context c,NativeFiles f,NativeTransport.Events e){context=c;files=f;events=e;}
  File source(JSONObject p)throws Exception {File f=files.managed(p.getString("relativePath"));String expected=p.optString("expectedChecksum");if(!expected.isEmpty()&&!NativeStore.shaFile(f).equals(expected))throw new IOException("源视频内容已变化，请重新选择");return f;}
  JSONObject probe(JSONObject p)throws Exception {
    MediaMetadataRetriever r=new MediaMetadataRetriever();try{File f=source(p);r.setDataSource(f.getAbsolutePath());return enrich(probe(r),f);}finally{r.release();}
  }
  JSONObject enrich(JSONObject result,File file)throws Exception{MediaExtractor extractor=new MediaExtractor();try{extractor.setDataSource(file.getAbsolutePath());for(int i=0;i<extractor.getTrackCount();i++){MediaFormat f=extractor.getTrackFormat(i);String m=f.getString(MediaFormat.KEY_MIME);if(m==null)continue;if(m.startsWith("video/")){result.put("videoCodec",m);if(f.containsKey(MediaFormat.KEY_FRAME_RATE))result.put("fps",f.getInteger(MediaFormat.KEY_FRAME_RATE));}else if(m.startsWith("audio/")){result.put("hasAudio",true).put("audioCodec",m);if(f.containsKey(MediaFormat.KEY_SAMPLE_RATE))result.put("audioSampleRate",f.getInteger(MediaFormat.KEY_SAMPLE_RATE));if(f.containsKey(MediaFormat.KEY_CHANNEL_COUNT))result.put("audioChannels",f.getInteger(MediaFormat.KEY_CHANNEL_COUNT));}}}finally{extractor.release();}return result;}
  double value(MediaMetadataRetriever r,int key,double fallback){try{return Double.parseDouble(r.extractMetadata(key));}catch(Exception e){return fallback;}}
  JSONObject probe(MediaMetadataRetriever r)throws Exception {
    double duration=value(r,MediaMetadataRetriever.METADATA_KEY_DURATION,0)/1000.;double fps=value(r,MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE,30);
    int width=(int)value(r,MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH,0),height=(int)value(r,MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT,0);
    int rotation=(int)value(r,MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION,0);if(rotation==90||rotation==270){int t=width;width=height;height=t;}
    boolean audio="yes".equals(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO));
    long frameCount=Build.VERSION.SDK_INT>=28?(long)value(r,MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT,Math.ceil(duration*fps)):(long)Math.ceil(duration*fps);
    return new JSONObject().put("durationSec",duration).put("width",width).put("height",height).put("fps",fps).put("frameCount",frameCount).put("hasAudio",audio).put("videoCodec",r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE));
  }
  JSONObject thumbnail(JSONObject p,boolean video)throws Exception {
    File f=source(p);Bitmap bitmap;
    if(video){MediaMetadataRetriever r=new MediaMetadataRetriever();try{r.setDataSource(f.getAbsolutePath());bitmap=r.getFrameAtTime(0,MediaMetadataRetriever.OPTION_CLOSEST_SYNC);}finally{r.release();}}
    else {BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeFile(f.getAbsolutePath(),bounds);BitmapFactory.Options o=new BitmapFactory.Options();o.inSampleSize=Math.max(1,Math.max(bounds.outWidth,bounds.outHeight)/160);bitmap=BitmapFactory.decodeFile(f.getAbsolutePath(),o);
      if(bitmap!=null)try{int orientation=new ExifInterface(f.getAbsolutePath()).getAttributeInt(ExifInterface.TAG_ORIENTATION,ExifInterface.ORIENTATION_NORMAL);Matrix matrix=new Matrix();switch(orientation){case ExifInterface.ORIENTATION_ROTATE_90:matrix.postRotate(90);break;case ExifInterface.ORIENTATION_ROTATE_180:matrix.postRotate(180);break;case ExifInterface.ORIENTATION_ROTATE_270:matrix.postRotate(270);break;case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:matrix.postScale(-1,1);break;case ExifInterface.ORIENTATION_FLIP_VERTICAL:matrix.postScale(1,-1);break;default:break;}if(!matrix.isIdentity()){Bitmap oriented=Bitmap.createBitmap(bitmap,0,0,bitmap.getWidth(),bitmap.getHeight(),matrix,true);if(oriented!=bitmap)bitmap.recycle();bitmap=oriented;}}catch(IOException ignored){}
    }
    if(bitmap==null)throw new IOException("系统无法解码此媒体预览");int width=bitmap.getWidth(),height=bitmap.getHeight();
    int maxSize=video?480:160;
    if(Math.max(width,height)>maxSize){float scale=(float)maxSize/Math.max(width,height);Bitmap scaled=Bitmap.createScaledBitmap(bitmap,Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)),true);bitmap.recycle();bitmap=scaled;}
    JSONObject result=bitmapData(bitmap);result.put("cacheKey",NativeStore.sha((p.optString("relativePath")+f.lastModified()).getBytes(java.nio.charset.StandardCharsets.UTF_8)));bitmap.recycle();return result;
  }
  JSONObject bitmapData(Bitmap b)throws Exception{ByteArrayOutputStream out=new ByteArrayOutputStream();b.compress(Bitmap.CompressFormat.PNG,100,out);byte[] bytes=out.toByteArray();return new JSONObject().put("dataUrl","data:image/png;base64,"+Base64.encodeToString(bytes,Base64.NO_WRAP)).put("mimeType","image/png").put("width",b.getWidth()).put("height",b.getHeight()).put("sizeBytes",bytes.length);}
  void progress(JSONObject p,String kind,String stage,int percent,String message){try{events.send("workbenchProgress",new JSONObject().put("jobId",p.optString("jobId")).put("projectId",p.optString("projectId")).put("kind",kind).put("stage",stage).put("percent",percent).put("message",message));}catch(Exception ignored){}}
  JSONObject extract(JSONObject p)throws Exception {
    String id=p.getString("jobId");cancelled.remove(id);MediaMetadataRetriever r=new MediaMetadataRetriever();
    try{File sourceFile=source(p.getJSONObject("source"));r.setDataSource(sourceFile.getAbsolutePath());JSONObject probe=enrich(probe(r),sourceFile);double duration=probe.getDouble("durationSec"),fps=probe.getDouble("fps");
      String mode=p.optString("mode","first");int count=mode.equals("boundaries")?2:mode.equals("uniform")?Math.max(1,p.optInt("count",6)):1;
      double start=Math.max(0,p.optDouble("inSec",0)),end=Math.min(duration,p.optDouble("outSec",duration));JSONArray frames=new JSONArray();progress(p,"extract","processing",0,"正在读取视频帧");
      for(int i=0;i<count;i++){if(cancelled.contains(id))throw new IOException("抽帧已取消");double time=mode.equals("first")?start:mode.equals("last")?Math.max(start,end-1/fps):mode.equals("time")?p.optDouble("timeSec",start):mode.equals("frame")?p.optInt("frameIndex",0)/fps:count==1?start:start+(Math.max(0,end-start-1/fps))*i/(count-1);
        time=Math.max(start,Math.min(time,Math.max(start,end-.001)));Bitmap b;
        if(Build.VERSION.SDK_INT>=28&&(mode.equals("last")||mode.equals("boundaries")&&i==count-1)&&!p.has("outSec"))b=r.getFrameAtIndex(Math.max(0,probe.optInt("frameCount",1)-1));
        else if(mode.equals("frame")&&Build.VERSION.SDK_INT>=28)b=r.getFrameAtIndex(p.optInt("frameIndex",0));else b=r.getFrameAtTime((long)(time*1000000),MediaMetadataRetriever.OPTION_CLOSEST);
        if(b==null)throw new IOException("系统无法解码所选视频帧");ByteArrayOutputStream out=new ByteArrayOutputStream();b.compress(Bitmap.CompressFormat.PNG,100,out);
        JSONObject asset=files.storeBytes(out.toByteArray(),p.optString("fileName","视频帧")+"-"+(i+1)+".png","image/png",p.optString("projectId"));
        asset.put("timeSec",time).put("width",b.getWidth()).put("height",b.getHeight()).put("role",mode.equals("first")||(mode.equals("boundaries")&&i==0)?"first-frame":mode.equals("last")||(mode.equals("boundaries")&&i==count-1)?"last-frame":"custom-frame");
        if(mode.equals("frame"))asset.put("frameIndex",p.optInt("frameIndex",0));frames.put(asset);b.recycle();progress(p,"extract","processing",Math.round(100f*(i+1)/count),"已读取 "+(i+1)+" / "+count+" 帧");
      }
      progress(p,"extract","completed",100,"视频帧已保存");return new JSONObject().put("probe",probe).put("frames",frames);
    }finally{r.release();cancelled.remove(id);}
  }
  boolean cancel(String id){cancelled.add(id);Transformer t=renders.remove(id);if(t!=null)main.post(t::cancel);return true;}
  void close(){for(String id:new ArrayList<>(renders.keySet()))cancel(id);}
  static final class Gain extends BaseAudioProcessor {
    final float volume;Gain(float volume){this.volume=volume;}
    @Override protected AudioFormat onConfigure(AudioFormat format)throws UnhandledAudioFormatException{if(format.encoding!=C.ENCODING_PCM_16BIT&&format.encoding!=C.ENCODING_PCM_FLOAT)throw new UnhandledAudioFormatException(format);return format;}
    @Override public void queueInput(ByteBuffer input){ByteBuffer out=replaceOutputBuffer(input.remaining());if(inputAudioFormat.encoding==C.ENCODING_PCM_FLOAT){while(input.remaining()>=4)out.putFloat(Math.max(-1,Math.min(1,input.getFloat()*volume)));}else while(input.remaining()>=2)out.putShort((short)Math.max(Short.MIN_VALUE,Math.min(Short.MAX_VALUE,Math.round(input.getShort()*volume))));out.flip();}
  }
  JSONObject render(JSONObject p)throws Exception {
    String id=p.getString("jobId");cancelled.remove(id);JSONArray clips=p.getJSONArray("clips");if(clips.length()==0)throw new IOException("请先添加时间线片段");
    List<EditedMediaItem> items=new ArrayList<>();JSONObject output=p.optJSONObject("output");
    for(int i=0;i<clips.length();i++){JSONObject clip=clips.getJSONObject(i);JSONObject transition=clip.optJSONObject("transitionAfter");
      if(transition!=null&&transition.optString("type").equals("crossfade")&&transition.optDouble("durationSec")>0)throw new IOException("安卓原生合成当前支持直接拼接；交叉淡化请在电脑版导出");
      File f=source(clip.getJSONObject("source"));MediaItem item=new MediaItem.Builder().setUri(Uri.fromFile(f)).setClippingConfiguration(new MediaItem.ClippingConfiguration.Builder().setStartPositionMs(Math.round(clip.optDouble("inSec")*1000)).setEndPositionMs(Math.round(clip.getDouble("outSec")*1000)).build()).build();
      List<androidx.media3.common.audio.AudioProcessor> audio=new ArrayList<>();float gain=(float)clip.optDouble("volume",1);if(gain!=1&&gain>0)audio.add(new Gain(gain));
      List<Effect> video=new ArrayList<>();if(output!=null&&output.optInt("height")>0&&output.optInt("width")>0)video.add(Presentation.createForWidthAndHeight(output.getInt("width"),output.getInt("height"),Presentation.LAYOUT_SCALE_TO_FIT));
      EditedMediaItem.Builder edited=new EditedMediaItem.Builder(item).setRemoveAudio(gain==0).setEffects(new Effects(audio,video));if(output!=null&&output.optInt("fps")>0)edited.setFrameRate(output.getInt("fps"));items.add(edited.build());
    }
    if(output!=null&&(output.optDouble("fadeInSec")>0||output.optDouble("fadeOutSec")>0))throw new IOException("安卓原生合成当前不支持视频淡入淡出，请在电脑版导出此特效");
    List<EditedMediaItemSequence> sequences=new ArrayList<>();sequences.add(EditedMediaItemSequence.withAudioAndVideoFrom(items));JSONObject audio=p.optJSONObject("audio");
    if(audio!=null&&audio.optJSONObject("bgm")!=null){File bgm=source(audio.getJSONObject("bgm"));
      if(audio.optBoolean("ducking")||audio.optDouble("fadeInSec")>0||audio.optDouble("fadeOutSec")>0)throw new IOException("安卓BGM合成支持固定音量；自动闪避与淡入淡出请在电脑版导出");
      EditedMediaItem music=new EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(bgm))).setRemoveVideo(true).setEffects(new Effects(Collections.singletonList(new Gain((float)audio.optDouble("bgmVolume",.16))),Collections.emptyList())).build();
      sequences.add(new EditedMediaItemSequence.Builder(Collections.singleton(C.TRACK_TYPE_AUDIO)).addItem(music).setIsLooping(true).build());}
    Composition composition=new Composition.Builder(sequences).build();File target=new File(context.getCacheDir(),"render-"+UUID.randomUUID()+".mp4");
    CountDownLatch latch=new CountDownLatch(1);Throwable[] error={null};progress(p,"render","preparing",0,"正在准备原生视频合成");
    main.post(()->{try{Transformer transformer=new Transformer.Builder(context).setVideoMimeType(MimeTypes.VIDEO_H264).setAudioMimeType(MimeTypes.AUDIO_AAC).addListener(new Transformer.Listener(){
        @Override public void onCompleted(Composition c,ExportResult r){renders.remove(id);latch.countDown();}
        @Override public void onError(Composition c,ExportResult r,ExportException e){error[0]=e;renders.remove(id);latch.countDown();}
      }).build();renders.put(id,transformer);transformer.start(composition,target.getAbsolutePath());}catch(Throwable e){error[0]=e;latch.countDown();}});
    try{while(!latch.await(500,TimeUnit.MILLISECONDS)){if(cancelled.contains(id))throw new IOException("合成已取消");main.post(()->{Transformer t=renders.get(id);if(t!=null){ProgressHolder holder=new ProgressHolder();if(t.getProgress(holder)==Transformer.PROGRESS_STATE_AVAILABLE)progress(p,"render","processing",holder.progress,"正在合成视频");}});}
      if(error[0]!=null)throw new IOException("原生视频合成失败："+error[0].getMessage(),error[0]);
      JSONObject result=files.storeFile(target,output==null?"合成视频.mp4":output.optString("fileName","合成视频.mp4"),"video/mp4",p.optString("projectId"));
      JSONObject probe=probe(new JSONObject().put("relativePath",result.getString("relativePath")));progress(p,"render","completed",100,"合成视频已保存");return result.put("probe",probe).put("renderMode","transcode");
    }finally{target.delete();renders.remove(id);cancelled.remove(id);}
  }
}
