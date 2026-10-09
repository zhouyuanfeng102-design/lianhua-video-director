const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lianhuaDesktop', {
  openFile: (filters) => ipcRenderer.invoke('lianhua:open-file', filters),
  readFile: (filePath) => ipcRenderer.invoke('lianhua:read-file', filePath),
  saveFile: (payload) => ipcRenderer.invoke('lianhua:save-file', payload),
  storagePaths: () => ipcRenderer.invoke('lianhua:storage-paths'),
  loadState: () => ipcRenderer.invoke('lianhua:load-state'),
  saveState: (content) => ipcRenderer.invoke('lianhua:save-state', content),
  onBeforeClose: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('lianhua:before-close', listener);
    return () => ipcRenderer.removeListener('lianhua:before-close', listener);
  },
  onCloseCancelled: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('lianhua:close-cancelled', listener);
    return () => ipcRenderer.removeListener('lianhua:close-cancelled', listener);
  },
  completeBeforeClose: (payload) => ipcRenderer.invoke('lianhua:complete-before-close', payload),
  saveMedia: (payload) => ipcRenderer.invoke('lianhua:save-media', payload),
  recoveryStatus: () => ipcRenderer.invoke('lianhua:recovery-status'),
  createRestorePoint: (content) => ipcRenderer.invoke('lianhua:create-restore-point', content),
  restoreSnapshot: (id) => ipcRenderer.invoke('lianhua:restore-snapshot', id),
  chooseBackupDirectory: () => ipcRenderer.invoke('lianhua:choose-backup-directory'),
  updateRecoveryConfig: (patch) => ipcRenderer.invoke('lianhua:update-recovery-config', patch),
  importMedia: (file) => ipcRenderer.invoke('lianhua:import-media', { path: file ? webUtils.getPathForFile(file) : '' }),
  storeGeneratedImage: (payload) => ipcRenderer.invoke('lianhua:store-generated-image', payload),
  storeGeneratedAudio: (payload) => ipcRenderer.invoke('lianhua:store-generated-audio', payload),
  assetStatus: (relativePath) => ipcRenderer.invoke('lianhua:asset-status', relativePath),
  getVideoThumbnail: (payload) => ipcRenderer.invoke('lianhua:get-video-thumbnail', payload),
  cancelVideoThumbnails: (payload) => ipcRenderer.invoke('lianhua:cancel-video-thumbnails', payload),
  readManagedImageDataUrl: (payload) => ipcRenderer.invoke('lianhua:read-managed-image-data-url', payload),
  readManagedAudioDataUrl: (payload) => ipcRenderer.invoke('lianhua:read-managed-audio-data-url', payload),
  relinkMedia: (asset) => ipcRenderer.invoke('lianhua:relink-media', asset),
  revealAsset: (relativePath) => ipcRenderer.invoke('lianhua:reveal-asset', relativePath),
  exportProjectPackage: (payload) => ipcRenderer.invoke('lianhua:export-project-package', payload),
  importProjectPackage: (file) => ipcRenderer.invoke('lianhua:import-project-package', { path: file ? webUtils.getPathForFile(file) : '' }),
  submitVideoTask: (payload) => ipcRenderer.invoke('lianhua:submit-video-task', payload),
  videoRequest: (payload) => ipcRenderer.invoke('lianhua:video-request', payload),
  rhtvRequest: (payload) => ipcRenderer.invoke('lianhua:rhtv-request', payload),
  rhtvControl: (payload) => ipcRenderer.invoke('lianhua:rhtv-control', payload),
  rhtvDownload: (payload) => ipcRenderer.invoke('lianhua:rhtv-download', payload),
  cancelVideoRequest: (requestId) => ipcRenderer.invoke('lianhua:cancel-video-request', requestId),
  watchVideoProgress: (payload) => ipcRenderer.invoke('lianhua:watch-video-progress', payload),
  unwatchVideoProgress: (watchId) => ipcRenderer.invoke('lianhua:unwatch-video-progress', watchId),
  onVideoProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('lianhua:video-progress', listener);
    return () => ipcRenderer.removeListener('lianhua:video-progress', listener);
  },
  setVideoTaskCredential: (payload) => ipcRenderer.invoke('lianhua:set-video-task-credential', payload),
  getVideoTaskCredential: (taskId) => ipcRenderer.invoke('lianhua:get-video-task-credential', taskId),
  deleteVideoTaskCredential: (taskId) => ipcRenderer.invoke('lianhua:delete-video-task-credential', taskId),
  saveVideoTaskCheckpoint: (task) => ipcRenderer.invoke('lianhua:save-video-task-checkpoint', task),
  getVideoTaskCheckpoint: (taskId) => ipcRenderer.invoke('lianhua:get-video-task-checkpoint', taskId),
  deleteVideoTaskCheckpoint: (taskId) => ipcRenderer.invoke('lianhua:delete-video-task-checkpoint', taskId),
  downloadGeneratedMedia: (payload) => ipcRenderer.invoke('lianhua:download-generated-media', payload),
  videoWorkbenchStatus: () => ipcRenderer.invoke('lianhua:video-workbench-status'),
  probeWorkbenchVideo: (source) => ipcRenderer.invoke('lianhua:probe-workbench-video', source),
  extractWorkbenchFrames: (payload) => ipcRenderer.invoke('lianhua:extract-workbench-frames', payload),
  renderWorkbenchTimeline: (payload) => ipcRenderer.invoke('lianhua:render-workbench-timeline', payload),
  cancelWorkbenchJob: (jobId) => ipcRenderer.invoke('lianhua:cancel-workbench-job', jobId),
  onWorkbenchProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('lianhua:workbench-progress', listener);
    return () => ipcRenderer.removeListener('lianhua:workbench-progress', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('lianhua:open-external', url),
  request: (payload) => ipcRenderer.invoke('lianhua:http-request', payload),
  cancelModelRequest: (requestId) => ipcRenderer.invoke('lianhua:cancel-model-request', requestId),
  downloadImage: (remote) => ipcRenderer.invoke('lianhua:download-image', remote)
});
