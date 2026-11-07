import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { isAndroidRuntime } from './runtime';

export type DesktopBridge = NonNullable<Window['lianhuaDesktop']>;
export interface LianhuaNativePlugin {
  invoke(options: { method: string; payload?: Record<string, unknown> }): Promise<{ value: unknown }>;
  addListener(eventName: string, callback: (event: any) => void): Promise<PluginListenerHandle>;
}

const native = registerPlugin<LianhuaNativePlugin>('LianhuaNative');
const scalar = (value: unknown): Record<string, unknown> => ({ value });
const content = (value: string): Record<string, unknown> => ({ content: value });

export const ANDROID_FILE_TRANSFER_THRESHOLD = 4 * 1024 * 1024;
export const ANDROID_FILE_TRANSFER_CHUNK = 256 * 1024;

const base64Bytes = (bytes: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

/** Bound bridge message memory for video and project packages. The user's
 * original selection is read in order once; a failed chunk is never retried. */
export const withNativeFile = async <T>(
  plugin: Pick<LianhuaNativePlugin, 'invoke'>,
  file: File | undefined,
  consume: (payload: Record<string, unknown>) => Promise<T>,
): Promise<T> => {
  if (!file || file.size <= ANDROID_FILE_TRANSFER_THRESHOLD) return consume(await fileNativePayload(file));
  let transferId: string | undefined;
  try {
    const started = await plugin.invoke({ method: 'beginFileTransfer', payload: { fileName: file.name, mimeType: file.type, sizeBytes: file.size } });
    transferId = (started.value as { transferId: string }).transferId;
    for (let offset = 0; offset < file.size; offset += ANDROID_FILE_TRANSFER_CHUNK) {
      const bytes = new Uint8Array(await file.slice(offset, offset + ANDROID_FILE_TRANSFER_CHUNK).arrayBuffer());
      await plugin.invoke({ method: 'appendFileTransfer', payload: { transferId, offset, base64: base64Bytes(bytes) } });
    }
    const finished = await plugin.invoke({ method: 'finishFileTransfer', payload: { transferId } });
    const staged = finished.value as { uri: string; fileName: string; mimeType: string };
    return await consume({ ...staged, fileName: file.name, mimeType: file.type });
  } finally {
    if (transferId) {
      // Import copies into managed storage before this temporary source closes.
      await plugin.invoke({ method: 'abortFileTransfer', payload: { transferId } }).catch((error: unknown) => {
        console.error('安卓导入临时文件清理失败', error);
      });
    }
  }
};

/** Files selected by the WebView have no desktop path. Preserve their bytes. */
export const fileNativePayload = async (file?: File): Promise<Record<string, unknown>> => {
  if (!file) return {};
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.onabort = () => reject(Object.assign(new Error('文件读取已取消'), { name: 'AbortError' }));
    reader.readAsDataURL(file);
  });
  return { dataUrl, fileName: file.name, mimeType: file.type };
};

/** Keep the existing desktop contract at the boundary, including error propagation.
 * A native failure must reach the existing save/task error UI; never fall back to
 * localStorage or repeat a paid model submission. */
