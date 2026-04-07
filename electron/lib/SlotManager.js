'use strict';

class SlotManager {
    constructor(maxFileSlots = 3) {
        this.maxFileSlots = maxFileSlots;
        this.activeFileSlots = 0;
        this.activeSlots = new Set(); // Set of "taskId:filename"
        this.slotQueue = []; // Array of { taskId, filename, callback }
        console.log(`[SlotManager] Initialized with limit: ${this.maxFileSlots}`);
    }

    updateLimit(newLimit) {
        console.log(`[SlotManager] Updating limit from ${this.maxFileSlots} to ${newLimit}`);
        this.maxFileSlots = newLimit;
        this.processQueue();
    }

    requestSlot(taskId, key, grantCallback) {
        const slotKey = `${taskId}:${key}`;
        if (this.activeFileSlots < this.maxFileSlots) {
            this.activeFileSlots++;
            this.activeSlots.add(slotKey);
            console.log(`[SlotManager] GRANT (Immediate) - ${key} [Active: ${this.activeFileSlots}/${this.maxFileSlots}]`);
            grantCallback();
        } else {
            console.log(`[SlotManager] QUEUE - ${key} [Current Active: ${this.activeFileSlots}/${this.maxFileSlots}]`);
            this.slotQueue.push({ taskId, key, grantCallback });
        }
    }

    releaseSlot(taskId, key) {
        const slotKey = `${taskId}:${key}`;
        
        // 1. If it's in the queue, remove it from there
        const initialQueueLength = this.slotQueue.length;
        this.slotQueue = this.slotQueue.filter(q => !(q.taskId === taskId && q.key === key));
        
        if (this.slotQueue.length < initialQueueLength) {
            console.log(`[SlotManager] REMOVE (Queued) - ${key}`);
            return;
        }

        // 2. If it was active, release it
        if (this.activeSlots.has(slotKey)) {
            this.activeSlots.delete(slotKey);
            this.activeFileSlots = Math.max(0, this.activeFileSlots - 1);
            console.log(`[SlotManager] RELEASE - ${key} [Remaining: ${this.activeFileSlots}/${this.maxFileSlots}]`);
            this.processQueue();
        } else {
            console.log(`[SlotManager] RELEASE (Ignored - Not Active) - ${key}`);
        }
    }

    processQueue() {
        while (this.activeFileSlots < this.maxFileSlots && this.slotQueue.length > 0) {
            const { taskId, key, grantCallback } = this.slotQueue.shift();
            const slotKey = `${taskId}:${key}`;
            this.activeFileSlots++;
            this.activeSlots.add(slotKey);
            console.log(`[SlotManager] GRANT (From Queue) - ${key} [Active: ${this.activeFileSlots}/${this.maxFileSlots}]`);
            grantCallback();
        }
    }

    clearSlotsForTask(taskId) {
        console.log(`[SlotManager] Clearing all slots for Task: ${taskId}`);
        // 1. Remove pending requests
        this.slotQueue = this.slotQueue.filter(q => q.taskId !== taskId);

        // 2. Clear known active slots
        for (const key of this.activeSlots) {
            if (key.startsWith(`${taskId}:`)) {
                this.activeSlots.delete(key);
                this.activeFileSlots = Math.max(0, this.activeFileSlots - 1);
            }
        }
        this.processQueue();
    }
}

module.exports = SlotManager;
