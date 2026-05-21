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

function normalizeHeartbeatMemory(memory) {
    if (Number.isFinite(memory)) {
        return memory;
    }

    // Workers running an older heartbeat format may still send the full
    // process.memoryUsage() object. Accept it transparently and pull out
    // heapUsed so the master-side scaling math stays consistent.
    if (memory !== null && typeof memory === "object" && Number.isFinite(memory.heapUsed)) {
        return memory.heapUsed;
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
    const { maxWorkers, norestart } = config;

    const getWorkers = () => Object.values(cluster.workers).filter(Boolean);
    const getWorkerCount = () => Object.keys(cluster.workers).length;

    function emitLifecycle(type, payload = {}) {
        events.emit(type, { type, ...payload });
    }

    function forkWorker(context) {
        try {
            return cluster.fork();
        } catch (err) {
            log.error(`Failed to ${context}:`, err);
            return null;
        }
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

    function collectWorkerReplies(cmd, timeoutMs = 3000) {
        const workers = getWorkers();
        if (workers.length === 0) {
            return Promise.resolve([]);
        }

        return new Promise((resolve) => {
            const replies = [];
            const handlers = new Map();
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
            timer.unref();

            for (const worker of workers) {
                const handler = (msg) => {
                    if (!msg || typeof msg !== "object" || msg.cmd !== cmd) {
                        return;
                    }
                    replies.push({ pid: worker.process.pid, id: worker.id, ...msg });
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
                memory,
            });
        };
        state.workerMessageHandlers.set(worker.id, { worker, handler: messageHandler });
        worker.on("message", messageHandler);
    };

    const handleWorkerExit = (worker, code, signal) => {
        const workerStartTime = state.workerStartTimes.get(worker.id);
        state.workerStartTimes.delete(worker.id);
        state.listeningWorkers.delete(worker.id);
        state.workerLoads.delete(worker.id);

        const tracked = state.workerMessageHandlers.get(worker.id);
        if (tracked) {
            tracked.worker.off("message", tracked.handler);
            state.workerMessageHandlers.delete(worker.id);
        }
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

        if (state.isShuttingDown) {
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

            forkWorker("restart worker");
            broadcastWorkerCount();
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
        forkWorker,
        attachWorkerErrorHandler,
        sendToWorker,
        collectWorkerReplies,
        broadcastWorkerCount,
        emitLifecycle,
        attachClusterEvents,
        removeClusterEvents,
    };
}
