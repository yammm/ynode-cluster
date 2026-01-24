// ynode/cluster

/*
The MIT License (MIT)

Copyright (c) 2026 Michael Welter <me@mikinho.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

/**
 *  cluster.js: Process Manager or Cluster Orchestrator
 *
 * @module cluster
 *
 * Its sole responsibility is to handle the logic of creating, monitoring,
 * and restarting worker processes.
 */

import cluster from "node:cluster";
import os from "node:os";

/**
 * Manages the application"s clustering.
 * @param {function} startWorker - The function to execute when a worker process starts.
 * @param {object|boolean} options - Configuration object or boolean to enable/disable.
 * @param {boolean} [options.enabled=true] - Whether clustering is enabled.
 * @param {number} [options.minWorkers=2] - Minimum number of workers (smart mode).
 * @param {number} [options.maxWorkers=os.cpus()] - Maximum number of workers.
 * @param {number} [options.scaleUpThreshold=50] - Event loop lag (ms) threshold to scale up.
 * @param {number} [options.scaleDownThreshold=10] - Event loop lag (ms) threshold to scale down.
 * @param {string} [options.mode="smart"] - "smart" (auto-scaling) or "max" (all cores).
 * @param {number} [options.scalingCooldown=10000] - Ms to wait between scaling actions.
 * @param {number} [options.scaleDownGrace=30000] - Ms to wait after scale-up before allowing scale-down.
 * @param {object} log - The logger instance.
 */
