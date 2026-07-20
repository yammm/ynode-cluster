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

/**
 * Creates the shutdown controller. Every worker receives a graceful IPC
 * request, followed by SIGTERM and SIGKILL escalation when required.
 *
 * `closeCluster()` is idempotent; concurrent calls return the in-flight
 * shutdown promise. A second configured termination signal bypasses the
 * graceful budget, kills remaining workers, and exits non-zero.
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

    function forceKillWorkers(reason) {
        for (const worker of lifecycle.getWorkers()) {
            state.workerStates.set(worker.id, "draining");
            state.workerRetirements.set(worker.id, { reason, startedAt: Date.now() });
            try {
                worker.kill("SIGKILL");
            } catch (err) {
                log.warn(`Failed to force kill worker ${worker.process.pid}:`, err);
            }
        }
    }

    function runBeforeShutdown() {
        if (typeof hooks.beforeShutdown === "function") {
            try {
                hooks.beforeShutdown();
            } catch (err) {
                log.warn(`Error in beforeShutdown hook:`, err);
            }
        }
    }

    function finishShutdown() {
        removeSignalHandlers();
        lifecycle.removeClusterEvents();
        if (typeof hooks.afterShutdown === "function") {
            try {
                hooks.afterShutdown();
            } catch (err) {
                log.warn(`Error in afterShutdown hook:`, err);
            }
        }
    }

    function closeCluster({ signal = null, exitOnComplete = false } = {}) {
        if (state.closePromise) {
            return state.closePromise;
        }

        state.isShuttingDown = true;
        state.reloadAbortController?.abort(new Error("Reload aborted: cluster is shutting down"));
        runBeforeShutdown();

        const performShutdown = async () => {
            const graceMs = Math.max(0, shutdownTimeout - 2000);
            const retirements = lifecycle.getWorkers().map((worker) =>
                lifecycle.retireWorker(worker, {
                    reason: signal ? `shutdown after ${signal}` : "programmatic shutdown",
                    graceMs,
                }),
            );
            const results = await Promise.allSettled(retirements);
            const failures = results
                .filter((result) => result.status === "rejected")
                .map((result) => result.reason);

            if (state.reloadPromise) {
                try {
                    await state.reloadPromise;
                } catch (err) {
                    if (err?.name !== "AbortError") {
                        log.warn("Reload failed while cluster shutdown was in progress:", err);
                    }
                }
            }

            if (lifecycle.getWorkerCount() > 0) {
                forceKillWorkers("final shutdown cleanup");
                failures.push(
                    new Error(
                        `${lifecycle.getWorkerCount()} worker(s) remained after shutdown escalation`,
                    ),
                );
            }

            finishShutdown();
            lifecycle.emitLifecycle("shutdown_end", {
                workerCount: lifecycle.getActiveWorkerCount(),
                forced: results.some(
                    (result) => result.status === "fulfilled" && result.value.forced,
                ),
            });

            if (failures.length > 0) {
                throw new AggregateError(failures, "Cluster shutdown did not complete cleanly");
            }
        };
        state.closePromise = Promise.resolve().then(performShutdown);
        lifecycle.emitLifecycle("shutdown_start", {
            signal,
            workerCount: lifecycle.getActiveWorkerCount(),
        });

        if (exitOnComplete) {
            void state.closePromise.then(
                () => process.exit(0),
                (err) => {
                    log.error("Cluster shutdown failed:", err);
                    forceKillWorkers("failed cluster shutdown");
                    process.exit(1);
                },
            );
        }

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
                if (state.closePromise) {
                    log.warn(`Master received ${signal} again; forcing immediate shutdown.`);
                    forceKillWorkers(`second ${signal}`);
                    process.exit(1);
                    return;
                }
                log.info(`Master received ${signal}, shutting down workers...`);
                closeCluster({ signal, exitOnComplete: true });
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
