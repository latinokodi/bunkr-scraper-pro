'use strict';

const fs = require('fs');
const path = require('path');

class QueueManager {
    constructor(userDataPath) {
        this.queueFile = path.join(userDataPath, 'download_queue.json');
        this.queue = [];        // Pending tasks
        this.activeTasks = new Map(); // Currently running tasks: Map<id, task>
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

    save(extraActive = []) {
        try {
            // Combine pending + active into the persistent file
            const activeTasksArr = Array.from(this.activeTasks.values());
            const allTasks = [...extraActive, ...activeTasksArr, ...this.queue];
            
            // Deduplicate by ID just in case
            const uniqueTasks = Array.from(new Map(allTasks.map(t => [t.id, t])).values());
            
            fs.writeFileSync(this.queueFile, JSON.stringify(uniqueTasks, null, 2));
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
        this.activeTasks.delete(id);
        this.save();
    }

    finishTask(id) {
        // Definitively remove a task once it has finished successfully or failed finally
        if (this.activeTasks.has(id)) {
            this.activeTasks.delete(id);
            this.save();
        }
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
            let task = null;
            let index = -1;

            // 1. Check priority tasks
            index = this.queue.findIndex(t => t.isPriority);
            if (index > -1) {
                task = this.queue.splice(index, 1)[0];
            } else {
                // 2. Check standard tasks
                index = this.queue.findIndex(t => !t.isPriority);
                if (index > -1) {
                    task = this.queue.splice(index, 1)[0];
                }
            }

            if (task) {
                this.activeTasks.set(task.id, task);
                tasksToStart.push({ task, isPriority: task.isPriority });
                available--;
            } else {
                break;
            }
        }

        if (tasksToStart.length > 0) this.save();
        return tasksToStart;
    }
}

module.exports = QueueManager;
