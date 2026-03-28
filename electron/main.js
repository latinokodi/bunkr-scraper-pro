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

// ── IPC: start download ───────────────────────────────────────────────────────
ipcMain.on('start-download', (event, { url, outDir, maxWorkers }) => {
    if (activeProcess) {
        // Kill any previous run before starting a new one
        activeProcess.kill();
        activeProcess = null;
    }

    const args = [SCRAPER, url];
    if (outDir) args.push(outDir);
    if (maxWorkers) args.push('--threads', maxWorkers.toString());

    console.log(`[main] Spawning python: ${PYTHON_EXE} ${args.join(' ')}`);

    const child = spawn(PYTHON_EXE, args, {
        cwd:  ROOT,
        env:  { ...process.env },
    });

    activeProcess = child;

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

    // ── process exit → send final result ─────────────────────────────────────
    child.on('close', (code) => {
        console.log(`[main] Python exited with code ${code}`);
        activeProcess = null;

        mainWindow.webContents.send('download-result', {
            success:  code === 0,
            exitCode: code,
        });
    });

    child.on('error', (err) => {
        console.error('[main] Failed to spawn Python:', err);
        activeProcess = null;

        mainWindow.webContents.send('download-result', {
            success:  false,
            exitCode: -1,
            error:    err.message,
        });
    });
});

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
