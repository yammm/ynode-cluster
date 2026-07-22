// ynode/cluster — worker lifecycle handlers and IPC helpers

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

import cluster from "node:cluster";

const RESTART_BACKOFF_BASE_MS = 100;
const RESTART_BACKOFF_MAX_MS = 5000;
const RESTART_BACKOFF_RESET_UPTIME_MS = 30000;
const RETIRE_TERM_WAIT_MS = 1000;
const RETIRE_KILL_WAIT_MS = 1000;

function normalizeHeartbeatMemory(memory) {
    if (Number.isFinite(memory)) {
        return { heapUsed: memory };
    }

    // Current workers send the full process.memoryUsage() object. Accept it
    // while retaining the numeric heap-only format handled above for workers
    // running an older release during a rolling upgrade.
    if (memory !== null && typeof memory === "object" && Number.isFinite(memory.heapUsed)) {
        return {
            heapUsed: memory.heapUsed,
            rss: Number.isFinite(memory.rss) ? memory.rss : undefined,
            external: Number.isFinite(memory.external) ? memory.external : undefined,
            arrayBuffers: Number.isFinite(memory.arrayBuffers) ? memory.arrayBuffers : undefined,
        };
    }

    return undefined;
}

/**
 * Creates the lifecycle controller — the surface that owns worker creation,
 * worker event-handler wiring, IPC send/recv helpers, and the cluster-wide
 * lifecycle event bus (`worker_online`, `worker_listening`, `worker_exit`,
 * `worker_restart_scheduled`, `shutdown_start`, `shutdown_end`, `reload_start`,
 * `reload_end`, `reload_fail`, `scale_up`, `scale_down`).
 *
 * The controller is stateful — it mutates `state.workerLoads`,
 * `state.workerStartTimes`, `state.workerMessageHandlers`,
 * `state.listeningWorkers`, `state.workersWithErrorHandler`, and
 * `state.consecutiveCrashRestarts`. All other modules observe these via the
 * same shared state object.
 *
 * @param {object} state - Shared cluster state from createState().
 * @returns {object} Lifecycle controller surface.
 */
