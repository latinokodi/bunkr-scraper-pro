'use strict';

/**
 * Bunkr Scraper PRO - Frontend Logic
 * Updated for the Dashboard REVAMP
 */

// UI State Management
const state = {
    isDownloading: false,
    currentFiles: [],
    selectedFolder: null,
    concurrency: 3,
    stats: {
        total: 0,
        downloaded: 0,
        failed: 0,
        maintenance: 0
    }
};

// DOM Elements
const elements = {
    urlInput:           document.getElementById('urlInput'),
    downloadBtn:        document.getElementById('downloadBtn'),
    stopBtn:            document.getElementById('stopBtn'),
    browseBtn:          document.getElementById('browseBtn'),
    folderPath:         document.getElementById('folderPath'),
    progressCircle:     document.getElementById('progressCircle'),
    circularPercent:    document.getElementById('circularPercent'),
    totalFiles:         document.getElementById('totalFiles'),
    downloadedFiles:    document.getElementById('downloadedFiles'),
    failedFiles:        document.getElementById('failedFiles'),
    etaValue:           document.getElementById('etaValue'),
    sysStatus:          document.getElementById('sysStatus'),
    sysStatusTile:      document.getElementById('sysStatusTile'),
    filesList:          document.getElementById('filesList'),
    messageContainer:   document.getElementById('messageContainer'),
    queueSection:       document.getElementById('queueSection'),
    queueList:          document.getElementById('queueList'),
    currentAlbumTitle:  document.getElementById('currentAlbumTitle'),
};

// Queue Sync Init
window.addEventListener('DOMContentLoaded', async () => {
    const q = await window.electronAPI.getQueue();
    renderQueue(q);
});

window.electronAPI.onQueueUpdated((q) => {
    renderQueue(q);
});

function renderQueue(q) {
    if (!q || q.length <= 1) {
        elements.queueSection.style.display = 'none';
        return;
    }
    elements.queueSection.style.display = 'block';
    
    // We only show items from index 1+ since index 0 is currently processing
    const waiting = q.slice(1);
    if (waiting.length === 0) {
        elements.queueSection.style.display = 'none';
        return;
    }

    elements.queueList.innerHTML = waiting.map(task => `
        <div class="queue-item">
            <span class="queue-url" title="${task.url}">${task.url}</span>
            <div class="queue-actions">
                <button onclick="window.electronAPI.removeFromQueue('${task.id}')" title="Remove from Queue">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>
        </div>
    `).join('');
}

function skipFile(filename) {
    window.electronAPI.skipFile(filename);
}

function retryFile(url, filename) {
    if (!url) {
        showToast('error', 'Retry Failed', 'No source URL found for this file');
        return;
    }
    window.electronAPI.addToQueue(url, state.selectedFolder, state.concurrency);
    showToast('success', 'File Re-Queued', filename);
    
    // UI Feedback: Reset the row to "Retrying" state
    const row = document.querySelector(`[data-filename="${filename}"]`);
    if (row) {
        row.querySelector('.retry-btn')?.remove();
        const badge = row.querySelector('.status-badge');
        badge.className = 'status-badge downloading';
        badge.innerHTML = `${icons.downloading} Retrying`;
        
        // Re-inject progress container if it was removed
        if (!row.querySelector('.row-progress-container')) {
            const progress = document.createElement('div');
            progress.className = 'col-progress row-progress-container';
            progress.innerHTML = `
                <div class="row-progress-info">
                    <span class="pct">0%</span>
                    <span class="eta">...</span>
                </div>
                <div class="row-progress-bar">
                    <div class="row-progress-fill" style="width: 0%"></div>
                </div>
            `;
            // Insert after badge
            row.insertBefore(progress, badge.nextSibling);
        }
    }
}

// SVG Icons for statuses
const icons = {
    downloading: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
    success:     '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    error:       '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    maintenance: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>'
};

// ── Persistence ────────────────────────────────────────────────────────────
function loadPersistentPath() {
    const saved = localStorage.getItem('lastDownloadPath');
    if (saved) {
        state.selectedFolder = saved;
        updatePathDisplay(saved);
    }
}

function savePersistentPath(path) {
    if (path) localStorage.setItem('lastDownloadPath', path);
}

function updatePathDisplay(path) {
    const displayPath = path.length > 30 ? '...' + path.slice(-27) : path;
    elements.folderPath.value = displayPath;
    elements.folderPath.title = path;
}

// Initialize
elements.urlInput.addEventListener('click', () => elements.urlInput.select());
elements.urlInput.addEventListener('focus', () => elements.urlInput.select());

elements.downloadBtn.addEventListener('click', () => handleDownload());
elements.stopBtn.addEventListener('click', handleStop);
elements.browseBtn.addEventListener('click', handleBrowse);
loadPersistentPath();


elements.urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        handleDownload();
    }
});

