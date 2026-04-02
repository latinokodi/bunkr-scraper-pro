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

const MAX_STANDARD_CONCURRENT = 5;
const MAX_PRIORITY_CONCURRENT = 100; // Effectively unlimited for overrides
const MAX_FILE_SLOTS         = 10;

let activeFileSlots         = 0;
let slotQueue               = []; // Array of { taskId, filename }
let activeProcesses         = new Map();  // Map<id, { process, task, files: Set<filename>, activeFiles: Set<filename>, isPriority: boolean }>
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
    // 1. Process Priority Tasks (Manual Overrides)
    const priorityTasks = downloadQueue.filter(t => t.isPriority);
    while (priorityTasks.length > 0) {
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
ipcMain.handle('cleanup-downloads', async (_event, targetDir) => {
    if (activeProcesses.size > 0) {
        return { success: false, error: 'Cannot perform cleanup while downloads are active.' };
    }

    const outputDir = targetDir || path.join(ROOT, 'downloads');
    const args = [SCRAPER, '--cleanup', outputDir];

    console.log(`[main] Spawning cleanup: ${PYTHON_EXE} ${args.join(' ')}`);

    return new Promise((resolve) => {
        const child = spawn(PYTHON_EXE, args, { cwd: ROOT });
        let output = '';
        child.stdout.on('data', (data) => {
            const str = data.toString();
            output += str;
        });
        child.on('close', (code) => {
            if (code === 0) {
                try {
                    // Find the last line that looks like JSON
                    const lines = output.trim().split('\n');
                    const lastLine = lines[lines.length - 1];
                    const result = JSON.parse(lastLine);
                    resolve(result);
                } catch (e) {
                    resolve({ success: true, message: 'Cleanup finished' });
                }
            } else {
                resolve({ success: false, error: `Cleanup failed (code ${code})` });
            }
        });
    });
});

ipcMain.on('add-to-queue', (_event, task) => {
    // Defense: If task is a string (URL), wrap it in an object
    if (typeof task === 'string') {
        task = { url: task };
    }
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
    for (const [id, entry] of activeProcesses) {
        if (entry.files.has(filename) && entry.process.stdin) {
            console.log(`[main] Passing skip request for: ${filename}`);
            const payload = JSON.stringify({ action: "skip", filename: filename });
            entry.process.stdin.write(payload + "\n");
            
            // If it was waiting for a slot, remove it from queue
            slotQueue = slotQueue.filter(q => q.filename !== filename);
            // If it was active, release its slot will happen via python's release_slot emission
            break;
        }
    }
});

// ── Slot Manager ─────────────────────────────────────────────────────────────
function requestSlot(taskId, filename) {
    if (activeFileSlots < MAX_FILE_SLOTS) {
        activeFileSlots++;
        grantSlot(taskId, filename);
    } else {
        console.log(`[slots] Queuing slot request for ${filename} (Total active: ${activeFileSlots})`);
        slotQueue.push({ taskId, filename });
    }
}

function releaseSlot(taskId, filename) {
    const entry = activeProcesses.get(taskId);
    if (entry) entry.activeFiles.delete(filename);

    if (activeFileSlots > 0) activeFileSlots--;
    
    console.log(`[slots] Released slot for ${filename}. Remaining active: ${activeFileSlots}`);
    
    if (slotQueue.length > 0) {
        const next = slotQueue.shift();
        activeFileSlots++;
        grantSlot(next.taskId, next.filename);
    }
}

function grantSlot(taskId, filename) {
    const entry = activeProcesses.get(taskId);
    if (entry && entry.process && entry.process.stdin) {
        console.log(`[slots] Granting slot to ${taskId} for ${filename}`);
        entry.activeFiles.add(filename);
        entry.process.stdin.write(JSON.stringify({ action: "grant_slot", filename: filename }) + "\n");
    }
}

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
        activeFiles: new Set(), // Files currently holding an aria2 slot
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

                    if (parsed.type === 'request_slot' && parsed.filename) {
                        requestSlot(id, parsed.filename);
                    }

                    if (parsed.type === 'release_slot' && parsed.filename) {
                        releaseSlot(id, parsed.filename);
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

        // Clean up any slots this process might have been holding or requesting
        const entry = activeProcesses.get(id);
        if (entry) {
            entry.activeFiles.forEach(fname => releaseSlot(id, fname));
            slotQueue = slotQueue.filter(q => q.taskId !== id);
        }

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
