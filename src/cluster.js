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
 * Its sole responsibility is to handle the logic of creating, monitoring,
 * and restarting worker processes.
 *
 * @module cluster
 */

import cluster from "node:cluster";
import { EventEmitter } from "node:events";
import os from "node:os";

const HEARTBEAT_INTERVAL_MS = 2000;
const VALID_MODES = new Set(["smart", "max"]);

function isOptionsObject(options) {
    return options !== null && typeof options === "object" && !Array.isArray(options);
}

function resolveClusteringEnabled(options) {
    if (isOptionsObject(options)) {
        return options.enabled ?? true;
    }

    if (typeof options === "boolean") {
        return options;
    }

    return true;
}

function buildClusterConfig(options) {
    const cpuCount = os.availableParallelism();
    const rawOptions = isOptionsObject(options) ? options : {};

    return {
        minWorkers: Math.min(2, cpuCount),
        maxWorkers: cpuCount,
        scaleUpThreshold: 50,
        scaleDownThreshold: 10,
        mode: "smart",
        scalingCooldown: 10000,
        scaleDownGrace: 30000,
        autoScaleInterval: 5000,
        shutdownSignals: ["SIGINT", "SIGTERM", "SIGQUIT"],
        shutdownTimeout: 10000,
        scaleUpMemory: 0,
        maxWorkerMemory: 0,
        norestart: false,
        reloadOnlineTimeout: 10000,
        reloadListeningTimeout: 10000,
        reloadDisconnectWait: 2000,
        ...rawOptions,
    };
}

function validateClusterConfig(config) {
    if (config.minWorkers > config.maxWorkers) {
        throw new Error(
            `Invalid configuration: minWorkers (${config.minWorkers}) cannot be greater than maxWorkers (${config.maxWorkers})`,
        );
    }

    if (!VALID_MODES.has(config.mode)) {
        throw new Error(
            `Invalid configuration: mode (${config.mode}) must be either "smart" or "max"`,
        );
    }

    if (config.scaleUpThreshold <= config.scaleDownThreshold) {
        throw new Error(
            `Invalid configuration: scaleUpThreshold (${config.scaleUpThreshold}) must be greater than scaleDownThreshold (${config.scaleDownThreshold})`,
        );
    }

    if (config.reloadOnlineTimeout <= 0) {
        throw new Error(
            `Invalid configuration: reloadOnlineTimeout (${config.reloadOnlineTimeout}) must be greater than 0`,
        );
    }

    if (config.reloadListeningTimeout <= 0) {
        throw new Error(
            `Invalid configuration: reloadListeningTimeout (${config.reloadListeningTimeout}) must be greater than 0`,
        );
    }

    if (config.reloadDisconnectWait <= 0) {
        throw new Error(
            `Invalid configuration: reloadDisconnectWait (${config.reloadDisconnectWait}) must be greater than 0`,
        );
    }
}

/**
 * Manages the application"s clustering.
 * @param {function} startWorker - The function to execute when a worker process starts.
 * @param {object|boolean} options - Configuration object or boolean to enable/disable.
 * @param {boolean} [options.enabled=true] - Whether clustering is enabled.
 * @param {number} [options.minWorkers=Math.min(2, os.availableParallelism())] - Minimum number of workers (smart mode).
 * @param {number} [options.maxWorkers=os.availableParallelism()] - Maximum number of workers.
 * @param {number} [options.scaleUpThreshold=50] - Event loop lag (ms) threshold to scale up.
 * @param {number} [options.scaleDownThreshold=10] - Event loop lag (ms) threshold to scale down.
 * @param {string} [options.mode="smart"] - "smart" (auto-scaling) or "max" (all cores).
 * @param {number} [options.scalingCooldown=10000] - Ms to wait between scaling actions.
 * @param {number} [options.scaleDownGrace=30000] - Ms to wait after scale-up before allowing scale-down.
 * @param {number} [options.reloadOnlineTimeout=10000] - Max ms to wait for replacement worker "online" during reload.
 * @param {number} [options.reloadListeningTimeout=10000] - Max ms to wait for replacement worker "listening" during reload.
 * @param {number} [options.reloadDisconnectWait=2000] - Max ms to wait for old worker disconnect during each reload step.
 * @param {object} log - The logger instance.
 */
