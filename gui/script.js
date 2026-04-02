'use strict';

/**
 * Bunkr Scraper PRO - Frontend Logic
 * Updated for Multiple Concurrent Downloads
 */

// UI State Management
const state = {
    activeDownloads: new Map(),  // Map<taskId, { url, albumName, stats, files }>
    selectedFolder: null,
    concurrency: 10,
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
    copyAllQueueBtn:    document.getElementById('copyAllQueueBtn'),
    copyAllActiveBtn:   document.getElementById('copyAllActiveBtn'),
    cleanupBtn:         document.getElementById('cleanupBtn'),
    totalSpeed:         document.getElementById('totalSpeed'),
    currentAlbumTitle:  document.getElementById('currentAlbumTitle'),
    
    // Tabs
    navDashboard:       document.getElementById('navDashboard'),
    navGrabber:         document.getElementById('navGrabber'),
    navDownloads:       document.getElementById('navDownloads'),
    viewDashboard:      document.getElementById('viewDashboard'),
    viewGrabber:        document.getElementById('viewGrabber'),

    // Grabber View
    grabberInput:       document.getElementById('grabberInput'),
    grabBtn:            document.getElementById('grabBtn'),
    grabberStatus:      document.getElementById('grabberStatus'),
    grabberList:        document.getElementById('grabberList'),
    copyAllGrabbedBtn:  document.getElementById('copyAllGrabbedBtn'),
    clearGrabberBtn:    document.getElementById('clearGrabberBtn'),
};

let activeGrabberTaskId = null;

// SVG Icons for statuses
const icons = {
    downloading: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
    success:     '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    error:       '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    maintenance: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
    stop:        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><rect x="6" y="6" width="12" height="12"></rect></svg>',
    copy:        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'
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
                <button class="copy-btn" onclick="copyToClipboard('${task.url}')" title="Copy URL">
                    ${icons.copy}
                </button>
                ${!task.isPriority ? `
                <button class="run-now-btn" onclick="window.electronAPI.startTaskNow('${task.id}')" title="Start Now (Priority)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </button>
                ` : ''}
                <button class="delete-btn" onclick="window.electronAPI.removeFromQueue('${task.id}')" title="Remove from Queue">
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
elements.copyAllQueueBtn.addEventListener('click', handleCopyAllQueue);
elements.copyAllActiveBtn.addEventListener('click', handleCopyAllActive);

elements.navDashboard.addEventListener('click', () => switchTab('dashboard'));
elements.navGrabber.addEventListener('click', () => switchTab('grabber'));
elements.navDownloads.addEventListener('click', handleOpenDownloads);

elements.grabBtn.addEventListener('click', handleGrabLinks);
elements.copyAllGrabbedBtn.addEventListener('click', handleCopyAllGrabbed);
elements.clearGrabberBtn.addEventListener('click', handleClearGrabber);
elements.cleanupBtn.addEventListener('click', handleCleanup);

loadPersistentPath();

elements.urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleDownload();
});

// ── Progress Listeners ─────────────────────────────────────────────────────────
window.electronAPI.onDownloadStarted((task) => {
    if (task.isLinksOnly) return; // Ignore grabber tasks in dashboard state

    state.activeDownloads.set(task.id, {
        url: task.url,
        albumName: null,
        stats: { total: 0, downloaded: 0, failed: 0 },
        files: []
    });
    updateUIForActiveDownloads();
});

window.electronAPI.onProgress((data) => {
    if (activeGrabberTaskId && data.taskId === activeGrabberTaskId) {
        if (data.type === 'found_files') {
            elements.grabberStatus.textContent = `Resolving ${data.total} direct links...`;
        }
        if (data.type === 'file_complete' && data.fileurl) {
            addGrabberLinkRow(data.filename, data.fileurl);
        }
    } else {
        window.onPythonProgress(data);
    }
});

