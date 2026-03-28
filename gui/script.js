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
    filesList:          document.getElementById('filesList'),
    messageContainer:   document.getElementById('messageContainer'),
};

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
    if (e.key === 'Enter' && !state.isDownloading) {
        handleDownload();
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

    state.isDownloading = true;
    setLoading(true);
    resetDashboard();

    // Prepare IPC
    window.electronAPI.removeAllListeners();

    window.electronAPI.onProgress((data) => {
        window.onPythonProgress(data);
    });

    window.electronAPI.onResult((result) => {
        if (!state.isDownloading) return; // Ignore if stopped by user

        state.isDownloading = false;
        setLoading(false);
        elements.sysStatus.textContent = result.success ? 'COMPLETED' : 'STOPPED';
        elements.sysStatus.className = result.success ? 'neon-green' : 'neon-red';

        if (result.success) {
            showToast('success', 'Operation Complete', `Success: ${state.stats.downloaded} downloads`);
            updateCircle(100);
        } else {
            showToast('error', 'Process Error', result.error || 'The scraper exited unexpectedly');
        }
    });

    window.electronAPI.startDownload(url, state.selectedFolder);
}

/** Set Loading UI State */
function setLoading(loading) {
    if (loading) {
        elements.downloadBtn.classList.add('loading');
        elements.downloadBtn.disabled = true;
        elements.stopBtn.classList.remove('hidden');
        elements.sysStatus.textContent = 'SCRAPING...';
        elements.sysStatus.className = 'neon-cyan';
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
    state.stats = { total: 0, downloaded: 0, failed: 0, maintenance: 0 };
    updateStatsDisplay();
    elements.etaValue.textContent = '--:--';
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
    if (data.type === 'found_files') {
        state.stats.total = data.total;
        updateStatsDisplay();
    }

    if (data.type === 'file_start') {
        addTableRow(data.filename);
    }

    if (data.type === 'file_progress') {
        updateTableRowProgress(data.filename, data.percent, data.eta);
    }

    if (data.type === 'file_complete') {
        state.stats.downloaded++;
        updateStatsDisplay();
        updateTableRowStatus(data.filename, 'success');
        
        const totalDone = state.stats.downloaded + state.stats.failed;
        const total = state.stats.total > 0 ? state.stats.total : 1;
        updateCircle(Math.round((totalDone / total) * 100));

        if (data.overall_eta) {
            elements.etaValue.textContent = formatSecs(data.overall_eta);
        }
    }

    if (data.type === 'file_error') {
        state.stats.failed++;
        const status = data.reason === 'maintenance' ? 'maintenance' : 'error';
        
        // Ensure row exists
        const existing = document.querySelector(`[data-filename="${data.filename}"]`);
        if (!existing) addTableRow(data.filename);
        
        updateTableRowStatus(data.filename, status);
        updateStatsDisplay();
    }
};

/** Create Table Row */
function addTableRow(filename) {
    // Remove empty state if present
    const empty = elements.filesList.querySelector('.empty-state');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'table-row';
    row.dataset.filename = filename;
    row.innerHTML = `
        <div class="col-name file-name-cell" title="${filename}">${filename}</div>
        <div class="col-status">
            <span class="status-badge downloading">${icons.downloading} Active</span>
        </div>
        <div class="col-progress row-progress-container">
            <div class="row-progress-info">
                <span class="pct">0%</span>
                <span class="eta">Pending...</span>
            </div>
            <div class="row-progress-bar">
                <div class="row-progress-fill" style="width: 0%"></div>
            </div>
        </div>
    `;
    elements.filesList.prepend(row);
}

/** Update Table Row Progress */
function updateTableRowProgress(filename, percent, eta) {
    const row = document.querySelector(`[data-filename="${filename}"]`);
    if (!row) return;

    const fill = row.querySelector('.row-progress-fill');
    const pct  = row.querySelector('.pct');
    const e    = row.querySelector('.eta');

    if (fill) fill.style.width = `${percent}%`;
    if (pct)  pct.textContent  = `${percent}%`;
    if (e)    e.textContent    = eta > 0 ? formatSecs(eta) : (percent >= 100 ? 'Finishing' : '...');
}

/** Update Table Row Status */
function updateTableRowStatus(filename, status) {
    const row = document.querySelector(`[data-filename="${filename}"]`);
    if (!row) return;

    const badge = row.querySelector('.status-badge');
    const label = status === 'success' ? 'Finished' : (status === 'maintenance' ? 'Maint.' : 'Failed');
    
    badge.className = `status-badge ${status}`;
    badge.innerHTML = `${icons[status]} ${label}`;

    if (status !== 'downloading') {
        const info = row.querySelector('.row-progress-info');
        if (info) info.innerHTML = `<span class="pct">${status === 'success' ? '100%' : 'ERROR'}</span>`;
        if (status === 'success') {
            const fill = row.querySelector('.row-progress-fill');
            if (fill) fill.style.width = '100%';
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
