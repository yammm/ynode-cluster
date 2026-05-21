// ynode/cluster — zero-downtime reload orchestration

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
 * Creates the reload controller — orchestrates a zero-downtime rolling
 * replacement of the active worker pool. For each snapshotted worker:
 *   1. Fork a replacement worker and wait for `online`.
 *   2. If the original was listening, wait for the replacement to listen.
 *   3. Send a `"shutdown"` IPC to the old worker; fall back to
 *      `worker.disconnect()` if the IPC channel is gone.
 *   4. Wait for the old worker to exit, with a forced disconnect on
 *      timeout.
 *
 * Concurrent calls return the in-flight reload promise; calls during
 * shutdown reject immediately.
 *
 * @param {object} state - Shared cluster state.
 * @param {object} lifecycle - Lifecycle controller from createLifecycle().
 * @returns {{ reload: function(): Promise<void> }}
 */
export function createReload(state, lifecycle) {
    const { config, log } = state;
    const { reloadOnlineTimeout, reloadListeningTimeout, reloadDisconnectWait } = config;

    function waitForWorkerListening(worker, timeoutMs = reloadListeningTimeout) {
        if (!worker) {
            return Promise.reject(new Error("Cannot wait for listening: missing worker"));
        }
        if (state.listeningWorkers.has(worker.id)) {
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

    function waitForWorkerExit(worker, timeoutMs = reloadDisconnectWait) {
        if (!worker) {
            return Promise.resolve("missing-worker");
        }

        if (worker.isDead()) {
            return Promise.resolve("exit");
        }

        return new Promise((resolve) => {
            let settled = false;

            const cleanup = () => {
                worker.off("exit", onExit);
                clearTimeout(timeout);
            };

            const onExit = () => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve("exit");
            };

            const timeout = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                log.warn(
                    `Timed out waiting for worker ${worker.process.pid} to exit after ${timeoutMs}ms`,
                );
                resolve("timeout");
            }, timeoutMs);
            timeout.unref();

            worker.on("exit", onExit);
        });
    }

    async function performReload() {
        log.info("Starting zero-downtime cluster reload...");
        lifecycle.emitLifecycle("reload_start", { workerCount: lifecycle.getWorkerCount() });

        // Snapshot the current worker pool — the loop tolerates exits
        // mid-replace by skipping any snapshot entries that have already
        // left the cluster.workers map.
        const workersToReplace = lifecycle.getWorkers();

        for (const oldWorker of workersToReplace) {
            if (state.isShuttingDown) {
                throw new Error("Reload aborted: cluster is shutting down");
            }

            if (!cluster.workers[oldWorker.id]) {
                log.info(
                    `Skipping worker ${oldWorker.process.pid} — already exited before reload reached it.`,
                );
                continue;
            }

            log.info("Spawning replacement worker...");
            const newWorker = lifecycle.forkWorker("spawn replacement worker");
            if (!newWorker) {
                throw new Error("Reload aborted: failed to spawn replacement worker");
            }
            lifecycle.attachWorkerErrorHandler(newWorker);

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

            const shouldWaitForListening = state.listeningWorkers.has(oldWorker.id);
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

            // Signal the old worker to shut down gracefully via IPC so it
            // can run fastify.close() and tear down connections before the
            // cluster disconnects it. Falls back to disconnect() if the
            // message cannot be delivered.
            if (oldWorker.isConnected()) {
                try {
                    oldWorker.send("shutdown", (err) => {
                        if (err) {
                            log.warn(
                                `Failed to send shutdown to old worker ${oldWorker.process.pid}, falling back to disconnect:`,
                                err,
                            );
                            try {
                                oldWorker.disconnect();
                            } catch (disconnectErr) {
                                log.warn(
                                    `Failed to disconnect old worker ${oldWorker.process.pid}:`,
                                    disconnectErr,
                                );
                            }
                        }
                    });
                } catch (err) {
                    log.warn(
                        `Failed to send shutdown to old worker ${oldWorker.process.pid}, falling back to disconnect:`,
                        err,
                    );
                    try {
                        oldWorker.disconnect();
                    } catch (disconnectErr) {
                        log.warn(
                            `Failed to disconnect old worker ${oldWorker.process.pid}:`,
                            disconnectErr,
                        );
                    }
                }
            } else {
                try {
                    oldWorker.disconnect();
                } catch (err) {
                    log.warn(`Failed to disconnect old worker ${oldWorker.process.pid}:`, err);
                }
            }

            // Wait for the old worker process to fully exit so connections
            // (Redis, Mongoose, etc.) are torn down before cycling the
            // next worker.
            const exitResult = await waitForWorkerExit(oldWorker);
            if (exitResult === "timeout" && !oldWorker.isDead()) {
                try {
                    log.warn(`Forcing disconnect on unresponsive worker ${oldWorker.process.pid}`);
                    oldWorker.disconnect();
                } catch (err) {
                    log.warn(
                        `Failed to force disconnect old worker ${oldWorker.process.pid}:`,
                        err,
                    );
                }
            }
        }
        log.info("Cluster reload complete.");
        lifecycle.emitLifecycle("reload_end", { workerCount: lifecycle.getWorkerCount() });
    }

    async function reload() {
        if (state.isShuttingDown) {
            return;
        }
        if (state.reloadPromise) {
            return state.reloadPromise;
        }

        state.reloadPromise = performReload()
            .catch((err) => {
                lifecycle.emitLifecycle("reload_fail", {
                    error: err instanceof Error ? err.message : String(err),
                });
                throw err;
            })
            .finally(() => {
                state.reloadPromise = undefined;
            });

        return state.reloadPromise;
    }

    return { reload };
}
