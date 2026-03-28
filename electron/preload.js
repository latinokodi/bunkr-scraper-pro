'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    /** Add a download task to the global persistent queue */
    addToQueue: (url, outDir, maxWorkers) => ipcRenderer.send('add-to-queue', { url, outDir, maxWorkers }),

    /** Get the current queue list synchronously */
    getQueue: () => ipcRenderer.invoke('get-queue'),

    /** Remove a task from the queue */
    removeFromQueue: (id) => ipcRenderer.send('remove-from-queue', id),

    /** Skip a specific file currently downloading */
    skipFile: (filename) => ipcRenderer.send('skip-file', filename),

    /** Register callback for when a process immediately starts */
    onDownloadStarted: (callback) => {
        ipcRenderer.on('download-started', (_event, task) => callback(task));
    },

    /** Register callback for queue updates */
    onQueueUpdated: (callback) => {
        ipcRenderer.on('queue-updated', (_event, q) => callback(q));
    },

    /** Register a callback for JSON progress events streamed from Python */
    onProgress: (callback) => {
        ipcRenderer.on('progress', (_event, data) => callback(data));
    },

    /** Register a callback for the final result when Python exits */
    onResult: (callback) => {
        ipcRenderer.on('download-result', (_event, result) => callback(result));
    },

    /** Open the downloads folder in Explorer */
    openDownloads: (dir) => ipcRenderer.send('open-downloads', dir),

    /** Select a custom destination folder */
    selectFolder: () => ipcRenderer.invoke('select-folder'),

    /** Force stop any active download entirely (skips current queue item) */
    stopDownload: () => ipcRenderer.send('stop-download'),

    /** Remove all listeners (call before starting a new download) */
    removeAllListeners: () => {
        ipcRenderer.removeAllListeners('progress');
        ipcRenderer.removeAllListeners('download-result');
        ipcRenderer.removeAllListeners('queue-updated');
        ipcRenderer.removeAllListeners('download-started');
    },
});
