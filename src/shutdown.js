// ynode/cluster — graceful shutdown and signal handling

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

/**
 * Creates the shutdown controller — orchestrates graceful disconnect of
 * the worker pool and master event-loop teardown.
 *
 * `closeCluster()` is idempotent; concurrent calls return the in-flight
 * shutdown promise. Signal handlers registered by `attachSignalHandlers()`
 * call `closeCluster({ signal, exitOnTimeout: true, exitOnComplete: true })`
 * so the master process exits cleanly even if a worker hangs past
 * `shutdownTimeout`.
 *
 * @param {object} state - Shared cluster state.
 * @param {object} lifecycle - Lifecycle controller.
 * @param {object} [hooks] - Shutdown callbacks.
 * @param {function(): void} [hooks.beforeShutdown] - Invoked synchronously
 *   at the start of closeCluster (used by tty to drop into closing mode
 *   and by scaling to stop the auto-scale interval).
 * @returns {object} Shutdown controller surface.
 */
export function createShutdown(state, lifecycle, hooks = {}) {
    const { config, log } = state;
    const { shutdownSignals, shutdownTimeout } = config;

    function disconnectWorkersForShutdown() {
        function disconnectWorker(worker) {
            try {
                worker.disconnect();
            } catch (err) {
                log.debug(`Failed to disconnect worker ${worker.process.pid}:`, err);
            }
        }

        for (const worker of lifecycle.getWorkers()) {
            lifecycle.attachWorkerErrorHandler(worker);
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
                        disconnectOnce();
                    }
                    clearTimeout(fallbackTimer);
                });
            } catch (err) {
                clearTimeout(fallbackTimer);
                log.debug(`Failed to send shutdown message to worker ${worker.process.pid}:`, err);
                disconnectOnce();
            }
        }
    }

    function closeCluster({ signal = null, exitOnTimeout = false, exitOnComplete = false } = {}) {
        if (state.closePromise) {
            return state.closePromise;
        }

        state.isShuttingDown = true;
        if (typeof hooks.beforeShutdown === "function") {
            try {
                hooks.beforeShutdown();
            } catch (err) {
                log.warn(`Error in beforeShutdown hook:`, err);
            }
        }
        lifecycle.emitLifecycle("shutdown_start", {
            signal,
            workerCount: lifecycle.getWorkerCount(),
        });

        state.closePromise = new Promise((resolve) => {
            let settled = false;

            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                cluster.off("exit", onWorkerExitForClose);
                if (state.forceExitTimer) {
                    clearTimeout(state.forceExitTimer);
                    state.forceExitTimer = undefined;
                }
                removeSignalHandlers();
                lifecycle.removeClusterEvents();
                if (typeof hooks.afterShutdown === "function") {
                    try {
                        hooks.afterShutdown();
                    } catch (err) {
                        log.warn(`Error in afterShutdown hook:`, err);
                    }
                }
                lifecycle.emitLifecycle("shutdown_end", {
                    workerCount: lifecycle.getWorkerCount(),
                });
                if (exitOnComplete) {
                    process.exit(0);
                    return;
                }
                resolve();
            };

            const onWorkerExitForClose = () => {
                if (lifecycle.getWorkerCount() === 0) {
                    finish();
                }
            };

            cluster.on("exit", onWorkerExitForClose);
            disconnectWorkersForShutdown();
            onWorkerExitForClose();

            if (!settled && shutdownTimeout > 0) {
                state.forceExitTimer = setTimeout(() => {
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
                state.forceExitTimer.unref();
            }
        });

        return state.closePromise;
    }

    function attachSignalHandlers() {
        if (!Array.isArray(shutdownSignals) || shutdownSignals.length === 0) {
            return;
        }
        for (const signal of shutdownSignals) {
            if (state.signalHandlers.has(signal)) {
                continue;
            }
            const handler = () => {
                log.info(`Master received ${signal}, shutting down workers...`);
                closeCluster({ signal, exitOnTimeout: true, exitOnComplete: true });
            };
            state.signalHandlers.set(signal, handler);
            process.on(signal, handler);
        }
    }

    function removeSignalHandlers() {
        for (const [signal, handler] of state.signalHandlers.entries()) {
            process.off(signal, handler);
        }
        state.signalHandlers.clear();
    }

    return {
        closeCluster,
        attachSignalHandlers,
        removeSignalHandlers,
    };
}