window.electronAPI.onResult((result) => {
    const { taskId, success, error, exitCode } = result;

    if (activeGrabberTaskId && taskId === activeGrabberTaskId) {
        elements.grabBtn.classList.remove('loading');
        elements.grabberStatus.textContent = `Resolution complete: ${result.downloaded || 0} links found.`;
        activeGrabberTaskId = null;
        return;
    }

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

    const taskData = {
        url: url,
        outDir: state.selectedFolder,
        maxWorkers: state.concurrency,
        isPriority: true
    };
    window.electronAPI.addToQueue(taskData);
    showToast('success', 'Download Started', url);
    elements.urlInput.value = '';
}

async function handleCopyAllQueue() {
    const q = await window.electronAPI.getQueue();
    if (!q || q.length === 0) return;
    
    const urls = q.map(task => task.url).join('\n');
    copyToClipboard(urls, 'All queue links copied');
}

function handleCopyAllActive() {
    const rows = elements.filesList.querySelectorAll('.table-row');
    if (rows.length === 0) return;

    const urls = Array.from(rows)
        .map(row => row.dataset.fileurl)
        .filter(url => url)
        .join('\n');
    
    if (urls) {
        copyToClipboard(urls, 'All active download links copied');
    } else {
        showToast('error', 'Copy Failed', 'No direct URLs found to copy');
    }
}

function copyFileUrl(filename) {
    const row = document.querySelector(`[data-filename="${filename}"]`);
    if (row && row.dataset.fileurl) {
        copyToClipboard(row.dataset.fileurl, 'Direct link copied');
    } else {
        showToast('error', 'Copy Failed', 'Direct URL not found');
    }
}

// ── Tab Management ───────────────────────────────────────────────────────────
function switchTab(tab) {
    const views = [elements.viewDashboard, elements.viewGrabber];
    const navs = [elements.navDashboard, elements.navGrabber];

    views.forEach(v => v.classList.remove('active'));
    navs.forEach(n => n.classList.remove('active'));

    if (tab === 'dashboard') {
        elements.viewDashboard.classList.add('active');
        elements.navDashboard.classList.add('active');
    } else if (tab === 'grabber') {
        elements.viewGrabber.classList.add('active');
        elements.navGrabber.classList.add('active');
    }
}

async function handleOpenDownloads() {
    const path = elements.folderPath.value || 'downloads';
    const success = await window.electronAPI.openFolder(path);
    if (!success) {
        showToast('error', 'Error', 'Could not open folder');
    }
}

async function handleCleanup() {
    if (state.activeDownloads.size > 0) {
        showToast('error', 'Action Blocked', 'Cannot clean up while downloads are active');
        return;
    }

    const confirmed = confirm("Are you sure you want to clean up?\n\nThis will permanently delete:\n- All images\n- All videos <= 60 seconds\n- All .tmp folders\n\nThis action cannot be undone.");
    
    if (!confirmed) return;

    elements.cleanupBtn.disabled = true;
    const oldText = elements.cleanupBtn.textContent;
    elements.cleanupBtn.textContent = 'CLEANING...';
    
    try {
        const result = await window.electronAPI.cleanupDownloads(state.selectedFolder);
        if (result.success) {
            const stats = result.stats || {};
            const msg = `Removed: ${stats.images || 0} images, ${stats.videos || 0} short videos, ${stats.folders || 0} tmp folders.`;
            showToast('success', 'Cleanup Complete', msg);
        } else {
            showToast('error', 'Cleanup Failed', result.error || 'Check console for details');
        }
    } catch (err) {
        showToast('error', 'Cleanup Error', err.message);
    } finally {
        elements.cleanupBtn.disabled = false;
        elements.cleanupBtn.textContent = oldText;
    }
}

// ── Link Grabber Logic ───────────────────────────────────────────────────────
async function handleGrabLinks() {
    const url = elements.grabberInput.value.trim();
    if (!url) {
        showToast('warning', 'Input Required', 'Please enter a Bunkr URL');
        return;
    }

    if (!url.includes('bunkr.')) {
        showToast('error', 'Invalid Link', 'Please provide a valid Bunkr link');
        return;
    }

    elements.grabBtn.classList.add('loading');
    elements.grabberStatus.textContent = 'Resolving album links...';
    elements.clearGrabberBtn.click(); // Reset list

    const task = {
        url: url,
        id: 'grabber_' + Date.now(),
        isLinksOnly: true
    };
    
    activeGrabberTaskId = task.id;
    window.electronAPI.addToQueue(task);
}

function handleClearGrabber() {
    elements.grabberList.innerHTML = `
        <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
            <p>No links grabbed yet.</p>
        </div>
    `;
    elements.grabberStatus.textContent = 'Enter a link above to start resolution.';
}

function handleCopyAllGrabbed() {
    const rows = elements.grabberList.querySelectorAll('.grabbed-link-row');
    if (rows.length === 0) return;

    const urls = Array.from(rows)
        .map(row => row.dataset.url)
        .join('\n');
    
    copyToClipboard(urls, `${rows.length} links copied to clipboard`);
}

function addGrabberLinkRow(filename, url) {
    const empty = elements.grabberList.querySelector('.empty-state');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'grabbed-link-row';
    row.dataset.url = url;
    row.innerHTML = `
        <div class="grabbed-url" title="${url}">${url}</div>
        <button class="copy-link-btn" title="Copy Resolved URL" onclick="copyToClipboard('${url}', 'Link copied')">
            ${icons.copy}
        </button>
    `;
    elements.grabberList.prepend(row);
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
        total += download.stats.total || 0;
        downloaded += download.stats.downloaded || 0;
        failed += download.stats.failed || 0;
    }
    
    // Update labels
    elements.totalFiles.textContent = total;
    elements.downloadedFiles.textContent = downloaded;
    elements.failedFiles.textContent = failed;

    // Update Progress Circle (Global)
    const totalDone = downloaded + failed;
    if (total > 0) {
        const pct = Math.round((totalDone / total) * 100);
        updateCircle(pct);
    } else {
        updateCircle(0);
    }

    // Update Total Speed (Aggregated from active rows)
    let aggregateSpeed = 0;
    document.querySelectorAll('.table-row .speed').forEach(el => {
        const text = el.textContent || '';
        // If row is not 'downloading' status anymore, speed won't be there or will be 0
        if (text && text.includes('/s')) {
            const val = parseFloat(text);
            const unit = text.split(' ')[1] || 'B/s';
            let bytes = val;
            if (unit.startsWith('K')) bytes *= 1024;
            else if (unit.startsWith('M')) bytes *= 1024 * 1024;
            else if (unit.startsWith('G')) bytes *= 1024 * 1024 * 1024;
            aggregateSpeed += bytes;
        }
    });
    elements.totalSpeed.textContent = formatSpeed(aggregateSpeed);
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
        updateTableRowProgress(data.filename, data.percent, data.eta, data.speed, data.attempt);
        updateStatsDisplay(); // Keep Total Speed in sync
    }

    if (data.type === 'file_complete') {
        download.stats.downloaded++;
        updateStatsDisplay();
        updateTableRowStatus(data.filename, 'success', data.fileurl);

        if (data.overall_eta) {
            elements.etaValue.textContent = formatSecs(data.overall_eta);
        }
    }

    if (data.type === 'file_error') {
        const isFinal = !!data.is_final;
        if (isFinal) {
            download.stats.failed++;
        }
        const status = data.reason === 'maintenance' ? 'maintenance' : (data.reason === 'skipped' ? 'skipped' : 'error');

        const existing = document.querySelector(`[data-filename="${data.filename}"]`);
        if (!existing && data.filename) addTableRow(data.filename, data.fileurl, taskId);

        if (isFinal && data.filename) {
            updateTableRowStatus(data.filename, status, data.fileurl);
        } else if (!isFinal && data.filename) {
            // Update UI to show it's retrying even on transient error
            updateTableRowProgress(data.filename, 0, 0, 0, data.attempt);
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
        <div class="row-actions">
            <button class="copy-link-btn" title="Copy Direct URL" onclick="copyFileUrl('${filename}')">
                ${icons.copy}
            </button>
            <button class="skip-btn" title="Skip File" onclick="skipFile('${filename}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>
            </button>
        </div>
    `;
    elements.filesList.prepend(row);
}

function updateTableRowProgress(filename, percent, eta, speed, attempt = 1) {
    const row = document.querySelector(`[data-filename="${filename}"]`);
    if (!row) return;

    const badge = row.querySelector('.status-badge');
    if (attempt > 1) {
        badge.className = 'status-badge maintenance';
        badge.innerHTML = `${icons.maintenance} Retrying ${attempt}/10`;
    } else {
        badge.className = 'status-badge downloading';
        badge.innerHTML = `${icons.downloading} Active`;
    }

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

        // ── Auto Remove Finished / Failed Downloads ──
        if (status === 'success' || status === 'error' || status === 'maintenance') {
            const delay = status === 'success' ? 3000 : 5000; // 3s for success, 5s for failures
            setTimeout(() => {
                if (row.parentNode) {
                    row.style.opacity = '0';
                    row.style.transform = 'translateY(-10px)';
                    row.style.transition = 'all 0.4s ease';
                    
                    setTimeout(() => {
                        row.remove();
                        // Re-add empty state if last item was removed
                        if (elements.filesList.children.length === 0) {
                            elements.filesList.innerHTML = `
                                <div class="empty-state">
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                    <p>Queue is empty. Enter an album link above to start.</p>
                                </div>
                            `;
                        }
                    }, 400);
                }
            }, delay); 
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

function copyToClipboard(text, successMsg = 'URL copied to clipboard') {
    navigator.clipboard.writeText(text).then(() => {
        showToast('success', 'Copied!', successMsg);
    }).catch(err => {
        showToast('error', 'Copy Failed', 'Could not access clipboard');
    });
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