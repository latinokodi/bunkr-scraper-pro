'use strict';

const fs = require('fs');
const path = require('path');

class QueueManager {
    constructor(userDataPath) {
        this.queueFile = path.join(userDataPath, 'download_queue.json');
        this.queue = [];
    }

    load() {
        try {
            if (fs.existsSync(this.queueFile)) {
                const data = fs.readFileSync(this.queueFile, 'utf8');
                if (data.trim() !== '') {
                    this.queue = JSON.parse(data);
                }
            }
        } catch (err) {
            console.error('[QueueManager] Error loading queue', err);
        }
        return this.queue;
    }

    save(activeTasks = []) {
        try {
            const allTasks = [...activeTasks, ...this.queue];
            fs.writeFileSync(this.queueFile, JSON.stringify(allTasks, null, 2));
        } catch (err) {
            console.error('[QueueManager] Error saving queue', err);
        }
    }

    add(task) {
        if (typeof task === 'string') {
            task = { url: task };
        }
        task.id = task.id || Date.now().toString() + Math.random().toString(36).substr(2, 5);
        task.isPriority = !!task.isPriority;
        
        this.queue.push(task);
        this.save();
        return task;
    }

    remove(id) {
        this.queue = this.queue.filter(t => t.id !== id);
        this.save();
    }

    setPriority(id, isPriority = true) {
        const index = this.queue.findIndex(t => t.id === id);
        if (index > -1) {
            this.queue[index].isPriority = isPriority;
            this.save();
            return true;
        }
        return false;
    }

    getNext(maxTotal, currentActive) {
        const tasksToStart = [];
        let available = maxTotal - currentActive;

        while (available > 0) {
            // 1. Check priority tasks
            const priorityIndex = this.queue.findIndex(t => t.isPriority);
            if (priorityIndex > -1) {
                tasksToStart.push({ task: this.queue.splice(priorityIndex, 1)[0], isPriority: true });
                available--;
                continue;
            }

            // 2. Check standard tasks
            const standardIndex = this.queue.findIndex(t => !t.isPriority);
            if (standardIndex > -1) {
                tasksToStart.push({ task: this.queue.splice(standardIndex, 1)[0], isPriority: false });
                available--;
                continue;
            }

            break;
        }

        if (tasksToStart.length > 0) this.save();
        return tasksToStart;
    }
}

module.exports = QueueManager;
