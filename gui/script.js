'use strict';

/**
 * Bunkr Scraper PRO - Frontend Logic
 * Updated for Multiple Concurrent Downloads
 */

// UI State Management
const state = {
    activeDownloads: new Map(),  // Map<taskId, { url, albumName, stats, files }>
    selectedFolder: null,
    concurrency: 3,
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

// SVG Icons for statuses
const icons = {
    downloading: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
    success:     '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    error:       '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    maintenance: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
    stop:        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><rect x="6" y="6" width="12" height="12"></rect></svg>'
};

// ── Initialization ────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
    const q = await window.electronAPI.getQueue();
    renderQueue(q);
});

window.electronAPI.onQueueUpdated((q) => {
    renderQueue(q);
});

window.electronAPI.onActiveDownloads((downloads) => {
    renderActiveDownloads(downloads);
});

// ── Active Downloads Rendering ────────────────────────────────────────────────
function renderActiveDownloads(downloads) {
    // Update state
    const currentIds = new Set(state.activeDownloads.keys());
    const newIds = new Set(downloads.map(d => d.id));

    // Remove completed downloads from state
    for (const id of currentIds) {
        if (!newIds.has(id)) {
            state.activeDownloads.delete(id);
        }
    }

    // Add new downloads
    for (const d of downloads) {
        if (!state.activeDownloads.has(d.id)) {
            state.activeDownloads.set(d.id, {
                url: d.url,
                albumName: d.albumName,
                stats: { total: 0, downloaded: 0, failed: 0 },
                files: []
            });
        } else {
            // Update album name if provided
            const existing = state.activeDownloads.get(d.id);
            if (d.albumName) existing.albumName = d.albumName;
        }
    }

    // Update UI
    updateUIForActiveDownloads();
}

function updateUIForActiveDownloads() {
    const count = state.activeDownloads.size;

    if (count === 0) {
        elements.downloadBtn.disabled = false;
        elements.downloadBtn.classList.remove('loading');
        elements.stopBtn.classList.add('hidden');
        elements.sysStatus.textContent = 'READY';
        elements.sysStatus.className = 'neon-green';
        if (elements.sysStatusTile) {
            elements.sysStatusTile.textContent = 'READY';
            elements.sysStatusTile.className = 'neon-green';
        }
        elements.currentAlbumTitle.textContent = 'Waiting for album...';
    } else {
        elements.downloadBtn.disabled = true;
        elements.downloadBtn.classList.add('loading');
        elements.stopBtn.classList.remove('hidden');
        elements.sysStatus.textContent = `DOWNLOADING (${count})`;
        elements.sysStatus.className = 'neon-cyan';
        if (elements.sysStatusTile) {
            elements.sysStatusTile.textContent = `ACTIVE (${count})`;
            elements.sysStatusTile.className = 'neon-cyan';
        }

        // Show album names
        const names = Array.from(state.activeDownloads.values())
            .map(d => d.albumName || 'Loading...')
            .join(', ');
        elements.currentAlbumTitle.textContent = names;
    }
}

// ── Queue Rendering ────────────────────────────────────────────────────────────
function renderQueue(q) {
    if (!q || q.length === 0) {
        elements.queueSection.style.display = 'none';
        return;
    }
    elements.queueSection.style.display = 'block';

    elements.queueList.innerHTML = q.map(task => `
        <div class="queue-item ${task.isPriority ? 'priority' : ''}">
            <div class="queue-info">
                ${task.isPriority ? '<span class="priority-tag">PRIORITY</span>' : ''}
                <span class="queue-url" title="${task.url}">${task.url}</span>
            </div>
            <div class="queue-actions">
                ${!task.isPriority ? `
                <button class="run-now-btn" onclick="window.electronAPI.startTaskNow('${task.id}')" title="Start Now (Priority)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </button>
                ` : ''}
                <button onclick="window.electronAPI.removeFromQueue('${task.id}')" title="Remove from Queue">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>
        </div>
    `).join('');
}

// ── File Actions ──────────────────────────────────────────────────────────────
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

    const row = document.querySelector(`[data-filename="${filename}"]`);
    if (row) {
        row.querySelector('.retry-btn')?.remove();
        const badge = row.querySelector('.status-badge');
        badge.className = 'status-badge downloading';
        badge.innerHTML = `${icons.downloading} Retrying`;

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
            row.insertBefore(progress, badge.nextSibling);
        }
    }
}

// ── Persistence ────────────────────────────────────────────────────────────────
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

// ── Event Listeners ────────────────────────────────────────────────────────────
elements.urlInput.addEventListener('click', () => elements.urlInput.select());
elements.urlInput.addEventListener('focus', () => elements.urlInput.select());
elements.downloadBtn.addEventListener('click', () => handleDownload());
elements.stopBtn.addEventListener('click', handleStopAll);
elements.browseBtn.addEventListener('click', handleBrowse);
loadPersistentPath();