// Setup progress listener
window.electronAPI.onDownloadStarted((task) => {
    state.isDownloading = true;
    setLoading(true);
    resetDashboard();
    elements.currentAlbumTitle.textContent = "Connecting to Bunkr...";
});

window.electronAPI.onProgress((data) => {
    window.onPythonProgress(data);
});

window.electronAPI.onResult((result) => {
    if (!state.isDownloading) return; // Ignore if stopped by user

    state.isDownloading = false;
    setLoading(false);
    elements.sysStatus.textContent = result.success ? 'COMPLETED' : 'STOPPED';
    elements.sysStatus.className = result.success ? 'neon-green' : 'neon-red';
    if (elements.sysStatusTile) {
        elements.sysStatusTile.textContent = result.success ? 'COMPLETED' : 'STOPPED';
        elements.sysStatusTile.className = result.success ? 'neon-green' : 'neon-red';
    }

    if (result.success) {
        showToast('success', 'Album Complete', `Saved to your output folder`);
        updateCircle(100);
        elements.currentAlbumTitle.textContent = "Waiting for next album...";
    } else if (result.exitCode === -1) {
        showToast('error', 'Execution Error', 'Python Engine failed to start globally. Retrying automatically..');
    } else {
        showToast('error', 'Process Error', result.error || 'The scraper exited unexpectedly');
        elements.currentAlbumTitle.textContent = "Error during download";
    }
});

/** Browse Folder */
async function handleBrowse() {
    try {
        const path = await window.electronAPI.selectFolder();
        if (path) {
            state.selectedFolder = path;
            updatePathDisplay(path);
            savePersistentPath(path);
        }
    } catch (err) {
        console.error('Failed to select folder:', err);
    }
}

/** Stop Download */
function handleStop() {
    if (state.isDownloading) {
        window.electronAPI.stopDownload();
        state.isDownloading = false;
        setLoading(false);
        elements.sysStatus.textContent = 'STOPPED BY USER';
        elements.sysStatus.className = 'neon-red';
        if (elements.sysStatusTile) {
            elements.sysStatusTile.textContent = 'STOPPED';
            elements.sysStatusTile.className = 'neon-red';
        }
        showToast('info', 'Process Canceled', 'The download was stopped manually');
    }
}

/** Main Download Entry */
function handleDownload() {
    const url = elements.urlInput.value.trim();

    if (!url) {
        showToast('error', 'Invalid URL', 'Please enter a valid Bunkr album link');
        return;
    }

    if (!url.includes('bunkr.')) {
        showToast('error', 'Invalid URL', 'URL must be a Bunkr link');
        return;
    }

    // Pass directly to the Electron Persistent Queue
    window.electronAPI.addToQueue(url, state.selectedFolder, state.concurrency);
    
    showToast('success', 'Added to Queue', url);
    elements.urlInput.value = ''; // Clean input
}

/** Set Loading UI State */
function setLoading(loading) {
    if (loading) {
        elements.downloadBtn.classList.add('loading');
        elements.downloadBtn.disabled = true;
        elements.stopBtn.classList.remove('hidden');
        elements.sysStatus.textContent = 'SCRAPING...';
        elements.sysStatus.className = 'neon-cyan';
        if (elements.sysStatusTile) {
            elements.sysStatusTile.textContent = 'SCRAPING...';
            elements.sysStatusTile.className = 'neon-cyan';
        }
    } else {
        elements.downloadBtn.classList.remove('loading');
        elements.downloadBtn.disabled = false;
        elements.stopBtn.classList.add('hidden');
    }
}

/** Reset Dashboard */
function resetDashboard() {
    elements.filesList.innerHTML = '';
    updateCircle(0);
    elements.etaValue.textContent = '--:--';
    state.stats = { total: 0, downloaded: 0, failed: 0, maintenance: 0 };
    updateStatsDisplay();
}

/** Update Global Progress Circle */
function updateCircle(percent) {
    elements.circularPercent.textContent = `${percent}%`;
    const radius = 85;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percent / 100) * circumference;
    elements.progressCircle.style.strokeDashoffset = offset;
}

/** Update Stat Hero Grid */
function updateStatsDisplay() {
    elements.totalFiles.textContent      = state.stats.total;
    elements.downloadedFiles.textContent = state.stats.downloaded;
    elements.failedFiles.textContent     = state.stats.failed;
}

