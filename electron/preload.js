'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    /** Tell the main process to start a download */
    startDownload: (url, outDir, maxWorkers) => ipcRenderer.send('start-download', { url, outDir, maxWorkers }),

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

    /** Force stop any active download */
    stopDownload: () => ipcRenderer.send('stop-download'),

    /** Remove all listeners (call before starting a new download) */
    removeAllListeners: () => {
        ipcRenderer.removeAllListeners('progress');
        ipcRenderer.removeAllListeners('download-result');
    },
});
