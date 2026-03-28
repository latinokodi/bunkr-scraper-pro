'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path  = require('path');
const { spawn } = require('child_process');
const fs    = require('fs');

// ── Resolve Python executable inside the venv ─────────────────────────────────
const ROOT       = path.join(__dirname, '..');          // f:\PyApps\bunkrscr
const VENV_PY    = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
const SYS_PY     = 'python';
const PYTHON_EXE = fs.existsSync(VENV_PY) ? VENV_PY : SYS_PY;
const SCRAPER    = path.join(ROOT, 'scraper_core.py');

let mainWindow;
let activeProcess = null;   // currently running Python child

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width:           1200,
        height:          900,
        minWidth:        800,
        minHeight:       600,
        backgroundColor: '#0f0f23',
        autoHideMenuBar: true,
        show:            false,   // Don't show immediately to prevent flash
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

    // Open external links in the system browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (activeProcess) activeProcess.kill();
    if (process.platform !== 'darwin') app.quit();
});



// ── Queue Management ─────────────────────────────────────────────────────────
const QUEUE_FILE = path.join(app.getPath('userData'), 'bunkr_queue.json');
let downloadQueue = [];

function loadQueue() {
    try {
        if (fs.existsSync(QUEUE_FILE)) {
            const data = fs.readFileSync(QUEUE_FILE, 'utf8');
            if (data.trim() !== '') downloadQueue = JSON.parse(data);
        }
    } catch(err) { console.error('[main] Error loading queue', err); }
}

function saveQueue() {
    try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(downloadQueue, null, 2)); }
    catch(err) { console.error('[main] Error saving queue', err); }
}

function processQueue() {
    if (activeProcess || downloadQueue.length === 0) return;
    const task = downloadQueue[0];
    startPythonScraper(task);
}

loadQueue();

ipcMain.handle('get-queue', () => downloadQueue);

ipcMain.on('add-to-queue', (event, task) => {
    // Add a unique ID if it doesn't have one
    task.id = task.id || Date.now().toString() + Math.random().toString(36).substr(2, 5);
    downloadQueue.push(task);
    saveQueue();
    if (mainWindow) mainWindow.webContents.send('queue-updated', downloadQueue);
    processQueue();
});

ipcMain.on('remove-from-queue', (event, id) => {
    downloadQueue = downloadQueue.filter(t => t.id !== id);
    saveQueue();
    if (mainWindow) mainWindow.webContents.send('queue-updated', downloadQueue);
});

ipcMain.on('skip-file', (event, filename) => {
    if (activeProcess && activeProcess.stdin) {
        console.log(`[main] Passing skip request for: ${filename}`);
        const payload = JSON.stringify({ action: "skip", filename: filename });
        activeProcess.stdin.write(payload + "\n");
    }
});

// ── Python Process Management ──────────────────────────────────────────────────
function startPythonScraper({ url, outDir, maxWorkers, id }) {
    const args = [SCRAPER, url];
    if (outDir) args.push(outDir);
    if (maxWorkers) args.push('--threads', maxWorkers.toString());

    console.log(`[main] Spawning python: ${PYTHON_EXE} ${args.join(' ')}`);

    const child = spawn(PYTHON_EXE, args, {
        cwd:  ROOT,
        env:  { ...process.env },
    });

    activeProcess = child;

    // Immediately notify UI that the process has launched (avoids stale empty screens)
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-started', { url, outDir, maxWorkers, id });
    }

    let buffer = '';

    // ── stdout: JSON progress lines ───────────────────────────────────────────
    child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();           // keep incomplete last line

        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;

            // Forward JSON progress events to renderer
            if (line.startsWith('{')) {
                try {
                    const parsed = JSON.parse(line);
                    mainWindow.webContents.send('progress', parsed);
                } catch {
                    // Not JSON — just a plain console log; ignore for UI
                }
            }
        }
    });

    // ── stderr: log errors but don't crash ───────────────────────────────────
    child.stderr.on('data', (data) => {
        console.error('[python stderr]', data.toString());
    });

    // ── process exit → queue advancement ─────────────────────────────────────
    child.on('close', (code) => {
        console.log(`[main] Python exited with code ${code}`);
        activeProcess = null;

        mainWindow.webContents.send('download-result', {
            success:  code === 0,
            exitCode: code,
        });

        // Advance Queue
        if (downloadQueue.length > 0 && downloadQueue[0].id === id) {
            downloadQueue.shift();
            saveQueue();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('queue-updated', downloadQueue);
            }
        }
        processQueue();
    });

    child.on('error', (err) => {
        console.error('[main] Failed to spawn Python:', err);
        activeProcess = null;

        mainWindow.webContents.send('download-result', {
            success:  false,
            exitCode: -1,
            error:    err.message,
        });

        // Advance Queue on catastrophic failure
        if (downloadQueue.length > 0 && downloadQueue[0].id === id) {
            downloadQueue.shift();
            saveQueue();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('queue-updated', downloadQueue);
            }
        }
        processQueue();
    });
}

// ── IPC: open downloads folder ────────────────────────────────────────────────
ipcMain.on('open-downloads', (_event, dir) => {
    const target = dir || path.join(ROOT, 'downloads');
    shell.openPath(target);
});

// ── IPC: stop download ────────────────────────────────────────────────────────
ipcMain.on('stop-download', () => {
    if (activeProcess) {
        console.log('[main] Manual stop requested. Killing python process...');
        activeProcess.kill();
        activeProcess = null;
    }
    // Note: stopping the active process effectively aborts the current task, 
    // the 'close' handler will then advance the queue to the next item automatically.
});

// ── IPC: select folder ────────────────────────────────────────────────────────
ipcMain.handle('select-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title:      'Select Destination Folder',
        buttonLabel: 'Select Folder',
    });

    if (canceled) {
        return null;
    } else {
        return filePaths[0];
    }
});
