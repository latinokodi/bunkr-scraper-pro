'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');


const QueueManager = require('./lib/QueueManager');
const SlotManager = require('./lib/SlotManager');
const ProcessManager = require('./lib/ProcessManager');

// ── Resolve Python executable and Scraper path ───────────────────────────────
const ROOT = path.join(__dirname, '..');
const VENV_PY = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
const SYS_PY = 'python';
const PYTHON_EXE = fs.existsSync(VENV_PY) ? VENV_PY : SYS_PY;
const SCRAPER_SCRIPT = path.join(ROOT, 'bunkr_core', 'scraper_core.py');

// ── Application State ────────────────────────────────────────────────────────
let MAX_STANDARD_CONCURRENT = 3;
let mainWindow = null;
let isShuttingDown = false;

// ── Initialize Managers ──────────────────────────────────────────────────────

const queue = new QueueManager(app.getPath('userData'));
const slots = new SlotManager(3);
const processes = new ProcessManager(ROOT, PYTHON_EXE, SCRAPER_SCRIPT, slots);

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

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-result', {
            success: code === 0,
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

app.whenReady().then(async () => {
    queue.load();
    

    createWindow();
    startNextInQueue();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    isShuttingDown = true;
    queue.save(Array.from(processes.activeProcesses.values()).map(e => e.task));
    processes.stopAll();
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

ipcMain.on('stop-download', (_event, taskId) => {
    if (taskId) {
        processes.stop(taskId);
    } else {
        processes.stopAll();
    }
    syncUi();
    startNextInQueue();
});

ipcMain.handle('set-concurrency', (_event, value) => {
    // Handle both number and object { albums: X } payloads
    const limit = typeof value === 'object' ? parseInt(value.albums, 10) : parseInt(value, 10);
    
    if (!isNaN(limit) && limit >= 1) {
        console.log(`[main] Setting global concurrency limit to: ${limit}`);
        MAX_STANDARD_CONCURRENT = limit;
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
