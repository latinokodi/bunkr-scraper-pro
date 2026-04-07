'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    /** Add a download task to the global persistent queue */
    addToQueue: (taskData) => ipcRenderer.send('add-to-queue', taskData),

    /** Get the current queue list synchronously */
    getQueue: () => ipcRenderer.invoke('get-queue'),

    /** Get currently active downloads */
    getActiveDownloads: () => ipcRenderer.invoke('get-active-downloads'),

    /** Remove a task from the queue */
    removeFromQueue: (id) => ipcRenderer.send('remove-from-queue', id),

    /** Manually start a queued task immediately (as Priority) */
    startTaskNow: (id) => ipcRenderer.send('start-task-now', id),

    /** Skip a specific file currently downloading */
    skipFile: (filename) => ipcRenderer.send('skip-file', filename),

    /** Stop a file and send it to the bottom of the queue */
    requeueFile: (taskId, filename, bunkrUrl) => ipcRenderer.send('requeue-file', {taskId, filename, bunkrUrl}),

    /** Register callback for when a process immediately starts */
    onDownloadStarted: (callback) => {
        ipcRenderer.on('download-started', (_event, task) => callback(task));
    },

    /** Register callback for queue updates */
    onQueueUpdated: (callback) => {
        ipcRenderer.on('queue-updated', (_event, q) => callback(q));
    },

    /** Register callback for active downloads updates */
    onActiveDownloads: (callback) => {
        ipcRenderer.on('active-downloads', (_event, downloads) => callback(downloads));
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
    openFolder: (dir) => ipcRenderer.invoke('open-folder', dir),

    /** Select a custom destination folder */
    selectFolder: () => ipcRenderer.invoke('select-folder'),

    /** Stop specific download or all if no ID provided */
    stopDownload: (taskId) => ipcRenderer.send('stop-download', taskId),

    /** Perform a cleanup of the destination folder */
    cleanupDownloads: (targetDir) => ipcRenderer.invoke('cleanup-downloads', targetDir),

    /** Update global concurrency limits */
    setConcurrency: (value) => ipcRenderer.invoke('set-concurrency', value),

    /** Get current concurrency state */
    getConcurrency: () => ipcRenderer.invoke('get-concurrency'),

    /** Remove all listeners (call before starting a new download) */
    removeAllListeners: () => {
        ipcRenderer.removeAllListeners('progress');
        ipcRenderer.removeAllListeners('download-result');
        ipcRenderer.removeAllListeners('queue-updated');
        ipcRenderer.removeAllListeners('download-started');
        ipcRenderer.removeAllListeners('active-downloads');
    },
});