export const createAndroidBridge = (plugin: LianhuaNativePlugin = native): DesktopBridge => {
  const invoke = async <T>(method: string, payload?: Record<string, unknown>): Promise<T> => {
    const result = await plugin.invoke({ method, ...(payload ? { payload } : {}) });
    return result.value as T;
  };
  const listener = <T>(eventName: string, callback: (event: T) => void): (() => void) => {
    let removed = false;
    let handle: PluginListenerHandle | undefined;
    void plugin.addListener(eventName, (event: T) => { if (!removed) callback(event); }).then((value) => {
      handle = value;
      if (removed) void value.remove();
    }).catch((error: unknown) => console.error(`Android ${eventName} 事件订阅失败`, error));
    return () => {
      removed = true;
      if (handle) void handle.remove();
    };
  };
  return {
    openFile: (filters) => invoke('openFile', { filters }),
    readFile: (filePath) => invoke('readFile', scalar(filePath)),
    saveFile: (payload) => invoke('saveFile', payload as Record<string, unknown>),
    storagePaths: () => invoke('storagePaths'),
    loadState: () => invoke('loadState'),
    loadWorkspaceState: () => invoke('loadWorkspaceState'),
    loadProject: (projectId, hash) => invoke('loadProject', { projectId, hash }),
    saveState: (value) => invoke('saveState', content(value)),
    noteActiveProject: (payload) => invoke('noteActiveProject', payload),
    onStateMaintenanceWarning: (callback) => listener('stateMaintenanceWarning', callback),
    onBeforeClose: (callback) => listener('beforeClose', callback),
    onCloseCancelled: (callback) => listener('closeCancelled', callback),
    completeBeforeClose: (payload) => invoke('completeBeforeClose', payload),
    saveMedia: (payload) => invoke('saveMedia', payload),
    recoveryStatus: (options) => invoke('recoveryStatus', options),
    createRestorePoint: (value) => invoke('createRestorePoint', content(value)),
    restoreSnapshot: (id) => invoke('restoreSnapshot', scalar(id)),
    updateRecoveryConfig: (patch) => invoke('updateRecoveryConfig', patch),
    importMedia: (file) => withNativeFile(plugin, file, (payload) => invoke('importMedia', payload)),
    storeGeneratedImage: (payload) => invoke('storeGeneratedImage', payload),
    storeGeneratedAudio: (payload) => invoke('storeGeneratedAudio', payload),
    storeVideoReferenceImage: (payload) => invoke('storeVideoReferenceImage', payload),
    storeVideoReferenceVideo: (payload) => invoke('storeVideoReferenceVideo', payload),
    readManagedImageDataUrl: (payload) => invoke('readManagedImageDataUrl', payload),
    readVideoReferenceImage: (payload) => invoke('readVideoReferenceImage', payload),
    readManagedAudioDataUrl: (payload) => invoke('readManagedAudioDataUrl', payload),
    readManagedVideoDataUrl: (payload) => invoke('readManagedVideoDataUrl', payload),
    assetStatus: (relativePath) => invoke('assetStatus', scalar(relativePath)),
    getImageThumbnail: (payload) => invoke('getImageThumbnail', payload),
    getVideoThumbnail: (payload) => invoke('getVideoThumbnail', payload),
    cancelVideoThumbnails: (payload) => invoke('cancelVideoThumbnails', payload),
    relinkMedia: (asset) => invoke('relinkMedia', { ...asset }),
    revealAsset: (relativePath) => invoke('revealAsset', scalar(relativePath)),
    exportProjectPackage: (payload) => invoke('exportProjectPackage', payload),
    importProjectPackage: (file) => withNativeFile(plugin, file, (payload) => invoke('importProjectPackage', payload)),
    submitVideoTask: (payload) => invoke('submitVideoTask', payload as Record<string, unknown>),
    videoRequest: (payload) => invoke('videoRequest', payload),
    rhtvRequest: (payload) => invoke('rhtvRequest', { ...payload }),
    rhtvControl: (payload) => invoke('rhtvControl', { ...payload }),
    rhtvDownload: (payload) => invoke('rhtvDownload', { ...payload }),
    rhWebRequest: (payload) => invoke('rhWebRequest', { ...payload }),
    rhWebControl: (payload) => invoke('rhWebControl', { ...payload }),
    rhWebDownload: (payload) => invoke('rhWebDownload', { ...payload }),
    cancelVideoRequest: (requestId) => invoke('cancelVideoRequest', scalar(requestId)),
    watchVideoProgress: (payload) => invoke('watchVideoProgress', payload),
    unwatchVideoProgress: (watchId) => invoke('unwatchVideoProgress', scalar(watchId)),
    onVideoProgress: (callback) => {
      const stopVideo = listener('videoProgress', callback);
      const stopDownload = listener<{ requestId: string; loaded: number; total?: number }>('downloadProgress', (event) => {
        callback({ watchId: event.requestId, type: 'message', data: {
          type: 'download_progress', data: { receivedBytes: event.loaded, totalBytes: event.total },
        } });
      });
      return () => { stopVideo(); stopDownload(); };
    },
    setVideoTaskCredential: (payload) => invoke('setVideoTaskCredential', payload),
    getVideoTaskCredential: (taskId) => invoke('getVideoTaskCredential', scalar(taskId)),
    deleteVideoTaskCredential: (taskId) => invoke('deleteVideoTaskCredential', scalar(taskId)),
    saveVideoTaskCheckpoint: (task) => invoke('saveVideoTaskCheckpoint', { ...task }),
    getVideoTaskCheckpoint: (taskId) => invoke('getVideoTaskCheckpoint', scalar(taskId)),
    deleteVideoTaskCheckpoint: (taskId) => invoke('deleteVideoTaskCheckpoint', scalar(taskId)),
    downloadGeneratedMedia: (payload) => invoke('downloadGeneratedMedia', { ...payload }),
    videoWorkbenchStatus: () => invoke('videoWorkbenchStatus'),
    probeWorkbenchVideo: (payload) => invoke('probeWorkbenchVideo', { ...payload }),
    extractWorkbenchFrames: (payload) => invoke('extractWorkbenchFrames', { ...payload }),
    renderWorkbenchTimeline: (payload) => invoke('renderWorkbenchTimeline', { ...payload }),
    cancelWorkbenchJob: (jobId) => invoke('cancelWorkbenchJob', scalar(jobId)),
    onWorkbenchProgress: (callback) => listener('workbenchProgress', callback),
    openExternal: (url) => invoke('openExternal', scalar(url)),
    request: (payload) => invoke('request', payload as Record<string, unknown>),
    cancelModelRequest: (requestId) => invoke('cancelModelRequest', scalar(requestId)),
    downloadImage: (remote) => invoke('downloadImage', typeof remote === 'string' ? scalar(remote) : remote),
  };
};

let initialized = false;
export const initializeAndroidBridge = async (): Promise<void> => {
  if (initialized || !isAndroidRuntime()) return;
  initialized = true;
  window.lianhuaPlatform = 'android';
  document.documentElement.dataset.platform = 'android';
  window.lianhuaDesktop = createAndroidBridge();
  await native.addListener('backButton', () => {
    const detail = { handled: false };
    const event = new CustomEvent('lianhua:backbutton', { cancelable: true, detail });
    window.dispatchEvent(event);
    if (detail.handled || event.defaultPrevented) return;
    const requestId = `android-close-${Date.now()}`;
    void native.invoke({ method: 'requestClose', payload: { value: requestId } }).catch((error: unknown) => {
      console.error('退出前保存失败', error);
    });
  });
};
