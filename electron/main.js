'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path  = require('path');
const { spawn } = require('child_process');
const fs    = require('fs');

// ── Resolve Python executable inside the venv ─────────────────────────────────
const ROOT       = path.join(__dirname, '..');
const VENV_PY    = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
const SYS_PY     = 'python';
const PYTHON_EXE = fs.existsSync(VENV_PY) ? VENV_PY : SYS_PY;
const SCRAPER    = path.join(ROOT, 'scraper_core.py');

const MAX_STANDARD_CONCURRENT = 10;
const MAX_PRIORITY_CONCURRENT = 10;
let activeProcesses = new Map();  // Map<id, { process, task, files: Set<filename>, isPriority: boolean }>
let downloadQueue = [];
let QUEUE_FILE = null;
let mainWindow;
let isShuttingDown = false;

// ── Queue Management ─────────────────────────────────────────────────────────
function loadQueue() {
    try {
        if (QUEUE_FILE && fs.existsSync(QUEUE_FILE)) {
            const data = fs.readFileSync(QUEUE_FILE, 'utf8');
            if (data.trim() !== '') downloadQueue = JSON.parse(data);
        }
    } catch(err) { console.error('[main] Error loading queue', err); }
}

function saveQueue() {
    try {
        if (!QUEUE_FILE) return;
        const activeTasks = Array.from(activeProcesses.values()).map(entry => entry.task);
        const allTasks = [...activeTasks, ...downloadQueue];
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(allTasks, null, 2));
    } catch(err) { console.error('[main] Error saving queue', err); }
}

function getActiveCount(priorityOnly = false) {
    let count = 0;
    for (const [, entry] of activeProcesses) {
        if (priorityOnly) {
            if (entry.isPriority) count++;
        } else {
            if (!entry.isPriority) count++;
        }
    }
    return count;
}

function processQueue() {
    // 1. Process Priority Tasks (if any in queue marked as priority)
    const priorityTasks = downloadQueue.filter(t => t.isPriority);
    while (getActiveCount(true) < MAX_PRIORITY_CONCURRENT && priorityTasks.length > 0) {
        const task = priorityTasks.shift();
        // Remove from main queue
        downloadQueue = downloadQueue.filter(t => t.id !== task.id);
        startPythonScraper(task, true);
        saveQueue();
    }

    // 2. Process Standard Tasks
    const standardTasks = downloadQueue.filter(t => !t.isPriority);
    while (getActiveCount(false) < MAX_STANDARD_CONCURRENT && standardTasks.length > 0) {
        const task = standardTasks.shift();
        // Remove from main queue
        downloadQueue = downloadQueue.filter(t => t.id !== task.id);
        startPythonScraper(task, false);
        saveQueue();
    }

    // Notify UI of updated queue and active downloads
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('queue-updated', downloadQueue);
        mainWindow.webContents.send('active-downloads', getActiveDownloadInfo());
    }
}

