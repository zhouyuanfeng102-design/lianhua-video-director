package com.lianhua.video_director;

import android.app.*;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.*;
import androidx.core.app.NotificationCompat;

/** Visible foreground lifetime for active native transfers and video exports. */
public final class NativeTransferService extends Service {
  private static final String CHANNEL="lianhua-active-work";
  @Override public void onCreate(){super.onCreate();NotificationManager manager=getSystemService(NotificationManager.class);manager.createNotificationChannel(new NotificationChannel(CHANNEL,"生成与下载进度",NotificationManager.IMPORTANCE_LOW));}
  @Override public int onStartCommand(Intent intent,int flags,int id){
    Intent activity=new Intent(this,MainActivity.class);PendingIntent pending=PendingIntent.getActivity(this,0,activity,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
    Notification notification=new NotificationCompat.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle("莲华视频导演台").setContentText("正在执行生成、下载或视频处理；点击返回查看进度").setContentIntent(pending).setOngoing(true).build();
    if(Build.VERSION.SDK_INT>=29)startForeground(7001,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);else startForeground(7001,notification);
    return START_NOT_STICKY;
  }
  @Override public IBinder onBind(Intent intent){return null;}
  @Override public void onTimeout(int startId,int fgsType){stopSelf();}
}
