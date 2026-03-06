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
    let isShuttingDown = false;

    if (cluster.isWorker || !isEnabled) {
        log.info(`Running worker process.`);

        // Start heartbeat loop if enabled (and we are clustering)
        if (cluster.isWorker) {
            const worker = cluster.worker;
            let lastCheck = Date.now();

            const interval = setInterval(() => {
                if (isShuttingDown || !worker.isConnected()) {
                    return clearInterval(interval);
                }

                const now = Date.now();

                // Approximate event loop lag
                const lag = now - lastCheck - 2000;
                lastCheck = now;

                const memory = process.memoryUsage();

                try {
                    worker.send({
                        cmd: "heartbeat",
                        lag: Math.max(0, lag),
                        memory: memory.heapUsed, // Use heapUsed for primary scaling/monitoring
                    });
                } catch (err) {
                    // Ignore, channel probably closed
                    log.debug("Failed to send heartbeat to master", err);
                }
            }, 2000).unref();
        }

        return startWorker();
    }

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
        scaleUpMemory = 0, // MB (0 = disabled)
        maxWorkerMemory = 0, // MB (0 = disabled)
        norestart = false,
    } = typeof options === "object" ? options : {};

    if (minWorkers > maxWorkers) {
        throw new Error(
            `Invalid configuration: minWorkers (${minWorkers}) cannot be greater than maxWorkers (${maxWorkers})`,
        );
    }

    if (scaleUpThreshold <= scaleDownThreshold) {
        throw new Error(
            `Invalid configuration: scaleUpThreshold (${scaleUpThreshold}) must be greater than scaleDownThreshold (${scaleDownThreshold})`,
        );
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
    const workerStartTimes = new Map();
    const workersWithErrorHandler = new WeakSet();
    let lastScalingAction = Date.now();
    let consecutiveCrashRestarts = 0;

    const restartBackoffBaseMs = 100;
    const restartBackoffMaxMs = 5000;
    const restartBackoffResetUptimeMs = 30000;

    function attachWorkerErrorHandler(worker) {
        if (!worker || workersWithErrorHandler.has(worker)) {
            return;
        }

        worker.on("error", (err) => {
            log.debug(`Worker IPC error (${worker.process.pid}):`, err);
        });
        workersWithErrorHandler.add(worker);
    }

    function sendToWorker(worker, payload) {
        if (!worker || !worker.isConnected()) {
            return;
        }
        if (typeof worker.isDead === "function" && worker.isDead()) {
            return;
        }

        try {
            worker.send(payload, (err) => {
                if (err) {
                    log.debug(`Failed to send IPC message to worker ${worker.process.pid}:`, err);
                }
            });
        } catch (err) {
            log.debug(`Failed to send IPC message to worker ${worker.process.pid}:`, err);
        }
    }

    function broadcastWorkerCount() {
        const count = Object.keys(cluster.workers).length;
        for (const worker of Object.values(cluster.workers)) {
            attachWorkerErrorHandler(worker);
            sendToWorker(worker, { cmd: "cluster-count", count });
        }
    }

    cluster.on("online", (worker) => {
        attachWorkerErrorHandler(worker);
        log.info("Worker %o is online", worker.process.pid);
        broadcastWorkerCount();

        workerStartTimes.set(worker.id, Date.now());
        workerLoads.set(worker.id, { lag: 0, lastSeen: Date.now() });

        worker.on("message", (msg) => {
            if (msg.cmd === "heartbeat") {
                // console.log(`[Master] Heartbeat from ${worker.id}: ${msg.memory} bytes`);
                workerLoads.set(worker.id, {
                    lag: msg.lag,
                    lastSeen: Date.now(),
                    memory: msg.memory,
                });
            }
        });
    });

    cluster.on("exit", (worker, code, signal) => {
        const workerStartTime = workerStartTimes.get(worker.id);
        workerStartTimes.delete(worker.id);
        workerLoads.delete(worker.id);
        const currentWorkers = Object.keys(cluster.workers).length;

        if (worker.exitedAfterDisconnect) {
            return log.info(
                `Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] disconnected voluntarily.`,
            );
        }

        if (isShuttingDown) {
            return log.info(
                `Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] died. Code: ${code}, Signal: ${signal}.`,
            );
        }

        if (norestart) {
            return log.warn(
                `Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] died. Code: ${code}, Signal: ${signal}. Not restarting (norestart enabled).`,
            );
        }

        const workerUptimeMs = workerStartTime ? Date.now() - workerStartTime : 0;
        if (workerUptimeMs >= restartBackoffResetUptimeMs) {
            consecutiveCrashRestarts = 0;
        }

        consecutiveCrashRestarts += 1;
        const backoffExponent = Math.min(Math.max(0, consecutiveCrashRestarts - 1), 16);
        const restartDelay = Math.min(
            restartBackoffBaseMs * 2 ** backoffExponent,
            restartBackoffMaxMs,
        );

        log.warn(
            `Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] died. Code: ${code}, Signal: ${signal}. Restarting in ${restartDelay}ms...`,
        );
        const restartTimer = setTimeout(() => {
            if (isShuttingDown) {
                return;
            }

            try {
                cluster.fork();
            } catch (err) {
                log.error("Failed to restart worker:", err);
            }
            broadcastWorkerCount();
        }, restartDelay);

        // Keep the process alive if all workers are down so delayed restart can happen.
        if (currentWorkers > 0) {
            restartTimer.unref();
        }
    });

    cluster.on("listening", (worker, address) => {
        const currentWorkers = Object.keys(cluster.workers).length;
        log.info(
            `A worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] is now connected to ${address.address}:${address.port}`,
        );
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
            // Calculate Average Memory in MB
            let totalMemory = 0; // Bytes
            for (const stats of workerLoads.values()) {
                if (stats.memory) {
                    totalMemory += stats.memory;
                }
            }
            const avgMemoryMB = count > 0 ? totalMemory / count / 1024 / 1024 : 0;

            const currentWorkers = Object.keys(cluster.workers).length;

            // Leak Protection (Max Worker Memory)
            if (maxWorkerMemory > 0) {
                for (const [id, stats] of workerLoads.entries()) {
                    const memMB = stats.memory / 1024 / 1024;
                    // console.log(`[Master] Checking Worker ${id} Memory: ${memMB.toFixed(2)}MB (Limit: ${maxWorkerMemory}MB)`);
                    if (memMB > maxWorkerMemory) {
                        log.warn(
                            `Worker ${id} exceeded memory limit (${memMB.toFixed(2)}MB > ${maxWorkerMemory}MB). Restarting...`,
                        );
                        const worker = cluster.workers[id];
                        if (worker) {
                            worker.kill();
                        }
                        // Exit handler will restart it
                        return; // Wait for restart
                    }
                }
            }

            // Scale Up logic (Lag OR Memory)
            const shouldScaleUpLag = avgLag > scaleUpThreshold;
            const shouldScaleUpMem = scaleUpMemory > 0 && avgMemoryMB > scaleUpMemory;

            if ((shouldScaleUpLag || shouldScaleUpMem) && currentWorkers < maxWorkers) {
                const reason = shouldScaleUpMem
                    ? `High Memory (Avg: ${avgMemoryMB.toFixed(2)}MB)`
                    : `High Lag (Avg: ${avgLag.toFixed(2)}ms)`;

                log.info(`${reason} detected. Scaling up...`);
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
                        attachWorkerErrorHandler(worker);
                        sendToWorker(worker, "shutdown");
                        worker.disconnect();
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
                    uptime: worker && Date.now() - stats.lastSeen,
                });
            }

            const avgLag = count > 0 ? totalLag / count : 0;

            return {
                workers: workersData,
                totalLag,
                avgLag,
                workerCount: currentWorkers,
                maxWorkers,
                minWorkers,
                scaleUpThreshold,
                scaleDownThreshold,
                mode,
            };
        },
        reload: async () => {
            if (isShuttingDown) {
                return;
            }
            log.info("Starting zero-downtime cluster reload...");

            // Get a snapshot of current workers to replace
            const currentWorkers = Object.values(cluster.workers);

            for (const oldWorker of currentWorkers) {
                if (!oldWorker) {
                    continue;
                }

                // Fork a new worker
                log.info("Spawning replacement worker...");
                const newWorker = cluster.fork();

                // Wait for the new worker to be online
                await new Promise((resolve) => {
                    newWorker.once("online", resolve);
                });

                // Wait for the new worker to be listening (optional, but safer for zero-downtime)
                // However, not all workers listen. strict zero-downtime usually implies listening.
                // We'll stick to 'online' for generic support in v1,
                // but maybe add a small delay or check?
                // For now, 'online' means the process is up and running.

                log.info(
                    `Replacement worker ${newWorker.process.pid} is online. Gracefully shutting down old worker ${oldWorker.process.pid}...`,
                );

                // Gracefully disconnect the old worker
                oldWorker.disconnect();

                // We don't strictly wait for the old worker to die here to speed up deployment,
                // but it handles its own shutdown.
                // If we wanted strict serial replacement (one dies, then next starts), we'd wait.
                // But typically we want overlap.

                // Wait for disconnect confirmation or short timeout to proceed to next
                const disconnectPromise = new Promise((resolve) =>
                    oldWorker.once("disconnect", resolve),
                );
                const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 2000).unref());
                await Promise.race([disconnectPromise, timeoutPromise]);
            }
            log.info("Cluster reload complete.");
        },
    };
}