export function run(startWorker, options = true, log = console) {
    const isEnabled = typeof options === "object" ? (options.enabled ?? true) : options;

    if (cluster.isWorker || !isEnabled) {
        log.info(`Running worker process.`);
        return startWorker();
    }

    let isShuttingDown = false;

    const {
        minWorkers = Math.min(2, os.availableParallelism()),
        maxWorkers = os.availableParallelism(),
        scaleUpThreshold = 50, // ms lag
        scaleDownThreshold = 10, // ms lag
        mode = "smart", // 'smart' or 'max'
        scalingCooldown = 10000,
        scaleDownGrace = 30000,
        autoScaleInterval = 5000,
        shutdownSignals = ["SIGINT", "SIGTERM", "SIGQUIT"],
        shutdownTimeout = 10000,
    } = typeof options === "object" ? options : {};

    if (minWorkers > maxWorkers) {
        throw new Error(`Invalid configuration: minWorkers (${minWorkers}) cannot be greater than maxWorkers (${maxWorkers})`);
    }

    if (scaleUpThreshold <= scaleDownThreshold) {
        throw new Error(`Invalid configuration: scaleUpThreshold (${scaleUpThreshold}) must be greater than scaleDownThreshold (${scaleDownThreshold})`);
    }

    const initialWorkers = mode === "max" ? maxWorkers : minWorkers;
    log.info(`Shogun is the master! Starting ${initialWorkers} workers (Max: ${maxWorkers}).`);

    let lastScaleUpTime = Date.now();

    // Fork initial workers
    for (let i = 0; i < initialWorkers; ++i) {
        try {
            cluster.fork();
        } catch (err) {
            log.error("Failed to fork initial worker:", err);
        }
        lastScaleUpTime = Date.now();
    }

    const workerLoads = new Map();
    let lastScalingAction = Date.now();

    function broadcastWorkerCount() {
        const count = Object.keys(cluster.workers).length;
        for (const worker of Object.values(cluster.workers)) {
            if (worker && worker.isConnected()) {
                try {
                    worker.send({ cmd: "cluster-count", count });
                } catch (err) {
                    // Ignore channel closed errors
                    log.debug(err);
                }
            }
        }
    }

    cluster.on("online", (worker) => {
        log.info("Worker %o is online", worker.process.pid);
        broadcastWorkerCount();

        workerLoads.set(worker.id, { lag: 0, lastSeen: Date.now() });

        worker.on("message", (msg) => {
            if (msg.cmd === "heartbeat") {
                workerLoads.set(worker.id, {
                    lag: msg.lag,
                    lastSeen: Date.now(),
                    memory: msg.memory
                });
            }
        });
    });

    cluster.on("exit", (worker, code, signal) => {
        workerLoads.delete(worker.id);
        const currentWorkers = Object.keys(cluster.workers).length;

        if (worker.exitedAfterDisconnect) {
            return log.info(`Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] disconnected voluntarily.`);
        }

        if (isShuttingDown) {
            return log.info(`Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] died. Code: ${code}, Signal: ${signal}.`);
        }

        log.warn(`Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] died. Code: ${code}, Signal: ${signal}. Restarting...`);
        try {
            cluster.fork();
        } catch (err) {
            log.error("Failed to restart worker:", err);
        }
        broadcastWorkerCount();
    });

    cluster.on("listening", (worker, address) => {
        const currentWorkers = Object.keys(cluster.workers).length;
        log.info(`A worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] is now connected to ${address.address}:${address.port}`);
        broadcastWorkerCount();
    });

    // Auto-scaling logic
    if (mode === "smart") {
        setInterval(() => {
            const now = Date.now();
            if (now - lastScalingAction < scalingCooldown) {
                return;
            }

            // Calculate average lag across all workers
            let totalLag = 0;
            let count = 0;

            for (const stats of workerLoads.values()) {
                totalLag += stats.lag;
                ++count;
            }

            // Avoid scaling decisions if we have no stats yet
            if (count === 0) {
                return;
            }

            const avgLag = totalLag / count;
            const currentWorkers = Object.keys(cluster.workers).length;

            if (avgLag > scaleUpThreshold && currentWorkers < maxWorkers) {
                log.info(`High load detected (Avg Lag: ${avgLag.toFixed(2)}ms). Scaling up...`);
                try {
                    cluster.fork();
                } catch (err) {
                    log.error("Failed to scale up:", err);
                }
                lastScaleUpTime = Date.now();
                lastScalingAction = now;

                return;
            }

            if (avgLag < scaleDownThreshold && currentWorkers > minWorkers) {
                if (now - lastScaleUpTime < scaleDownGrace) {
                    log.debug("Skipping scale down due to warm-up grace period.");
                    return;
                }

                log.info(`Low load detected (Avg Lag: ${avgLag.toFixed(2)}ms). Scaling down...`);
                // Kill the last worker
                const workerIds = Object.keys(cluster.workers);
                const victimId = workerIds[workerIds.length - 1];
                if (victimId) {
                    cluster.workers[victimId].disconnect();
                    lastScalingAction = now;
                }

                return;
            }
            return;
        }, autoScaleInterval).unref();
    }

    // Graceful shutdown handling for Master
    if (Array.isArray(shutdownSignals) && shutdownSignals.length > 0) {
        shutdownSignals.forEach((signal) => {
            process.on(signal, () => {
                log.info(`Master received ${signal}, shutting down workers...`);
                isShuttingDown = true;
                for (const worker of Object.values(cluster.workers)) {
                    if (worker && worker.isConnected()) {
                        worker.send("shutdown");
                    }
                }

                // Allow some time for workers to clean up
                if (shutdownTimeout > 0) {
                    setTimeout(() => {
                        log.warn(`Master force exiting after ${shutdownTimeout / 1000}s timeout.`);
                        process.exit(0);
                    }, shutdownTimeout).unref();
                }
            });
        });
    }

    // Expose metrics API
    return {
        getMetrics: () => {
            const currentWorkers = Object.keys(cluster.workers).length;
            let totalLag = 0;
            let count = 0;
            const workersData = [];

            for (const [id, stats] of workerLoads.entries()) {
                totalLag += stats.lag;
                count++;

                const worker = cluster.workers[id];
                workersData.push({
                    id,
                    pid: worker?.process.pid,
                    lag: stats.lag,
                    memory: stats.memory,
                    lastSeen: stats.lastSeen,
                    upltime: worker && (Date.now() - stats.lastSeen) // approximate check time diff? No, let's just use lastSeen for now or maybe process uptime if we tracked it.
                });
            }

            const avgLag = count > 0 ? (totalLag / count) : 0;

            return {
                workers: workersData,
                totalLag,
                avgLag,
                workerCount: currentWorkers,
                maxWorkers,
                minWorkers,
                scaleUpThreshold,
                scaleDownThreshold,
                mode
            };
        }
    };
}