elements.urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleDownload();
});

// ── Progress Listeners ─────────────────────────────────────────────────────────
window.electronAPI.onDownloadStarted((task) => {
    state.activeDownloads.set(task.id, {
        url: task.url,
        albumName: null,
        stats: { total: 0, downloaded: 0, failed: 0 },
        files: []
    });
    updateUIForActiveDownloads();
});

window.electronAPI.onProgress((data) => {
    window.onPythonProgress(data);
});

window.electronAPI.onResult((result) => {
    const { taskId, success, error, exitCode } = result;

    if (state.activeDownloads.has(taskId)) {
        state.activeDownloads.delete(taskId);
    }

    updateUIForActiveDownloads();

    if (success) {
        showToast('success', 'Album Complete', 'Saved to your output folder');
    } else if (exitCode === -1) {
        showToast('error', 'Execution Error', 'Python Engine failed to start');
    } else {
        showToast('error', 'Process Error', error || 'The scraper exited unexpectedly');
    }
});

// ── Handlers ──────────────────────────────────────────────────────────────────
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

function handleStopAll() {
    window.electronAPI.stopDownload();  // No ID = stop all
    state.activeDownloads.clear();
    updateUIForActiveDownloads();
    showToast('info', 'Stopped', 'All downloads have been stopped');
}

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

    window.electronAPI.addToQueue(url, state.selectedFolder, state.concurrency, true);
    showToast('success', 'Download Started', url);
    elements.urlInput.value = '';
}

// ── Progress Circle ───────────────────────────────────────────────────────────
function updateCircle(percent) {
    elements.circularPercent.textContent = `${percent}%`;
    const radius = 85;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percent / 100) * circumference;
    elements.progressCircle.style.strokeDashoffset = offset;
}

function resetDashboard() {
    elements.filesList.innerHTML = '';
    updateCircle(0);
    elements.etaValue.textContent = '--:--';
}

function updateStatsDisplay() {
    let total = 0, downloaded = 0, failed = 0;
    for (const download of state.activeDownloads.values()) {
        total += download.stats.total;
        downloaded += download.stats.downloaded;
        failed += download.stats.failed;
    }
    elements.totalFiles.textContent = total;
    elements.downloadedFiles.textContent = downloaded;
    elements.failedFiles.textContent = failed;
}

// ── Python Progress Handler ───────────────────────────────────────────────────
window.onPythonProgress = function (data) {
    const taskId = data.taskId;
    if (!taskId || !state.activeDownloads.has(taskId)) return;

    const download = state.activeDownloads.get(taskId);

    if (data.type === 'album_info') {
        download.albumName = data.name || "Unknown Album";
        updateUIForActiveDownloads();
    }

    if (data.type === 'found_files') {
        download.stats.total = data.total;
        updateStatsDisplay();
    }

    if (data.type === 'file_start') {
        addTableRow(data.filename, data.fileurl, taskId);
    }

    if (data.type === 'file_progress') {
        updateTableRowProgress(data.filename, data.percent, data.eta, data.speed);
    }

    if (data.type === 'file_complete') {
        download.stats.downloaded++;
        updateStatsDisplay();
        updateTableRowStatus(data.filename, 'success', data.fileurl);

        const totalDone = download.stats.downloaded + download.stats.failed;
        const total = download.stats.total > 0 ? download.stats.total : 1;
        updateCircle(Math.round((totalDone / total) * 100));

        if (data.overall_eta) {
            elements.etaValue.textContent = formatSecs(data.overall_eta);
        }
    }

    if (data.type === 'file_error') {
        download.stats.failed++;
        const status = data.reason === 'maintenance' ? 'maintenance' : (data.reason === 'skipped' ? 'skipped' : 'error');

        const existing = document.querySelector(`[data-filename="${data.filename}"]`);
        if (!existing && data.filename) addTableRow(data.filename, data.fileurl, taskId);

        if (data.filename) {
            updateTableRowStatus(data.filename, status, data.fileurl);
        }
        updateStatsDisplay();
    }
};

// ── Table Row Management ──────────────────────────────────────────────────────
function addTableRow(filename, fileurl = '', taskId = '') {
    const empty = elements.filesList.querySelector('.empty-state');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'table-row';
    row.dataset.filename = filename;
    row.dataset.fileurl = fileurl;
    row.dataset.taskId = taskId;
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

function updateTableRowStatus(filename, status, fileurl = '') {
    const row = document.querySelector(`[data-filename="${filename}"]`);
    if (!row) return;

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

// ── Utility Functions ─────────────────────────────────────────────────────────
function formatSecs(s) {
    if (s <= 0) return '0s';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatSpeed(bytes) {
    if (!bytes || bytes <= 0) return '0 B/s';
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function showToast(type, title, text) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let iconSvg = icons.success;
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