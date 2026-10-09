/// <reference types="vite/client" />

interface Window {
  lianhuaDesktop?: {
    rhtvRequest: import('./videoGenerationTypes').VideoGenerationDesktop['videoRequest'];
    rhtvDownload: import('./videoGenerationTypes').VideoGenerationDesktop['downloadGeneratedMedia'];
    rhtvControl: (request: import('./rhtvBridge').RhTvControlRequest) => Promise<import('./rhtvBridge').RhTvBridgeStatus>;
    openFile: (filters?: unknown) => Promise<string | null>;
    readFile: (filePath: string) => Promise<string>;
    saveFile: (payload: unknown) => Promise<string | null>;
    storagePaths: () => Promise<{
      dataRoot: string;
      sessionData: string;
      cache: string;
      temp: string;
      logs: string;
      assets: string;
      snapshots: string;
      encryptionAvailable: boolean;
    }>;
    loadState: () => Promise<string | null>;
    saveState: (content: string) => Promise<unknown>;
    onBeforeClose: (callback: (event: { requestId: string }) => void) => () => void;
    onCloseCancelled: (callback: (event: { requestId: string }) => void) => () => void;
    completeBeforeClose: (payload: { requestId: string; ok: boolean; error?: string }) => Promise<boolean>;
    saveMedia: (payload: {
      sourceUrl?: string;
      relativePath?: string;
      fileName?: string;
      mimeType?: string;
      mediaType?: string;
    }) => Promise<string | null>;
    recoveryStatus: () => Promise<import('./storage').RecoveryStatus>;
    createRestorePoint: (content: string) => Promise<{ ok: boolean; path: string }>;
    restoreSnapshot: (id: string) => Promise<string>;
    chooseBackupDirectory: () => Promise<import('./storage').RecoveryStatus['recovery'] | null>;
    updateRecoveryConfig: (patch: Partial<import('./storage').RecoveryStatus['recovery']>) => Promise<import('./storage').RecoveryStatus['recovery']>;
    importMedia: (file: File) => Promise<import('./storage').ManagedMediaResult | null>;
    storeGeneratedImage: (payload: {
      dataUrl: string;
      fileName?: string;
    }) => Promise<import('./storage').ManagedMediaResult>;
    storeGeneratedAudio: (payload: { dataUrl: string; fileName?: string }) => Promise<import('./storage').ManagedMediaResult>;
    readManagedAudioDataUrl: (payload: { relativePath: string; expectedChecksum?: string }) => Promise<{
      dataUrl: string; mimeType: 'audio/mpeg' | 'audio/wav' | 'audio/flac'; sizeBytes: number; checksum: string;
    }>;
    assetStatus: (relativePath: string) => Promise<Partial<import('./storage').ManagedMediaResult> & { exists: boolean }>;
    getVideoThumbnail: (payload: {
      projectId: string;
      assetId: string;
      relativePath: string;
      expectedChecksum?: string;
    }) => Promise<{
      dataUrl: string;
      mimeType: 'image/png';
      width: number;
      height: number;
      sizeBytes: number;
      cacheKey: string;
    }>;
    cancelVideoThumbnails: (payload: { projectId: string }) => Promise<number>;
    readManagedImageDataUrl: (payload: {
      relativePath: string;
      expectedChecksum?: string;
    }) => Promise<{
      dataUrl: string;
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
      sizeBytes: number;
      checksum: string;
    }>;
    relinkMedia: (asset: import('./types').ReferenceAsset) => Promise<import('./storage').ManagedMediaResult | null>;
    revealAsset: (relativePath: string) => Promise<boolean>;
    exportProjectPackage: (payload: { content: string; fileName: string }) => Promise<{ path: string; assetCount: number; missingCount: number } | null>;
    importProjectPackage: (file?: File) => Promise<string | null>;
    submitVideoTask: (payload: unknown) => Promise<{ status: number; body: unknown }>;
    videoRequest: (payload: {
      requestId: string;
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      multipart?: {
        fields?: Record<string, string> | Array<{ name: string; value: string }>;
        files: Array<{ fieldName?: string; name?: string; fileName: string; dataUrl: string }>;
      };
      responseType?: 'text' | 'base64' | 'auto';
    }) => Promise<{ status: number; body: string; bodyEncoding?: 'text' | 'base64'; contentType?: string }>;
    cancelVideoRequest: (requestId: string) => Promise<boolean>;
    watchVideoProgress: (payload: { watchId: string; url: string; headers?: Record<string, string> }) => Promise<void>;
    unwatchVideoProgress: (watchId: string) => Promise<boolean>;
    onVideoProgress: (callback: (event: {
      watchId: string;
      type: 'message' | 'connected' | 'disconnected' | 'error';
      data?: unknown;
      message?: string;
    }) => void) => () => void;
    setVideoTaskCredential: (payload: { taskId: string; apiKey: string }) => Promise<{ persisted: boolean }>;
    getVideoTaskCredential: (taskId: string) => Promise<string | null>;
    deleteVideoTaskCredential: (taskId: string) => Promise<boolean>;
    saveVideoTaskCheckpoint: (task: import('./types').VideoGenerationTask) => Promise<{ persisted: boolean }>;
    getVideoTaskCheckpoint: (taskId: string) => Promise<import('./types').VideoGenerationTask | null>;
    deleteVideoTaskCheckpoint: (taskId: string) => Promise<boolean>;
    downloadGeneratedMedia: (payload: import('./videoGenerationTypes').GeneratedMediaDownloadRequest) => Promise<import('./videoGenerationTypes').GeneratedMediaDownloadResult>;
    videoWorkbenchStatus: () => Promise<import('./videoWorkbenchTypes').VideoWorkbenchStatus>;
    probeWorkbenchVideo: (source: import('./videoWorkbenchTypes').WorkbenchMediaSource) => Promise<import('./videoWorkbenchTypes').WorkbenchVideoProbe>;
    extractWorkbenchFrames: (payload: import('./videoWorkbenchTypes').WorkbenchFrameRequest) => Promise<import('./videoWorkbenchTypes').WorkbenchFrameResult>;
    renderWorkbenchTimeline: (payload: import('./videoWorkbenchTypes').WorkbenchRenderRequest) => Promise<import('./videoWorkbenchTypes').WorkbenchRenderResult>;
    cancelWorkbenchJob: (jobId: string) => Promise<boolean>;
    onWorkbenchProgress: (callback: (event: import('./videoWorkbenchTypes').WorkbenchProgress) => void) => () => void;
    openExternal: (url: string) => Promise<void>;
    request: (payload: unknown) => Promise<{
      status: number;
      body: string;
      bodyEncoding?: 'text' | 'base64';
      contentType?: string;
    }>;
    cancelModelRequest: (requestId: string) => Promise<boolean>;
    downloadImage: (remote: string | { url: string; headers?: Record<string, string> }) => Promise<string>;
  };
}