export function run(startWorker, options = true, log = console) {
    const isEnabled = resolveClusteringEnabled(options);
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
                const lag = now - lastCheck - HEARTBEAT_INTERVAL_MS;
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
            }, HEARTBEAT_INTERVAL_MS).unref();
        }

        return startWorker();
    }

    const config = buildClusterConfig(options);
    validateClusterConfig(config);

    const {
        minWorkers,
        maxWorkers,
        scaleUpThreshold, // ms lag
        scaleDownThreshold, // ms lag
        mode, // 'smart' or 'max'
        scalingCooldown,
        scaleDownGrace,
        autoScaleInterval,
        shutdownSignals,
        shutdownTimeout,
        scaleUpMemory, // MB (0 = disabled)
        maxWorkerMemory, // MB (0 = disabled)
        norestart,
        reloadOnlineTimeout,
        reloadListeningTimeout,
        reloadDisconnectWait,
    } = config;

    const initialWorkers = mode === "max" ? maxWorkers : minWorkers;
    log.info(`Shogun is the master! Starting ${initialWorkers} workers (Max: ${maxWorkers}).`);

    let lastScaleUpTime = Date.now();

    // Fork initial workers
    for (let i = 0; i < initialWorkers; ++i) {
        forkWorker("fork initial worker");
        lastScaleUpTime = Date.now();
    }

    const workerLoads = new Map();
    const workerStartTimes = new Map();
    const listeningWorkers = new Set();
    const workersWithErrorHandler = new WeakSet();
    let lastScalingAction = Date.now();
    let consecutiveCrashRestarts = 0;

    const restartBackoffBaseMs = 100;
    const restartBackoffMaxMs = 5000;
    const restartBackoffResetUptimeMs = 30000;

    const getWorkers = () => Object.values(cluster.workers).filter(Boolean);
    const getWorkerCount = () => Object.keys(cluster.workers).length;

    function forkWorker(context) {
        try {
            return cluster.fork();
        } catch (err) {
            log.error(`Failed to ${context}:`, err);
            return null;
        }
    }

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

    function waitForWorkerListening(worker, timeoutMs = reloadListeningTimeout) {
        if (!worker) {
            return Promise.reject(new Error("Cannot wait for listening: missing worker"));
        }
        if (listeningWorkers.has(worker.id)) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(
                    new Error(
                        `Replacement worker ${worker.process.pid} did not become listening within ${timeoutMs}ms`,
                    ),
                );
            }, timeoutMs);
            timeout.unref();

            const cleanup = () => {
                cluster.off("listening", onListening);
                clearTimeout(timeout);
            };

            const onListening = (listeningWorker) => {
                if (!settled && listeningWorker?.id === worker.id) {
                    settled = true;
                    cleanup();
                    resolve();
                }
            };

            cluster.on("listening", onListening);
        });
    }

    function waitForWorkerOnline(worker, timeoutMs = reloadOnlineTimeout) {
        if (!worker) {
            return Promise.reject(new Error("Cannot wait for online: missing worker"));
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(
                    new Error(
                        `Replacement worker ${worker.process.pid} did not become online within ${timeoutMs}ms`,
                    ),
                );
            }, timeoutMs);
            timeout.unref();

            const cleanup = () => {
                worker.off("online", onOnline);
                worker.off("disconnect", onDisconnect);
                worker.off("exit", onExit);
                clearTimeout(timeout);
            };

            const onOnline = () => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    resolve();
                }
            };

            const onDisconnect = () => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(
                        new Error(
                            `Replacement worker ${worker.process.pid} disconnected before becoming online`,
                        ),
                    );
                }
            };

            const onExit = (code, signal) => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(
                        new Error(
                            `Replacement worker ${worker.process.pid} exited before becoming online (code=${code}, signal=${signal})`,
                        ),
                    );
                }
            };

            worker.on("online", onOnline);
            worker.on("disconnect", onDisconnect);
            worker.on("exit", onExit);
        });
    }

    const managerEvents = new EventEmitter();
    const emitLifecycle = (type, payload = {}) => {
        managerEvents.emit(type, { type, ...payload });
    };

    function broadcastWorkerCount() {
        const count = getWorkerCount();
        for (const worker of getWorkers()) {
            attachWorkerErrorHandler(worker);
            sendToWorker(worker, { cmd: "cluster-count", count });
        }
    }

    const handleWorkerOnline = (worker) => {
        attachWorkerErrorHandler(worker);
        log.info("Worker %o is online", worker.process.pid);
        broadcastWorkerCount();
        emitLifecycle("worker_online", {
            id: worker.id,
            pid: worker.process.pid,
            workerCount: getWorkerCount(),
        });

        workerStartTimes.set(worker.id, Date.now());
        workerLoads.set(worker.id, { lag: 0, lastSeen: Date.now() });

        worker.on("message", (msg) => {
            if (!msg || typeof msg !== "object" || msg.cmd !== "heartbeat") {
                return;
            }

            const lag = Number.isFinite(msg.lag) ? msg.lag : 0;
            const memory = typeof msg.memory === "number" ? msg.memory : undefined;

            workerLoads.set(worker.id, {
                lag,
                lastSeen: Date.now(),
                memory,
            });
        });
    };

    const handleWorkerExit = (worker, code, signal) => {
        const workerStartTime = workerStartTimes.get(worker.id);
        workerStartTimes.delete(worker.id);
        listeningWorkers.delete(worker.id);
        workerLoads.delete(worker.id);
        const currentWorkers = getWorkerCount();
        emitLifecycle("worker_exit", {
            id: worker.id,
            pid: worker.process.pid,
            code,
            signal,
            workerCount: currentWorkers,
        });

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
        emitLifecycle("worker_restart_scheduled", {
            id: worker.id,
            pid: worker.process.pid,
            delayMs: restartDelay,
            workerCount: currentWorkers,
        });

        log.warn(
            `Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] died. Code: ${code}, Signal: ${signal}. Restarting in ${restartDelay}ms...`,
        );
        const restartTimer = setTimeout(() => {
            if (isShuttingDown) {
                return;
            }

            forkWorker("restart worker");
            broadcastWorkerCount();
        }, restartDelay);

        // Keep the process alive if all workers are down so delayed restart can happen.
        if (currentWorkers > 0) {
            restartTimer.unref();
        }
    };

    const handleWorkerListening = (worker, address) => {
        listeningWorkers.add(worker.id);
        const currentWorkers = getWorkerCount();
        log.info(
            `A worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] is now connected to ${address.address}:${address.port}`,
        );
        broadcastWorkerCount();
        emitLifecycle("worker_listening", {
            id: worker.id,
            pid: worker.process.pid,
            address: address.address,
            port: address.port,
            workerCount: currentWorkers,
        });
    };

    cluster.on("online", handleWorkerOnline);
    cluster.on("exit", handleWorkerExit);
    cluster.on("listening", handleWorkerListening);

    let autoScaleTimer;
    let forceExitTimer;
    let closePromise;
    let reloadPromise;
    const signalHandlers = new Map();

    function removeSignalHandlers() {
        for (const [signal, handler] of signalHandlers.entries()) {
            process.off(signal, handler);
        }
        signalHandlers.clear();
    }

    function removeClusterHandlers() {
        cluster.off("online", handleWorkerOnline);
        cluster.off("exit", handleWorkerExit);
        cluster.off("listening", handleWorkerListening);
    }

    function disconnectWorkersForShutdown() {
        function disconnectWorker(worker) {
            try {
                worker.disconnect();
            } catch (err) {
                log.debug(`Failed to disconnect worker ${worker.process.pid}:`, err);
            }
        }

        for (const worker of getWorkers()) {
            attachWorkerErrorHandler(worker);
            if (!worker.isConnected()) {
                disconnectWorker(worker);
                continue;
            }

            let disconnected = false;
            const disconnectOnce = () => {
                if (disconnected) {
                    return;
                }
                disconnected = true;
                disconnectWorker(worker);
            };

            const fallbackTimer = setTimeout(disconnectOnce, 50);
            fallbackTimer.unref();

            try {
                worker.send("shutdown", (err) => {
                    if (err) {
                        log.debug(
                            `Failed to send shutdown message to worker ${worker.process.pid}:`,
                            err,
                        );
                    }
                    clearTimeout(fallbackTimer);
                    disconnectOnce();
                });
            } catch (err) {
                clearTimeout(fallbackTimer);
                log.debug(`Failed to send shutdown message to worker ${worker.process.pid}:`, err);
                disconnectOnce();
            }
        }
    }

    function closeCluster({ signal = null, exitOnTimeout = false, exitOnComplete = false } = {}) {
        if (closePromise) {
            return closePromise;
        }

        isShuttingDown = true;
        emitLifecycle("shutdown_start", { signal, workerCount: getWorkerCount() });
        if (autoScaleTimer) {
            clearInterval(autoScaleTimer);
            autoScaleTimer = undefined;
        }

        closePromise = new Promise((resolve) => {
            let settled = false;

            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                cluster.off("exit", onWorkerExitForClose);
                if (forceExitTimer) {
                    clearTimeout(forceExitTimer);
                    forceExitTimer = undefined;
                }
                removeSignalHandlers();
                removeClusterHandlers();
                emitLifecycle("shutdown_end", { workerCount: getWorkerCount() });
                if (exitOnComplete) {
                    process.exit(0);
                    return;
                }
                resolve();
            };

            const onWorkerExitForClose = () => {
                if (getWorkerCount() === 0) {
                    finish();
                }
            };

            cluster.on("exit", onWorkerExitForClose);
            disconnectWorkersForShutdown();
            onWorkerExitForClose();

            if (!settled && shutdownTimeout > 0) {
                forceExitTimer = setTimeout(() => {
                    if (settled) {
                        return;
                    }
                    if (exitOnTimeout) {
                        log.warn(`Master force exiting after ${shutdownTimeout / 1000}s timeout.`);
                        process.exit(0);
                        return;
                    }
                    finish();
                }, shutdownTimeout);
                forceExitTimer.unref();
            }
        });

        return closePromise;
    }

    // Auto-scaling logic
    if (mode === "smart") {
        autoScaleTimer = setInterval(() => {
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
            let memorySamples = 0;
            for (const stats of workerLoads.values()) {
                if (typeof stats.memory === "number") {
                    totalMemory += stats.memory;
                    memorySamples += 1;
                }
            }
            const avgMemoryMB = memorySamples > 0 ? totalMemory / memorySamples / 1024 / 1024 : 0;

            const currentWorkers = getWorkerCount();

            // Leak Protection (Max Worker Memory)
            if (maxWorkerMemory > 0) {
                for (const [id, stats] of workerLoads.entries()) {
                    if (typeof stats.memory !== "number") {
                        continue;
                    }
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
                const scaledWorker = forkWorker("scale up");
                if (scaledWorker) {
                    emitLifecycle("scale_up", { reason, workerCount: currentWorkers + 1 });
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
                // Disconnect the latest worker in the current snapshot.
                const workers = getWorkers();
                const victim = workers[workers.length - 1];
                if (victim) {
                    victim.disconnect();
                    emitLifecycle("scale_down", {
                        workerId: victim.id,
                        workerPid: victim.process.pid,
                        workerCount: currentWorkers - 1,
                    });
                    lastScalingAction = now;
                }

                return;
            }
            return;
        }, autoScaleInterval);
        autoScaleTimer.unref();
    }

    // Graceful shutdown handling for Master
    if (Array.isArray(shutdownSignals) && shutdownSignals.length > 0) {
        shutdownSignals.forEach((signal) => {
            if (signalHandlers.has(signal)) {
                return;
            }
            const handler = () => {
                log.info(`Master received ${signal}, shutting down workers...`);
                closeCluster({ signal, exitOnTimeout: true, exitOnComplete: true });
            };
            signalHandlers.set(signal, handler);
            process.on(signal, handler);
        });
    }

    const manager = {
        getMetrics: () => {
            const currentWorkers = getWorkerCount();
            let totalLag = 0;
            let count = 0;
            const workersData = [];

            for (const [id, stats] of workerLoads.entries()) {
                totalLag += stats.lag;
                count++;

                const worker = cluster.workers[id];
                const workerStartTime = workerStartTimes.get(id);
                workersData.push({
                    id,
                    pid: worker?.process.pid,
                    lag: stats.lag,
                    memory: stats.memory,
                    lastSeen: stats.lastSeen,
                    uptime: workerStartTime ? Date.now() - workerStartTime : undefined,
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
            if (reloadPromise) {
                return reloadPromise;
            }

            reloadPromise = (async () => {
                log.info("Starting zero-downtime cluster reload...");
                emitLifecycle("reload_start", { workerCount: getWorkerCount() });

                // Get a snapshot of current workers to replace
                const workersToReplace = getWorkers();

                for (const oldWorker of workersToReplace) {
                    if (isShuttingDown) {
                        throw new Error("Reload aborted: cluster is shutting down");
                    }

                    // Fork a new worker
                    log.info("Spawning replacement worker...");
                    const newWorker = forkWorker("spawn replacement worker");
                    if (!newWorker) {
                        throw new Error("Reload aborted: failed to spawn replacement worker");
                    }
                    attachWorkerErrorHandler(newWorker);

                    // Wait for the new worker to be online
                    try {
                        await waitForWorkerOnline(newWorker);
                    } catch (err) {
                        log.error(
                            `Reload aborted: replacement worker ${newWorker.process.pid} failed to come online.`,
                            err,
                        );
                        if (newWorker.isConnected()) {
                            newWorker.disconnect();
                        }
                        throw err;
                    }

                    const shouldWaitForListening = listeningWorkers.has(oldWorker.id);
                    if (shouldWaitForListening) {
                        try {
                            await waitForWorkerListening(newWorker);
                        } catch (err) {
                            log.error(
                                `Reload aborted: replacement worker ${newWorker.process.pid} failed readiness check.`,
                                err,
                            );
                            if (newWorker.isConnected()) {
                                newWorker.disconnect();
                            }
                            throw err;
                        }
                        log.info(
                            `Replacement worker ${newWorker.process.pid} is listening. Gracefully shutting down old worker ${oldWorker.process.pid}...`,
                        );
                    } else {
                        log.info(
                            `Replacement worker ${newWorker.process.pid} is online. Gracefully shutting down old worker ${oldWorker.process.pid}...`,
                        );
                    }

                    // Gracefully disconnect the old worker
                    oldWorker.disconnect();

                    // Wait for disconnect confirmation or short timeout to proceed to next
                    const disconnectPromise = new Promise((resolve) =>
                        oldWorker.once("disconnect", resolve),
                    );
                    const timeoutPromise = new Promise((resolve) =>
                        setTimeout(resolve, reloadDisconnectWait).unref(),
                    );
                    await Promise.race([disconnectPromise, timeoutPromise]);
                }
                log.info("Cluster reload complete.");
                emitLifecycle("reload_end", { workerCount: getWorkerCount() });
            })()
                .catch((err) => {
                    emitLifecycle("reload_fail", {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    throw err;
                })
                .finally(() => {
                    reloadPromise = undefined;
                });

            return reloadPromise;
        },
        close: async () => closeCluster(),
        on: (eventName, listener) => {
            managerEvents.on(eventName, listener);
            return manager;
        },
        once: (eventName, listener) => {
            managerEvents.once(eventName, listener);
            return manager;
        },
        off: (eventName, listener) => {
            managerEvents.off(eventName, listener);
            return manager;
        },
    };

    return manager;
}
