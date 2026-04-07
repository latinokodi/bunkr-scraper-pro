'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');


const QueueManager = require('./lib/QueueManager');
const SlotManager = require('./lib/SlotManager');
const ProcessManager = require('./lib/ProcessManager');

// ── Resolve Python executable and Scraper path ───────────────────────────────
const isPackaged = app.isPackaged;
const ROOT = isPackaged ? process.resourcesPath : path.join(__dirname, '..');

let PYTHON_EXE;
let SCRAPER_SCRIPT;

if (isPackaged) {
    // In production, we use the frozen Python executable
    PYTHON_EXE = path.join(process.resourcesPath, 'bin', 'bunkr_scraper_core.exe');
    SCRAPER_SCRIPT = null; // Arguments are handled differently for frozen exe
} else {
    // In development, we use the venv Python and the script
    const VENV_PY = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
    PYTHON_EXE = fs.existsSync(VENV_PY) ? VENV_PY : 'python';
    SCRAPER_SCRIPT = path.join(ROOT, 'bunkr_core', 'scraper_core.py');
}

// ── Application State ────────────────────────────────────────────────────────
let MAX_STANDARD_CONCURRENT = 3;
let mainWindow = null;
let isShuttingDown = false;

// ── Initialize Managers ──────────────────────────────────────────────────────

const queue = new QueueManager(app.getPath('userData'));
const slots = new SlotManager(3);
const processes = new ProcessManager(ROOT, PYTHON_EXE, SCRAPER_SCRIPT, slots);

// ── Startup Cleanup ──────────────────────────────────────────────────────────

function cleanupTmpFiles() {
    const downloadsDir = path.join(ROOT, 'downloads');
    if (!fs.existsSync(downloadsDir)) return;

    let cleaned = 0;
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '.tmp') {
                    try {
                        fs.rmSync(full, { recursive: true, force: true });
                        cleaned++;
                    } catch (err) {
                        console.error(`[cleanup] Failed to remove ${full}:`, err.message);
                    }
                } else {
                    walk(full);
                }
            }
        }
    };

    walk(downloadsDir);
    if (cleaned > 0) console.log(`[cleanup] Removed ${cleaned} stale .tmp director${cleaned === 1 ? 'y' : 'ies'}`);
}

// ── Orchestration ────────────────────────────────────────────────────────────

function startNextInQueue() {
    if (isShuttingDown) return;
    
    const activeCount = processes.activeProcesses.size;
    const tasksToStart = queue.getNext(MAX_STANDARD_CONCURRENT, activeCount);

    for (const { task, isPriority } of tasksToStart) {
        processes.start(task, isPriority);
    }

    syncUi();
}

function syncUi() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('queue-updated', queue.queue);
        mainWindow.webContents.send('active-downloads', processes.getActiveDownloadInfo());
    }
}

// ── Process Event Handlers ────────────────────────────────────────────────────

processes.on('message', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('progress', data);
    }
});

processes.on('album-info', () => syncUi());

processes.on('process-stopped', ({ id, code }) => {
    if (isShuttingDown) return;

    const isCancelled = intentionalStops.has(id);
    intentionalStops.delete(id);

    // Definitively remove from activeTasks in QueueManager
    // This ensures that whether it succeeded, failed, or was cancelled, 
    // it won't reappear on next app start.
    queue.finishTask(id);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-result', {
            success: code === 0 || isCancelled,
            cancelled: isCancelled,
            exitCode: code,
            taskId: id
        });
    }
    
    startNextInQueue();
});

// ── Window Management ────────────────────────────────────────────────────────

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        backgroundColor: '#0f0f23',
        autoHideMenuBar: true,
        show: false,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: 'Bunkr Scraper PRO',
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'gui', 'index.html'));

    if (isPackaged) {
        // Fallback for packaged app if the above fails
        const packagedPath = path.join(__dirname, 'gui', 'index.html');
        if (fs.existsSync(packagedPath)) {
            mainWindow.loadFile(packagedPath);
        }
    }

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