export function createLifecycle(state) {
    const { config, log, events } = state;
    const { maxWorkers, minWorkers, mode, norestart, maxWorkerMemory, maxWorkerRss } = config;

    const getWorkers = () => Object.values(cluster.workers).filter(Boolean);
    const getWorkerCount = () => getWorkers().length;
    const getActiveWorkers = () =>
        getWorkers().filter((worker) => state.workerStates.get(worker.id) !== "draining");
    const getActiveWorkerCount = () => getActiveWorkers().length;

    function emitLifecycle(type, payload = {}) {
        const event = { type, ...payload };
        for (const listener of events.rawListeners(type)) {
            try {
                const result = listener(event);
                if (result && typeof result.then === "function") {
                    void result.catch((err) => {
                        log.error(`Async cluster lifecycle listener for ${type} failed:`, err);
                    });
                }
            } catch (err) {
                log.error(`Cluster lifecycle listener for ${type} failed:`, err);
            }
        }
    }

    function forkWorker(context, { allowSurge = false, allowDrainingOverlap = false } = {}) {
        const desiredWorkers = state.desiredWorkers > 0 ? state.desiredWorkers : maxWorkers;
        const processLimit = Math.min(maxWorkers, desiredWorkers) + (allowSurge ? 1 : 0);
        const countedWorkers =
            allowSurge || allowDrainingOverlap ? getActiveWorkerCount() : getWorkerCount();
        if (countedWorkers >= processLimit) {
            log.debug(
                `Skipping ${context}: process limit ${processLimit} reached (${countedWorkers} counted, ${getWorkerCount()} running).`,
            );
            return null;
        }

        try {
            const worker = cluster.fork();
            state.workerStates.set(worker.id, "starting");
            return worker;
        } catch (err) {
            log.error(`Failed to ${context}:`, err);
            return null;
        }
    }

    function setDesiredWorkerCount(count) {
        state.desiredWorkers = Math.max(minWorkers, Math.min(maxWorkers, count));
        return state.desiredWorkers;
    }

    function ensureDesiredCapacity(
        context = "reconcile worker capacity",
        { allowSurge = false, allowDrainingOverlap = allowSurge } = {},
    ) {
        if (state.isShuttingDown) {
            return [];
        }

        const workers = [];
        const pendingRestarts = state.pendingRestartTimers?.size ?? 0;
        while (getActiveWorkerCount() + pendingRestarts < state.desiredWorkers) {
            const worker = forkWorker(context, { allowSurge, allowDrainingOverlap });
            if (!worker) {
                break;
            }
            workers.push(worker);
        }
        if (workers.length > 0) {
            broadcastWorkerCount();
        }
        return workers;
    }

    function attachWorkerErrorHandler(worker) {
        if (!worker || state.workersWithErrorHandler.has(worker)) {
            return;
        }

        worker.on("error", (err) => {
            log.debug(`Worker IPC error (${worker.process.pid}):`, err);
        });
        state.workersWithErrorHandler.add(worker);
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

    function waitForWorkerExit(worker, timeoutMs) {
        if (!worker || worker.isDead()) {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            let settled = false;
            const finish = (exited) => {
                if (settled) {
                    return;
                }
                settled = true;
                worker.off("exit", onExit);
                clearTimeout(timeout);
                resolve(exited);
            };
            const onExit = () => finish(true);
            const timeout = setTimeout(() => finish(false), Math.max(0, timeoutMs));
            worker.once("exit", onExit);

            if (worker.isDead()) {
                finish(true);
            }
        });
    }

    function killWorker(worker, signal) {
        if (!worker || worker.isDead()) {
            return;
        }
        try {
            worker.kill(signal);
        } catch (err) {
            log.warn(`Failed to send ${signal} to worker ${worker.process.pid}:`, err);
        }
    }

    async function performWorkerRetirement(
        worker,
        {
            reason = "retire",
            graceMs = config.shutdownTimeout,
            termMs = RETIRE_TERM_WAIT_MS,
            killMs = RETIRE_KILL_WAIT_MS,
        } = {},
    ) {
        if (!worker || worker.isDead()) {
            return { forced: false, phase: "already-exited" };
        }

        attachWorkerErrorHandler(worker);
        state.workerStates.set(worker.id, "draining");
        state.workerRetirements.set(worker.id, { reason, startedAt: Date.now() });
        broadcastWorkerCount();

        if (worker.isConnected()) {
            try {
                worker.send("shutdown", (err) => {
                    if (err) {
                        log.debug(
                            `Failed to send graceful shutdown to worker ${worker.process.pid}:`,
                            err,
                        );
                    }
                });
            } catch (err) {
                log.debug(`Failed to send graceful shutdown to worker ${worker.process.pid}:`, err);
            }
        }

        if (await waitForWorkerExit(worker, graceMs)) {
            return { forced: false, phase: "graceful" };
        }

        log.warn(
            `Worker ${worker.process.pid} did not exit during ${reason} after ${graceMs}ms; sending SIGTERM.`,
        );
        killWorker(worker, "SIGTERM");
        if (await waitForWorkerExit(worker, termMs)) {
            return { forced: true, phase: "term" };
        }

        log.warn(`Worker ${worker.process.pid} ignored SIGTERM during ${reason}; sending SIGKILL.`);
        killWorker(worker, "SIGKILL");
        if (await waitForWorkerExit(worker, killMs)) {
            return { forced: true, phase: "kill" };
        }

        throw new Error(`Worker ${worker.process.pid} did not exit during ${reason}`);
    }

    async function retireWorker(worker, options = {}) {
        if (!worker) {
            return { forced: false, phase: "already-exited" };
        }

        const existing = state.workerRetirementPromises.get(worker.id);
        if (existing) {
            return existing;
        }

        const retirementPromise = performWorkerRetirement(worker, options).finally(() => {
            if (state.workerRetirementPromises.get(worker.id) === retirementPromise) {
                state.workerRetirementPromises.delete(worker.id);
            }
        });
        state.workerRetirementPromises.set(worker.id, retirementPromise);
        return retirementPromise;
    }

    function collectWorkerReplies(cmd, timeoutMs = 3000) {
        const workers = getWorkers();
        if (workers.length === 0) {
            return Promise.resolve([]);
        }

        return new Promise((resolve) => {
            const replies = [];
            const handlers = new Map();
            const repliedWorkerIds = new Set();
            let settled = false;

            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                for (const [worker, handler] of handlers) {
                    worker.off("message", handler);
                }
                resolve(replies);
            };

            const timer = setTimeout(finish, timeoutMs);
            for (const worker of workers) {
                const handler = (msg) => {
                    if (!msg || typeof msg !== "object" || msg.cmd !== cmd) {
                        return;
                    }
                    if (repliedWorkerIds.has(worker.id)) {
                        return;
                    }
                    repliedWorkerIds.add(worker.id);
                    replies.push({ ...msg, pid: worker.process.pid, id: worker.id });
                    if (replies.length === workers.length) {
                        finish();
                    }
                };
                handlers.set(worker, handler);
                worker.on("message", handler);
                sendToWorker(worker, { cmd });
            }
        });
    }

    function broadcastWorkerCount() {
        const count = getActiveWorkerCount();
        for (const worker of getWorkers()) {
            attachWorkerErrorHandler(worker);
            sendToWorker(worker, { cmd: "cluster-count", count, minWorkers, maxWorkers, mode });
        }
    }

    const handleWorkerOnline = (worker) => {
        attachWorkerErrorHandler(worker);
        if (!state.workerRetirements.has(worker.id)) {
            state.workerStates.set(worker.id, "online");
        }
        log.info("Worker %o is online", worker.process.pid);
        broadcastWorkerCount();
        emitLifecycle("worker_online", {
            id: worker.id,
            pid: worker.process.pid,
            workerCount: getWorkerCount(),
        });

        state.workerStartTimes.set(worker.id, Date.now());
        state.workerLoads.set(worker.id, { lag: 0, lastSeen: Date.now() });

        const messageHandler = (msg) => {
            if (!msg || typeof msg !== "object" || msg.cmd !== "heartbeat") {
                return;
            }

            const lag = Number.isFinite(msg.lag) ? msg.lag : 0;
            const memory = normalizeHeartbeatMemory(msg.memory);

            state.workerLoads.set(worker.id, {
                lag,
                lastSeen: Date.now(),
                memory: memory?.heapUsed,
                rss: memory?.rss,
                external: memory?.external,
                arrayBuffers: memory?.arrayBuffers,
            });

            if (state.workerStates.get(worker.id) === "draining" || !memory) {
                return;
            }

            // Preserve cluster availability when several workers cross the
            // same hard limit together. The next offender will be evaluated
            // on a later heartbeat after the in-flight retirement settles.
            if (state.workerRetirementPromises.size > 0) {
                return;
            }

            const heapMB = memory.heapUsed / 1024 / 1024;
            const rssMB = typeof memory.rss === "number" ? memory.rss / 1024 / 1024 : 0;
            const heapExceeded = maxWorkerMemory > 0 && heapMB > maxWorkerMemory;
            const rssExceeded = maxWorkerRss > 0 && rssMB > maxWorkerRss;
            if (!heapExceeded && !rssExceeded) {
                return;
            }

            const reason = rssExceeded
                ? `RSS ${rssMB.toFixed(2)}MB > ${maxWorkerRss}MB`
                : `heap ${heapMB.toFixed(2)}MB > ${maxWorkerMemory}MB`;
            log.warn(`Worker ${worker.id} exceeded memory limit (${reason}). Restarting...`);
            void retireWorker(worker, { reason: "memory limit", graceMs: 0 }).catch((err) => {
                log.error(`Failed to retire worker ${worker.id} after memory limit:`, err);
            });
        };
        state.workerMessageHandlers.set(worker.id, { worker, handler: messageHandler });
        worker.on("message", messageHandler);
    };

    const handleWorkerExit = (worker, code, signal) => {
        const workerStartTime = state.workerStartTimes.get(worker.id);
        const retirement = state.workerRetirements.get(worker.id);
        state.workerStartTimes.delete(worker.id);
        state.listeningWorkers.delete(worker.id);
        state.workerLoads.delete(worker.id);
        state.workerStates.delete(worker.id);
        state.workerRetirements.delete(worker.id);

        const tracked = state.workerMessageHandlers.get(worker.id);
        if (tracked) {
            tracked.worker.off("message", tracked.handler);
            state.workerMessageHandlers.delete(worker.id);
        }
        const currentWorkers = getActiveWorkerCount();
        emitLifecycle("worker_exit", {
            id: worker.id,
            pid: worker.process.pid,
            code,
            signal,
            workerCount: currentWorkers,
        });

        if (state.isShuttingDown) {
            return log.info(
                `Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] exited during cluster shutdown. Code: ${code}, Signal: ${signal}.`,
            );
        }

        if (retirement || worker.exitedAfterDisconnect) {
            if (!retirement && mode === "smart") {
                setDesiredWorkerCount(Math.max(minWorkers, currentWorkers));
            }

            log.info(
                `Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] disconnected voluntarily.`,
            );
            if (!norestart) {
                ensureDesiredCapacity("restore desired capacity after worker retirement");
            }
            broadcastWorkerCount();
            return;
        }

        if (norestart) {
            return log.warn(
                `Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] died. Code: ${code}, Signal: ${signal}. Not restarting (norestart enabled).`,
            );
        }

        if (currentWorkers >= state.desiredWorkers) {
            log.warn(
                `Worker [${worker.process.pid}: ${currentWorkers} of ${maxWorkers}] died. Code: ${code}, Signal: ${signal}. Desired capacity is already satisfied.`,
            );
            return;
        }

        const workerUptimeMs = workerStartTime ? Date.now() - workerStartTime : 0;
        if (workerUptimeMs >= RESTART_BACKOFF_RESET_UPTIME_MS) {
            state.consecutiveCrashRestarts = 0;
        }

        ++state.consecutiveCrashRestarts;
        const backoffExponent = Math.min(Math.max(0, state.consecutiveCrashRestarts - 1), 16);
        const restartDelay = Math.min(
            RESTART_BACKOFF_BASE_MS * 2 ** backoffExponent,
            RESTART_BACKOFF_MAX_MS,
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
            state.pendingRestartTimers.delete(restartTimer);
            if (state.isShuttingDown) {
                return;
            }

            ensureDesiredCapacity("restart worker");
        }, restartDelay);

        state.pendingRestartTimers.add(restartTimer);

        // Keep the process alive if all workers are down so the delayed
        // restart can fire. When other workers exist they keep the loop
        // alive on their own, so we can unref this restart timer; this
        // also prevents the timer from blocking master shutdown for up
        // to restartDelay ms when shutdown is signaled immediately
        // after a worker death. Either way, shutdown.beforeShutdown
        // clears any still-pending restart timers explicitly so the
        // master event loop drains promptly.
        if (currentWorkers > 0) {
            restartTimer.unref();
        }
    };

    const handleWorkerListening = (worker, address) => {
        state.listeningWorkers.add(worker.id);
        if (!state.workerRetirements.has(worker.id)) {
            state.workerStates.set(worker.id, "listening");
        }
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

    function attachClusterEvents() {
        cluster.on("online", handleWorkerOnline);
        cluster.on("exit", handleWorkerExit);
        cluster.on("listening", handleWorkerListening);
    }

    function removeClusterEvents() {
        cluster.off("online", handleWorkerOnline);
        cluster.off("exit", handleWorkerExit);
        cluster.off("listening", handleWorkerListening);
    }

    return {
        getWorkers,
        getWorkerCount,
        getActiveWorkers,
        getActiveWorkerCount,
        forkWorker,
        setDesiredWorkerCount,
        ensureDesiredCapacity,
        retireWorker,
        attachWorkerErrorHandler,
        sendToWorker,
        collectWorkerReplies,
        broadcastWorkerCount,
        emitLifecycle,
        attachClusterEvents,
        removeClusterEvents,
    };
}
