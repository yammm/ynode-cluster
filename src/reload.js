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

const STRANDED_RETIREMENT_RETRY_DELAY_MS = 1000;

/**
 * Creates the reload controller — orchestrates a zero-downtime rolling
 * replacement of the active worker pool. For each snapshotted worker:
 *   1. Fork a replacement worker and wait for `online`.
 *   2. If the original was listening, wait for the replacement to listen.
 *   3. Run the optional replacement health check.
 *   4. Retire the old worker through the shared bounded shutdown path.
 *   5. Verify the old process exited before moving to the next worker.
 *
 * Concurrent calls return the in-flight reload promise. Calls during shutdown
 * reject immediately, and shutdown aborts any readiness wait in progress.
 *
 * @param {object} state - Shared cluster state.
 * @param {object} lifecycle - Lifecycle controller from createLifecycle().
 * @returns {{ reload: function(): Promise<void>, cancel: function(*=): void }}
 */
export function createReload(state, lifecycle) {
    const { config, log } = state;
    const {
        reloadOnlineTimeout,
        reloadListeningTimeout,
        reloadHealthCheck,
        reloadHealthTimeout,
        reloadDisconnectWait,
    } = config;

    function createAbortError(reason = "Cluster reload was aborted") {
        if (reason instanceof Error && reason.name === "AbortError") {
            return reason;
        }
        const error =
            reason instanceof Error
                ? new Error(reason.message, { cause: reason })
                : new Error(String(reason));
        error.name = "AbortError";
        return error;
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error && reason.name === "AbortError"
                ? reason
                : createAbortError(reason);
        }
    }

    function waitForWorkerListening(worker, signal, timeoutMs = reloadListeningTimeout) {
        if (!worker) {
            return Promise.reject(new Error("Cannot wait for listening: missing worker"));
        }
        if (signal?.aborted) {
            return Promise.reject(createAbortError(signal.reason));
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
            const cleanup = () => {
                cluster.off("listening", onListening);
                worker.off("disconnect", onDisconnect);
                worker.off("exit", onExit);
                signal?.removeEventListener("abort", onAbort);
                clearTimeout(timeout);
            };

            const onListening = (listeningWorker) => {
                if (!settled && listeningWorker?.id === worker.id) {
                    settled = true;
                    cleanup();
                    resolve();
                }
            };

            const fail = (message) => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(new Error(message));
                }
            };

            const onDisconnect = () =>
                fail(`Replacement worker ${worker.process.pid} disconnected before listening`);
            const onExit = (code, exitSignal) =>
                fail(
                    `Replacement worker ${worker.process.pid} exited before listening (code=${code}, signal=${exitSignal})`,
                );
            const onAbort = () => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(createAbortError(signal.reason));
                }
            };

            cluster.on("listening", onListening);
            worker.once("disconnect", onDisconnect);
            worker.once("exit", onExit);
            signal?.addEventListener("abort", onAbort, { once: true });

            if (state.listeningWorkers.has(worker.id)) {
                onListening(worker);
            } else if (worker.isDead()) {
                onExit(null, "already-exited");
            }
        });
    }

    function waitForWorkerOnline(worker, signal, timeoutMs = reloadOnlineTimeout) {
        if (!worker) {
            return Promise.reject(new Error("Cannot wait for online: missing worker"));
        }
        if (signal?.aborted) {
            return Promise.reject(createAbortError(signal.reason));
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
            const cleanup = () => {
                worker.off("online", onOnline);
                worker.off("disconnect", onDisconnect);
                worker.off("exit", onExit);
                signal?.removeEventListener("abort", onAbort);
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

            const onAbort = () => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(createAbortError(signal.reason));
                }
            };

            worker.on("online", onOnline);
            worker.on("disconnect", onDisconnect);
            worker.on("exit", onExit);
            signal?.addEventListener("abort", onAbort, { once: true });

            if (worker.isDead()) {
                onExit(null, "already-exited");
            }
        });
    }

    async function waitForWorkerHealth(worker, oldWorker, signal, timeoutMs = reloadHealthTimeout) {
        if (typeof reloadHealthCheck !== "function") {
            return;
        }
        if (!worker) {
            throw new Error("Cannot run reload health check: missing worker");
        }
        if (signal?.aborted) {
            throw createAbortError(signal.reason);
        }

        let timeout;
        let removeAbortListener = () => {};
        const timeoutPromise = new Promise((_, reject) => {
            timeout = setTimeout(() => {
                reject(
                    new Error(
                        `Replacement worker ${worker.process.pid} did not pass reload health check within ${timeoutMs}ms`,
                    ),
                );
            }, timeoutMs);
            const onAbort = () => reject(createAbortError(signal.reason));
            signal?.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
        });

        const healthPromise = Promise.resolve()
            .then(() =>
                reloadHealthCheck(worker, {
                    oldWorker,
                    signal,
                    workerCount: lifecycle.getActiveWorkerCount(),
                }),
            )
            .then((result) => {
                if (result === false) {
                    throw new Error(
                        `Replacement worker ${worker.process.pid} failed reload health check`,
                    );
                }
            });

        try {
            await Promise.race([healthPromise, timeoutPromise]);
        } finally {
            clearTimeout(timeout);
            removeAbortListener();
        }
    }

    // A reload replaces the old worker before retiring it, so a retirement
    // failure leaves the pool one process above the desired count with no
    // owner to reconcile it (in mode "max" nothing ever scales down). Retry
    // the retirement in the background until the stranded worker exits.
    function retryStrandedRetirement(oldWorker, attempt) {
        if (state.isShuttingDown || oldWorker.isDead()) {
            return;
        }

        void lifecycle
            .retireWorker(oldWorker, { reason: "stranded reload retirement", graceMs: 0 })
            .then(() => {
                log.info(
                    `Stranded worker ${oldWorker.process.pid} retired after the failed reload.`,
                );
            })
            .catch((err) => {
                log.warn(
                    `Retirement retry ${attempt} failed for stranded worker ${oldWorker.process.pid}; retrying in ${STRANDED_RETIREMENT_RETRY_DELAY_MS}ms.`,
                    err,
                );
                scheduleStrandedRetirement(oldWorker, attempt + 1);
            });
    }

    function scheduleStrandedRetirement(oldWorker, attempt = 1) {
        setTimeout(
            () => retryStrandedRetirement(oldWorker, attempt),
            STRANDED_RETIREMENT_RETRY_DELAY_MS,
        ).unref();
    }

    async function performReload(signal) {
        log.info("Starting zero-downtime cluster reload...");
        lifecycle.emitLifecycle("reload_start", { workerCount: lifecycle.getActiveWorkerCount() });

        // Snapshot the current worker pool — the loop tolerates exits
        // mid-replace by skipping any snapshot entries that have already
        // left the cluster.workers map.
        const workersToReplace = lifecycle.getActiveWorkers();

        for (const oldWorker of workersToReplace) {
            throwIfAborted(signal);

            if (!cluster.workers[oldWorker.id]) {
                log.info(
                    `Skipping worker ${oldWorker.process.pid} — already exited before reload reached it.`,
                );
                continue;
            }

            log.info("Spawning replacement worker...");
            const newWorker = lifecycle.forkWorker("spawn replacement worker", {
                allowSurge: true,
            });
            if (!newWorker) {
                throw new Error("Reload aborted: failed to spawn replacement worker");
            }
            lifecycle.attachWorkerErrorHandler(newWorker);

            try {
                await waitForWorkerOnline(newWorker, signal);
            } catch (err) {
                log.error(
                    `Reload aborted: replacement worker ${newWorker.process.pid} failed to come online.`,
                    err,
                );
                await lifecycle.retireWorker(newWorker, {
                    reason: "failed reload replacement",
                    graceMs: 0,
                });
                throw err;
            }

            const shouldWaitForListening = state.listeningWorkers.has(oldWorker.id);
            if (shouldWaitForListening) {
                try {
                    await waitForWorkerListening(newWorker, signal);
                } catch (err) {
                    log.error(
                        `Reload aborted: replacement worker ${newWorker.process.pid} failed readiness check.`,
                        err,
                    );
                    await lifecycle.retireWorker(newWorker, {
                        reason: "unready reload replacement",
                        graceMs: 0,
                    });
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

            try {
                await waitForWorkerHealth(newWorker, oldWorker, signal);
            } catch (err) {
                log.error(
                    `Reload aborted: replacement worker ${newWorker.process.pid} failed health check.`,
                    err,
                );
                await lifecycle.retireWorker(newWorker, {
                    reason: "unhealthy reload replacement",
                    graceMs: 0,
                });
                throw err;
            }

            try {
                await lifecycle.retireWorker(oldWorker, {
                    reason: "rolling reload",
                    graceMs: reloadDisconnectWait,
                });
            } catch (err) {
                log.error(
                    `Reload failed: old worker ${oldWorker.process.pid} did not exit; scheduling retirement retries to restore the desired worker count.`,
                    err,
                );
                scheduleStrandedRetirement(oldWorker);
                throw err;
            }
            throwIfAborted(signal);
        }
        log.info("Cluster reload complete.");
        lifecycle.emitLifecycle("reload_end", { workerCount: lifecycle.getActiveWorkerCount() });
    }

    async function reload() {
        if (state.isShuttingDown) {
            throw createAbortError("Reload rejected: cluster is shutting down");
        }
        if (state.reloadPromise) {
            return state.reloadPromise;
        }

        const abortController = new AbortController();
        state.reloadAbortController = abortController;
        state.reloadPromise = Promise.resolve()
            .then(() => performReload(abortController.signal))
            .catch((err) => {
                lifecycle.emitLifecycle("reload_fail", {
                    error: err instanceof Error ? err.message : String(err),
                });
                throw err;
            })
            .finally(() => {
                if (state.reloadAbortController === abortController) {
                    state.reloadAbortController = null;
                }
                state.reloadPromise = null;
            });

        return state.reloadPromise;
    }

    function cancel(reason = "Cluster reload cancelled") {
        state.reloadAbortController?.abort(createAbortError(reason));
    }

    return { reload, cancel };
}