app.whenReady().then(async () => {
    cleanupTmpFiles();
    queue.load();
    
    createWindow();
    startNextInQueue();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('before-quit', () => {
    isShuttingDown = true;
    // Only save the ACTUAL pending queue. 
    // Active downloads are already considered "removed from section" on quit 
    // unless there is a specific 'resume' feature.
    queue.save(); 
    processes.stopAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-queue', () => queue.queue);
ipcMain.handle('get-active-downloads', () => processes.getActiveDownloadInfo());

ipcMain.on('add-to-queue', (_event, task) => {
    queue.add(task);
    syncUi();
    startNextInQueue();
});

ipcMain.on('remove-from-queue', (_event, id) => {
    queue.remove(id);
    syncUi();
});

ipcMain.on('start-task-now', (_event, id) => {
    if (queue.setPriority(id, true)) {
        syncUi();
        startNextInQueue();
    }
});

ipcMain.on('skip-file', (_event, filename) => {
    console.log(`[main] Passing skip request for: ${filename}`);
    for (const [id] of processes.activeProcesses) {
        processes.skipFile(id, filename);
    }
});

ipcMain.on('requeue-file', (_event, {taskId, filename, bunkrUrl}) => {
    console.log(`[main] Requeuing file: ${filename} from task: ${taskId} -> ${bunkrUrl}`);
    
    // 1. Skip the file to free up the global concurrent file slot immediately
    processes.skipFile(taskId, filename);
    
    // 2. Build the new focused task targeting just this file
    const entry = processes.activeProcesses.get(taskId);
    if (!entry) return; // Process might have completely finished
    
    // Match Python's bunkr_core/utils.py:sanitize_filename logic
    const pythonSanitize = (name) => {
        if (!name) return "Unknown_Album";
        let sanitized = name.replace(/[<>:"/\\|?*]/g, "_").trim();
        // Trim leading/trailing dots and spaces
        sanitized = sanitized.replace(/^[. ]+|[. ]+$/g, "");
        return sanitized || "file";
    };

    let targetOutDir;
    if (entry.task.noSubdir) {
        targetOutDir = entry.task.outDir;
    } else {
        const baseDir = entry.task.outDir || path.join(process.cwd(), "downloads");
        const dirName = pythonSanitize(entry.albumName);
        targetOutDir = path.join(baseDir, dirName);
    }

    const newTask = {
        url: bunkrUrl,
        outDir: targetOutDir,
        maxWorkers: entry.task.maxWorkers,
        isPriority: false, // Standard priority -> Bottom of the queue
        noSubdir: true     // Prevent BunkrScraperCore from making a sub-subfolder for the naked file
    };

    queue.add(newTask);
    syncUi();
});

const intentionalStops = new Set();

ipcMain.on('stop-download', (_event, taskId) => {
    if (taskId) {
        intentionalStops.add(taskId);
        processes.stop(taskId);
        queue.remove(taskId); // Definitively nuke it from queue so it never resumes
    } else {
        // Stop all
        for (const [id] of processes.activeProcesses) {
            intentionalStops.add(id);
            queue.remove(id); // Definitively remove all active from persistence
        }
        processes.stopAll();
    }
    syncUi();
    startNextInQueue();
});

ipcMain.handle('set-concurrency', (_event, value) => {
    // Handle both number and object { albums: X } payloads
    // Now interpreting this value specifically as the GLOBAL FILE CONCURRENCY limit
    const limit = typeof value === 'object' ? parseInt(value.albums, 10) : parseInt(value, 10);
    
    if (!isNaN(limit) && limit >= 1) {
        console.log(`[main] Setting global FILE concurrency limit to: ${limit}`);
        // We no longer update MAX_STANDARD_CONCURRENT here. 
        // Album concurrency remains fixed (default 3) to allow distribution of the file slots.
        
        slots.updateLimit(limit);
        startNextInQueue();
        return true;
    }
    return false;
});

ipcMain.handle('get-concurrency', () => ({
    albums: MAX_STANDARD_CONCURRENT,
    files: slots.maxFileSlots
}));

ipcMain.handle('select-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Destination Folder',
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

ipcMain.handle('cleanup-downloads', async (_event, targetDir) => {
    if (processes.activeProcesses.size > 0) {
        return { success: false, error: 'Cannot perform cleanup while downloads are active.' };
    }
    const outputDir = targetDir || path.join(ROOT, 'downloads');
    const args = [SCRAPER_SCRIPT, '--cleanup', outputDir];
    
    return new Promise((resolve) => {
        const child = spawn(PYTHON_EXE, args, { cwd: ROOT });
        let output = '';
        child.stdout.on('data', (d) => output += d.toString());
        child.on('close', (code) => {
            if (code === 0) {
                try {
                    const lines = output.trim().split('\n');
                    const result = JSON.parse(lines[lines.length - 1]);
                    resolve(result);
                } catch { resolve({ success: true, message: 'Cleanup finished' }); }
            } else {
                resolve({ success: false, error: `Cleanup failed (code ${code})` });
            }
        });
    });
});
