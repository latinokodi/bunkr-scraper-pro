'use strict';

const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

class ProcessManager extends EventEmitter {
    constructor(rootDir, pythonExe, scraperScript, slotManager) {
        super();
        this.rootDir = rootDir;
        this.pythonExe = pythonExe;
        this.scraperScript = scraperScript;
        this.slotManager = slotManager;
        this.activeProcesses = new Map(); // Map<id, { process, task, files, activeFiles, albumName, isPriority }>
        this.isShuttingDown = false;
    }

    start(task, isPriority = false) {
        const { url, outDir, maxWorkers, id } = task;
        const args = [this.scraperScript, url];
        if (outDir) args.push(outDir);
        // Set a fixed high threads limit (20) for Python. 
        // This decouples the Python worker count from the Electron limit, 
        // allowing the Electron SlotManager to be the sole authority.
        args.push('--threads', '20');
        args.push('--retries', '5');
        if (task.isLinksOnly) args.push('--links-only');

        console.log(`[ProcessManager] Spawning [${isPriority ? 'PRIORITY' : (task.isLinksOnly ? 'GRABBER' : 'STANDARD')}] python: ${this.pythonExe} ${args.join(' ')}`);

        const child = spawn(this.pythonExe, args, {
            cwd: this.rootDir,
            env: { ...process.env },
        });

        const entry = {
            process: child,
            task: task,
            files: new Set(),
            activeFiles: new Set(),
            albumName: null,
            isPriority: isPriority
        };
        this.activeProcesses.set(id, entry);

        this.emit('process-started', { id, task, isPriority });

        let buffer = '';
        child.stdout.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const raw of lines) {
                const line = raw.trim();
                if (!line || !line.startsWith('{')) continue;

                try {
                    const parsed = JSON.parse(line);
                    parsed.taskId = id;

                    if (parsed.type === 'album_info' && parsed.name) {
                        entry.albumName = parsed.name;
                        this.emit('album-info', { id, name: parsed.name });
                    }

                    if (parsed.type === 'file_start' && parsed.filename) {
                        entry.files.add(parsed.filename);
                    }

                    if (parsed.type === 'request_slot' && parsed.filename) {
                        this.slotManager.requestSlot(id, parsed.filename, () => {
                            if (entry.process && entry.process.stdin) {
                                entry.activeFiles.add(parsed.filename);
                                entry.process.stdin.write(JSON.stringify({ action: "grant_slot", filename: parsed.filename }) + "\n");
                            }
                        });
                    }

                    if (parsed.type === 'release_slot' && parsed.filename) {
                        entry.activeFiles.delete(parsed.filename);
                        this.slotManager.releaseSlot(parsed.filename);
                    }

                    this.emit('message', parsed);
                } catch (e) {
                    console.error(`[ProcessManager] Error parsing JSON from ${id}:`, e);
                }
            }
        });

        child.stderr.on('data', (data) => {
            console.error(`[python stderr ${id}]`, data.toString());
        });

        child.on('close', (code) => {
            console.log(`[ProcessManager] Python ${id} exited with code ${code}`);
            if (this.isShuttingDown) return;

            // Cleanup slots
            entry.activeFiles.forEach(fname => this.slotManager.releaseSlot(fname));
            this.slotManager.clearSlotsForTask(id);

            this.activeProcesses.delete(id);
            this.emit('process-stopped', { id, code });
        });

        return child;
    }

    stop(id) {
        const entry = this.activeProcesses.get(id);
        if (entry && entry.process) {
            entry.process.kill();
        }
    }

    stopAll() {
        this.isShuttingDown = true;
        for (const [id, entry] of this.activeProcesses) {
            if (entry.process) entry.process.kill();
        }
        this.activeProcesses.clear();
    }

    skipFile(id, filename) {
        const entry = this.activeProcesses.get(id);
        if (entry && entry.files.has(filename) && entry.process.stdin) {
            const payload = JSON.stringify({ action: "skip", filename: filename });
            entry.process.stdin.write(payload + "\n");
            // If it was waiting for a slot, SlotManager doesn't know about filenames specifically yet, 
            // but we can clear it if we implement filename-based clearing in SlotManager.
            // For now, python will just ignore the grant_slot if it receives it after a skip.
        }
    }

    getActiveDownloadInfo() {
        return Array.from(this.activeProcesses.entries()).map(([id, entry]) => ({
            id: id,
            url: entry.task.url,
            albumName: entry.albumName || 'Loading...'
        }));
    }
}

module.exports = ProcessManager;