/** Handle Incoming Python Progress Events */
window.onPythonProgress = function (data) {
    if (data.type === 'album_info') {
        const title = data.name || "Unknown Album";
        elements.currentAlbumTitle.textContent = `Downloading: ${title}`;
        
        // Wipe dashboard cleanly for the new process
        if (!state.isDownloading) {
            state.isDownloading = true;
            setLoading(true);
        }
        resetDashboard();
    }

    if (data.type === 'found_files') {
        state.stats.total = data.total;
        updateStatsDisplay();
    }

    if (data.type === 'file_start') {
        addTableRow(data.filename, data.fileurl);
    }

    if (data.type === 'file_progress') {
        updateTableRowProgress(data.filename, data.percent, data.eta, data.speed);
    }

    if (data.type === 'file_complete') {
        state.stats.downloaded++;
        updateStatsDisplay();
        updateTableRowStatus(data.filename, 'success', data.fileurl);
        
        const totalDone = state.stats.downloaded + state.stats.failed;
        const total = state.stats.total > 0 ? state.stats.total : 1;
        updateCircle(Math.round((totalDone / total) * 100));

        if (data.overall_eta) {
            elements.etaValue.textContent = formatSecs(data.overall_eta);
        }
    }

    if (data.type === 'file_error') {
        state.stats.failed++;
        const status = data.reason === 'maintenance' ? 'maintenance' : (data.reason === 'skipped' ? 'skipped' : 'error');
        
        // Ensure row exists
        const existing = document.querySelector(`[data-filename="${data.filename}"]`);
        if (!existing && data.filename) addTableRow(data.filename, data.fileurl);
        
        if (data.filename) {
            updateTableRowStatus(data.filename, status, data.fileurl);
        }
        updateStatsDisplay();
    }
};

/** Create Table Row */
function addTableRow(filename, fileurl = '') {
    // Remove empty state if present
    const empty = elements.filesList.querySelector('.empty-state');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'table-row';
    row.dataset.filename = filename;
    row.dataset.fileurl = fileurl;
    row.innerHTML = `
        <div class="col-name file-name-cell" title="${filename}">${filename}</div>
        <div class="col-status">
            <span class="status-badge downloading">${icons.downloading} Active</span>
        </div>
        <div class="col-progress row-progress-container">
            <div class="row-progress-info">
                <span class="pct">0%</span>
                <span class="speed">0 B/s</span>
                <span class="eta">Pending...</span>
            </div>
            <div class="row-progress-bar">
                <div class="row-progress-fill" style="width: 0%"></div>
            </div>
        </div>
        <button class="skip-btn" title="Skip File" onclick="skipFile('${filename}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>
        </button>
    `;
    elements.filesList.prepend(row);
}

/** Update Table Row Progress */
function updateTableRowProgress(filename, percent, eta, speed) {
    const row = document.querySelector(`[data-filename="${filename}"]`);
    if (!row) return;

    const fill = row.querySelector('.row-progress-fill');
    const pct  = row.querySelector('.pct');
    const e    = row.querySelector('.eta');
    const s    = row.querySelector('.speed');

    if (fill) fill.style.width = `${percent}%`;
    if (pct)  pct.textContent  = `${percent}%`;
    if (s)    s.textContent    = formatSpeed(speed || 0);
    if (e)    e.textContent    = eta > 0 ? formatSecs(eta) : (percent >= 100 ? 'Finishing' : '...');
}

/** Update Table Row Status */
function updateTableRowStatus(filename, status, fileurl = '') {
    const row = document.querySelector(`[data-filename="${filename}"]`);
    if (!row) return;

    // Update fileurl if provided
    if (fileurl) row.dataset.fileurl = fileurl;

    const badge = row.querySelector('.status-badge');
    switch (status) {
        case 'success':
            badge.className = 'status-badge success';
            badge.innerHTML = `${icons.success} Finished`;
            break;
        case 'error':
            badge.className = 'status-badge error';
            badge.innerHTML = `${icons.error} Failed`;
            break;
        case 'maintenance':
            badge.className = 'status-badge maintenance';
            badge.innerHTML = `${icons.maintenance} Maint.`;
            break;
        case 'skipped':
            badge.className = 'status-badge skipped';
            badge.innerHTML = `Skipped`;
            break;
    }

    if (status !== 'downloading') {
        const info = row.querySelector('.row-progress-info');
        if (info) info.remove();
        
        // Remove skip button and potentially add retry button
        const skipBtn = row.querySelector('.skip-btn');
        if (skipBtn) skipBtn.remove();

        const retryUrl = row.dataset.fileurl;
        if ((status === 'error' || status === 'skipped') && retryUrl) {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'retry-btn';
            retryBtn.title = 'Retry File';
            retryBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
            `;
            retryBtn.onclick = () => retryFile(retryUrl, filename);
            row.appendChild(retryBtn);
        }
    }
}



/** Format Seconds */
function formatSecs(s) {
    if (s <= 0) return '0s';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

/** Format Speed */
function formatSpeed(bytes) {
    if (!bytes || bytes <= 0) return '0 B/s';
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** Toast Notifications */
function showToast(type, title, text) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // Choose icon
    let iconSvg = icons.info || '';
    if (type === 'success') iconSvg = icons.success;
    if (type === 'error') iconSvg = icons.error;

    toast.innerHTML = `
        <div class="toast-icon neon-${type === 'success' ? 'green' : (type === 'error' ? 'red' : 'cyan')}">
            ${iconSvg}
        </div>
        <div class="toast-content">
            <h4>${title}</h4>
            <p>${text}</p>
        </div>
    `;

    elements.messageContainer.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'toastIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}
