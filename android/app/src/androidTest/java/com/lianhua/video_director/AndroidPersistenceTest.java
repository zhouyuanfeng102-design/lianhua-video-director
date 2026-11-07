package com.lianhua.video_director;

import android.content.Context;
import android.content.ContextWrapper;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import static org.junit.Assert.*;

/** Device-only checks in an isolated directory. No user projects, credentials,
 * model endpoint or real generator task are read or invoked. */
@RunWith(AndroidJUnit4.class)
public class AndroidPersistenceTest {
  private File scratch;
  private Context context;
  @Before public void before() {
    Context target=InstrumentationRegistry.getInstrumentation().getTargetContext();
    scratch=new File(target.getCacheDir(),"native-test-"+UUID.randomUUID());scratch.mkdirs();
    context=isolated(target,scratch);
  }
  private Context isolated(Context target,File base) {
    return new ContextWrapper(target) {
      @Override public File getFilesDir(){File f=new File(base,"files");f.mkdirs();return f;}
      @Override public File getCacheDir(){File f=new File(base,"cache");f.mkdirs();return f;}
    };
  }
  @After public void after(){NativeFiles.delete(scratch);}
  private JSONObject state(String key) throws Exception {
    JSONObject project=new JSONObject().put("id","project-test").put("name","手机项目😀").put("createdAt",1).put("updatedAt",2);
    for(String name:new String[]{"sourceDocuments","scenes","storyboards","assets","generationTasks"})project.put(name,new JSONArray());
    JSONObject settings=new JSONObject().put("textApi",new JSONObject().put("apiKey",key).put("baseUrl","https://example.invalid"))
      .put("textApiProfiles",new JSONArray().put(new JSONObject().put("id","profile-b").put("apiKey","fixture-profile-b")).put(new JSONObject().put("id","profile-a").put("apiKey","fixture-profile-a")));
    return new JSONObject().put("schemaVersion",24).put("project",project).put("projects",new JSONArray().put(project)).put("activeProjectId","project-test").put("settings",settings);
  }
  @Test public void nativeRestartPreservesProjectsAndEncryptedKeys() throws Exception {
    NativeStore store=new NativeStore(context);JSONObject original=state("fixture-api-key-one");
    store.save(original.toString());
    JSONObject reloaded=new JSONObject(new NativeStore(context).load(false));
    assertEquals("手机项目😀",reloaded.getJSONObject("project").getString("name"));
    assertEquals("fixture-api-key-one",reloaded.getJSONObject("settings").getJSONObject("textApi").getString("apiKey"));
    JSONArray profiles=reloaded.getJSONObject("settings").getJSONArray("textApiProfiles");
    JSONArray reordered=new JSONArray().put(profiles.get(1)).put(profiles.get(0));
    reloaded.getJSONObject("settings").put("textApiProfiles",reordered);
    store.save(reloaded.toString());
    JSONArray restored=new JSONObject(new NativeStore(context).load(false)).getJSONObject("settings").getJSONArray("textApiProfiles");
    assertEquals("profile-a",restored.getJSONObject(0).getString("id"));
    assertEquals("fixture-profile-a",restored.getJSONObject(0).getString("apiKey"));
    assertFalse("API keys must not appear in durable files",containsSecret(store.root,"fixture-api-key-one"));
    assertFalse(containsSecret(store.root,"fixture-profile-a"));
    assertTrue(store.blocks.listFiles().length>0);
  }
  @Test public void failedIndexWriteKeepsThePreviousProjectAndKeyPair() throws Exception {
    NativeStore store=new NativeStore(context);store.save(state("fixture-old-key").toString());
    File blocked=new File(store.root,"state.json.pending");assertTrue(blocked.mkdir());
    try {store.save(state("fixture-new-key").put("activeProjectId","project-test").toString());fail("Expected an index write failure");}
    catch(IOException expected) { /* An orphan immutable block/vault cannot replace the committed index. */ }
    finally {assertTrue(blocked.delete());}
    JSONObject result=new JSONObject(new NativeStore(context).load(false));
    assertEquals("fixture-old-key",result.getJSONObject("settings").getJSONObject("textApi").getString("apiKey"));
  }
  @Test public void taskCredentialAndCheckpointSurviveRestartWithoutPlaintext() throws Exception {
    NativeStore store=new NativeStore(context);
    store.credential("setVideoTaskCredential",new JSONObject().put("taskId","task-one").put("apiKey","fixture-task-key"));
    JSONObject snapshot=new JSONObject().put("projectId","project-test").put("connection",new JSONObject().put("apiKey","fixture-checkpoint-secret"));
    JSONObject job=new JSONObject().put("snapshot",snapshot).put("preparation",new JSONObject().put("version",1).put("phase","acknowledged")).put("remoteTaskId","existing-upstream-task");
    JSONObject task=new JSONObject().put("id","task-one").put("createdAt",1).put("videoJob",job);
    store.checkpoint("saveVideoTaskCheckpoint",task);
    NativeStore restored=new NativeStore(context);
    assertEquals("fixture-task-key",restored.credential("getVideoTaskCredential",new JSONObject().put("value","task-one")));
    JSONObject checkpoint=restored.checkpoint("getVideoTaskCheckpoint",new JSONObject().put("value","task-one"));
    assertEquals("existing-upstream-task",checkpoint.getJSONObject("videoJob").getString("remoteTaskId"));
    assertFalse(containsSecret(store.root,"fixture-task-key"));
    assertFalse(containsSecret(store.root,"fixture-checkpoint-secret"));
  }
  @Test public void lhvdRoundTripPreservesMediaAndAvoidsAnExistingPathCollision() throws Exception {
    NativeStore sender=new NativeStore(context);NativeFiles senderFiles=new NativeFiles(context,sender);
    JSONObject media=senderFiles.storeBytes(new byte[]{1,2,3,4},"人物.png","image/png","project-test");
    JSONObject content=state("fixture-export-secret");content.getJSONObject("project").getJSONArray("assets").put(new JSONObject(media.toString()).put("id","asset-one").put("characterIds",new JSONArray().put("person-one")));
    File archive=new File(scratch,"round-trip.lhvd");senderFiles.exportPackage(content.toString(),archive);
    Context other=isolated(context,new File(scratch,"other-client"));NativeStore receiver=new NativeStore(other);NativeFiles receiverFiles=new NativeFiles(other,receiver);
    File occupied=receiverFiles.managed(media.getString("relativePath"));NativeStore.atomic(occupied,new byte[]{9,8,7});
    String imported;try(InputStream in=new FileInputStream(archive)){imported=receiverFiles.importPackage(in);}
    JSONObject importedMedia=new JSONObject(imported).getJSONObject("project").getJSONArray("assets").getJSONObject(0);
    assertArrayEquals(new byte[]{9,8,7},Files.readAllBytes(occupied.toPath()));
    assertArrayEquals(new byte[]{1,2,3,4},Files.readAllBytes(receiverFiles.managed(importedMedia.getString("relativePath")).toPath()));
    assertEquals("person-one",importedMedia.getJSONArray("characterIds").getString(0));
    assertFalse(imported.contains("fixture-export-secret"));
  }
  private boolean containsSecret(File file,String secret) throws Exception {
    if(file.isDirectory()){File[] children=file.listFiles();if(children!=null)for(File child:children)if(containsSecret(child,secret))return true;return false;}
    return new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8).contains(secret);
  }
}