function getActiveDownloadInfo() {
    const info = [];
    for (const [id, entry] of activeProcesses) {
        info.push({
            id: id,
            url: entry.task.url,
            albumName: entry.albumName || 'Loading...'
        });
    }
    return info;
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width:           1200,
        height:          900,
        minWidth:        800,
        minHeight:       600,
        backgroundColor: '#0f0f23',
        autoHideMenuBar: true,
        show:            false,
        icon:            path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
        },
        titleBarStyle:    'default',
        title:            'Bunkr Scraper PRO',
    });

    mainWindow.loadFile(path.join(ROOT, 'gui', 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.maximize();
        mainWindow.show();
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

// ── App Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
    // Initialize queue file path after app is ready
    QUEUE_FILE = path.join(app.getPath('userData'), 'bunkr_queue.json');

    // Load any saved queue from previous session
    loadQueue();

    createWindow();

    // Process any pending queue items from previous session
    processQueue();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    isShuttingDown = true;
    saveQueue(); // One final save before killing processes and clearing state

    // Kill all active processes
    for (const [, entry] of activeProcesses) {
        entry.process.kill();
    }
    activeProcesses.clear();
    if (process.platform !== 'darwin') app.quit();
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-queue', () => downloadQueue);

ipcMain.handle('get-active-downloads', () => getActiveDownloadInfo());

ipcMain.on('add-to-queue', (_event, task) => {
    task.id = task.id || Date.now().toString() + Math.random().toString(36).substr(2, 5);
    // isPriority flag comes from options if provided
    task.isPriority = !!task.isPriority;
    
    downloadQueue.push(task);
    saveQueue();
    if (mainWindow) mainWindow.webContents.send('queue-updated', downloadQueue);
    processQueue();
});

ipcMain.on('remove-from-queue', (_event, id) => {
    downloadQueue = downloadQueue.filter(t => t.id !== id);
    saveQueue();
    if (mainWindow) mainWindow.webContents.send('queue-updated', downloadQueue);
});

ipcMain.on('start-task-now', (_event, id) => {
    const taskIndex = downloadQueue.findIndex(t => t.id === id);
    if (taskIndex > -1) {
        downloadQueue[taskIndex].isPriority = true;
        saveQueue();
        if (mainWindow) mainWindow.webContents.send('queue-updated', downloadQueue);
        processQueue();
    }
});

ipcMain.on('skip-file', (_event, filename) => {
    for (const [, entry] of activeProcesses) {
        if (entry.files.has(filename) && entry.process.stdin) {
            console.log(`[main] Passing skip request for: ${filename}`);
            const payload = JSON.stringify({ action: "skip", filename: filename });
            entry.process.stdin.write(payload + "\n");
            break;
        }
    }
});

// ── Python Process Management ──────────────────────────────────────────────────
function startPythonScraper(task, isPriority = false) {
    const { url, outDir, maxWorkers, id } = task;

    const args = [SCRAPER, url];
    if (outDir) args.push(outDir);
    if (maxWorkers) args.push('--threads', maxWorkers.toString());
    args.push('--retries', '5');
    if (task.isLinksOnly) args.push('--links-only');

    console.log(`[main] Spawning [${isPriority ? 'PRIORITY' : (task.isLinksOnly ? 'GRABBER' : 'STANDARD')}] python: ${PYTHON_EXE} ${args.join(' ')}`);

    const child = spawn(PYTHON_EXE, args, {
        cwd:  ROOT,
        env:  { ...process.env },
    });

    const entry = {
        process: child,
        task: task,
        files: new Set(),
        albumName: null,
        isPriority: isPriority
    };
    activeProcesses.set(id, entry);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-started', { url, outDir, maxWorkers, id });
        mainWindow.webContents.send('active-downloads', getActiveDownloadInfo());
    }

    let buffer = '';

    child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;

            if (line.startsWith('{')) {
                try {
                    const parsed = JSON.parse(line);
                    parsed.taskId = id;

                    if (parsed.type === 'album_info' && parsed.name) {
                        entry.albumName = parsed.name;
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('active-downloads', getActiveDownloadInfo());
                        }
                    }

                    if (parsed.type === 'file_start' && parsed.filename) {
                        entry.files.add(parsed.filename);
                    }

                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('progress', parsed);
                    }
                } catch { }
            }
        }
    });

    child.stderr.on('data', (data) => {
        console.error('[python stderr]', data.toString());
    });

    child.on('close', (code) => {
        console.log(`[main] Python ${id} exited with code ${code}`);
        
        if (isShuttingDown) return; // Prevent state removal during app shutdown

        activeProcesses.delete(id);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-result', {
                success:  code === 0,
                exitCode: code,
                taskId:   id,
                url:      url
            });
            mainWindow.webContents.send('active-downloads', getActiveDownloadInfo());
        }

        saveQueue();
        processQueue();
    });

    child.on('error', (err) => {
        console.error('[main] Failed to spawn Python:', err);
        
        if (isShuttingDown) return;

        activeProcesses.delete(id);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-result', {
                success:  false,
                exitCode: -1,
                error:    err.message,
                taskId:   id,
                url:      url
            });
            mainWindow.webContents.send('active-downloads', getActiveDownloadInfo());
        }
        saveQueue();
        processQueue();
    });
}

// ── IPC: open downloads folder ────────────────────────────────────────────────
ipcMain.on('open-downloads', (_event, dir) => {
    const target = dir || path.join(ROOT, 'downloads');
    shell.openPath(target);
});

// ── IPC: stop download(s) ──────────────────────────────────────────────────────
ipcMain.on('stop-download', (_event, taskId) => {
    if (taskId) {
        const entry = activeProcesses.get(taskId);
        if (entry) {
            console.log(`[main] Stopping download ${taskId}`);
            entry.process.kill();
            activeProcesses.delete(taskId);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('active-downloads', getActiveDownloadInfo());
            }
            saveQueue();
            processQueue();
        }
    } else {
        console.log('[main] Stopping all downloads');
        for (const [, entry] of activeProcesses) {
            entry.process.kill();
        }
        activeProcesses.clear();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('active-downloads', []);
        }
        saveQueue();
    }
});

// ── IPC: select folder ────────────────────────────────────────────────────────
ipcMain.handle('select-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title:      'Select Destination Folder',
        buttonLabel: 'Select Folder',
    });

    return canceled ? null : filePaths[0];
});
ipcMain.handle('open-folder', async (_event, dir) => {
    try {
        const fullPath = path.resolve(ROOT, dir || 'downloads');
        if (fs.existsSync(fullPath)) {
            await shell.openPath(fullPath);
            return true;
        }
        return false;
    } catch (err) {
        console.error('[main] Failed to open folder:', err);
        return false;
    }
});
