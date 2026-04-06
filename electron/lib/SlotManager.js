'use strict';

class SlotManager {
    constructor(maxFileSlots = 3) {
        this.maxFileSlots = maxFileSlots;
        this.activeFileSlots = 0;
        this.slotQueue = []; // Array of { taskId, filename, callback }
    }

    updateLimit(newLimit) {
        this.maxFileSlots = newLimit;
        this.processQueue();
    }

    requestSlot(taskId, filename, grantCallback) {
        if (this.activeFileSlots < this.maxFileSlots) {
            this.activeFileSlots++;
            grantCallback();
        } else {
            console.log(`[SlotManager] Queuing slot request for ${filename} (Total active: ${this.activeFileSlots})`);
            this.slotQueue.push({ taskId, filename, grantCallback });
        }
    }

    releaseSlot(filename) {
        // Only release if the slot was actually granted (activeFileSlots > 0)
        // or prioritize processing the queue anyway
        this.activeFileSlots = Math.max(0, this.activeFileSlots - 1);
        this.processQueue();
    }

    processQueue() {
        while (this.activeFileSlots < this.maxFileSlots && this.slotQueue.length > 0) {
            const { grantCallback } = this.slotQueue.shift();
            this.activeFileSlots++;
            grantCallback();
        }
    }

    clearSlotsForTask(taskId) {
        // If a task is stopped, remove its pending requests from the slot queue
        this.slotQueue = this.slotQueue.filter(q => q.taskId !== taskId);
    }
}

module.exports = SlotManager;
