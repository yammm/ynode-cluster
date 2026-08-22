// ynode/cluster — public manager API surface

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

const WAIT_FOR_CAPACITY_OPTION_KEYS = new Set(["state", "count", "timeoutMs", "signal"]);

/**
 * Builds the public manager object returned by run(). Its surface includes:
 *   - getMetrics() — instantaneous worker/lag/memory snapshot.
 *   - waitForCapacity() — waits for online or listening worker capacity.
 *   - reload() — initiates a zero-downtime rolling worker replacement.
 *   - close() — initiates graceful shutdown.
 *   - on/once/off(eventName, listener) — subscribe to lifecycle events.
 *
 * Lifecycle events emitted on the manager:
 *   - `worker_online`        { id, pid, workerCount }
 *   - `worker_listening`     { id, pid, address, port, workerCount }
 *   - `worker_exit`          { id, pid, code, signal, workerCount }
 *   - `worker_restart_scheduled` { id, pid, delayMs, workerCount }
 *   - `scale_up`             { reason, workerCount }
 *   - `scale_down`           { workerId, workerPid, workerCount }
 *   - `reload_start`         { workerCount }
 *   - `reload_end`           { workerCount }
 *   - `reload_fail`          { error }
 *   - `shutdown_start`       { signal, workerCount }
 *   - `shutdown_end`         { workerCount, forced }
 *
 * @param {object} state - Shared cluster state.
 * @param {object} lifecycle - Lifecycle controller.
 * @param {object} reload - Reload controller.
 * @param {object} shutdown - Shutdown controller.
 * @returns {object} Public manager surface.
 */
export function createManager(state, lifecycle, reload, shutdown) {
    const { config, events } = state;
    const {
        maxWorkers,
        minWorkers,
        scaleUpThreshold,
        scaleDownThreshold,
        heartbeatStaleAfter,
        mode,
        reloadListeningTimeout,
        reloadOnlineTimeout,
    } = config;

    const getMetrics = () => {
        const now = Date.now();
        const currentWorkers = lifecycle.getActiveWorkerCount();
        let totalLag = 0;
        let count = 0;
        const workersData = [];

        for (const worker of lifecycle.getWorkers()) {
            const stats = state.workerLoads.get(worker.id);
            const stale = !stats || now - stats.lastSeen > heartbeatStaleAfter;
            if (stats && !stale && state.workerStates.get(worker.id) !== "draining") {
                totalLag += stats.lag;
                ++count;
            }

            const workerStartTime = state.workerStartTimes.get(worker.id);
            workersData.push({
                id: worker.id,
                pid: worker.process.pid,
                state: state.workerStates.get(worker.id) ?? "starting",
                listening: state.listeningWorkers.has(worker.id),
                lag: stats?.lag,
                memory: stats?.memory,
                rss: stats?.rss,
                external: stats?.external,
                arrayBuffers: stats?.arrayBuffers,
                lastSeen: stats?.lastSeen,
                stale,
                uptime: workerStartTime ? now - workerStartTime : undefined,
            });
        }

        const avgLag = count > 0 ? totalLag / count : 0;

        return {
            workers: workersData,
            totalLag,
            avgLag,
            workerCount: currentWorkers,
            processCount: lifecycle.getWorkerCount(),
            desiredWorkers: state.desiredWorkers,
            maxWorkers,
            minWorkers,
            scaleUpThreshold,
            scaleDownThreshold,
            mode,
        };
    };

    /**
     * Counts active workers that reached the requested lifecycle state.
     * Listening workers also satisfy an online wait.
     * @param {"online"|"listening"} requiredState - Minimum lifecycle state.
     * @returns {number} Matching active worker count.
     */
    function capacityWorkerCount(requiredState) {
        let count = 0;
        for (const worker of lifecycle.getWorkers()) {
            const workerState = state.workerStates.get(worker.id);
            if (workerState === "draining") {
                continue;
            }
            if (requiredState === "listening") {
                if (workerState === "listening" && state.listeningWorkers.has(worker.id)) {
                    ++count;
                }
            } else if (workerState === "online" || workerState === "listening") {
                ++count;
            }
        }
        return count;
    }

    function waitError(code, message, { name = "Error", cause } = {}) {
        const error = new Error(message, cause === undefined ? undefined : { cause });
        error.name = name;
        error.code = code;
        return error;
    }

    function isAbortSignal(signal) {
        return (
            signal !== null &&
            typeof signal === "object" &&
            typeof signal.aborted === "boolean" &&
            typeof signal.addEventListener === "function" &&
            typeof signal.removeEventListener === "function"
        );
    }

    /**
     * Waits until the requested number of workers reaches an operational state.
     * The wait observes lifecycle events and always removes its listeners when it
     * settles. It never changes the desired worker count.
     * @param {object} [options] - Capacity wait options.
     * @param {"online"|"listening"} [options.state="listening"] - Required state.
     * @param {number} [options.count=state.desiredWorkers] - Required worker count.
     * @param {number} [options.timeoutMs] - Deadline; zero disables it.
     * @param {AbortSignal} [options.signal] - Optional cancellation signal.
     * @returns {Promise<object>} Fresh cluster metrics after capacity is reached.
     */
    function waitForCapacity(options = {}) {
        if (options === null || typeof options !== "object" || Array.isArray(options)) {
            throw new TypeError("waitForCapacity options must be an object");
        }
        const unknownOption = Object.keys(options)
            .filter((key) => !WAIT_FOR_CAPACITY_OPTION_KEYS.has(key))
            .sort()
            .at(0);
        if (unknownOption !== undefined) {
            throw new TypeError(`waitForCapacity received unknown option: ${unknownOption}`);
        }

        const requiredState = options.state ?? "listening";
        if (requiredState !== "online" && requiredState !== "listening") {
            throw new TypeError('waitForCapacity state must be "online" or "listening"');
        }

        const requiredCount = options.count ?? state.desiredWorkers;
        if (!Number.isInteger(requiredCount) || requiredCount < 1 || requiredCount > maxWorkers) {
            throw new RangeError(
                `waitForCapacity count must be an integer between 1 and ${maxWorkers}`,
            );
        }

        const defaultTimeout =
            requiredState === "listening" ? reloadListeningTimeout : reloadOnlineTimeout;
        const timeoutMs = options.timeoutMs ?? defaultTimeout;
        if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
            throw new RangeError("waitForCapacity timeoutMs must be a non-negative finite number");
        }

        const { signal } = options;
        if (signal !== undefined && !isAbortSignal(signal)) {
            throw new TypeError("waitForCapacity signal must be an AbortSignal");
        }

        const abortError = () =>
            waitError("CLUSTER_WAIT_ABORTED", "Waiting for cluster capacity was aborted", {
                name: "AbortError",
                cause: signal?.reason,
            });
        const shutdownError = () =>
            waitError(
                "CLUSTER_SHUTTING_DOWN",
                "Cannot wait for cluster capacity while shutdown is in progress",
            );

        if (signal?.aborted) {
            return Promise.reject(abortError());
        }
        if (state.isShuttingDown) {
            return Promise.reject(shutdownError());
        }
        if (capacityWorkerCount(requiredState) >= requiredCount) {
            return Promise.resolve(getMetrics());
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let timeout;

            const cleanup = () => {
                events.off("worker_online", checkCapacity);
                events.off("worker_listening", checkCapacity);
                events.off("shutdown_start", onShutdown);
                signal?.removeEventListener("abort", onAbort);
                if (timeout !== undefined) {
                    clearTimeout(timeout);
                }
            };
            const finish = (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (error) {
                    reject(error);
                } else {
                    resolve(getMetrics());
                }
            };
            function checkCapacity() {
                if (state.isShuttingDown) {
                    finish(shutdownError());
                } else if (capacityWorkerCount(requiredState) >= requiredCount) {
                    finish();
                }
            }
            function onShutdown() {
                finish(shutdownError());
            }
            function onAbort() {
                finish(abortError());
            }

            events.on("worker_online", checkCapacity);
            events.on("worker_listening", checkCapacity);
            events.on("shutdown_start", onShutdown);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (timeoutMs > 0) {
                timeout = setTimeout(() => {
                    finish(
                        waitError(
                            "CLUSTER_WAIT_TIMEOUT",
                            `Timed out after ${timeoutMs}ms waiting for ${requiredCount} ${requiredState} worker(s)`,
                        ),
                    );
                }, timeoutMs);
            }

            // Close the race between the initial snapshot and listener setup.
            checkCapacity();
        });
    }

    const manager = {
        getMetrics,
        waitForCapacity,
        reload: reload.reload,
        close: async () => shutdown.closeCluster(),
        on: (eventName, listener) => {
            events.on(eventName, listener);
            return manager;
        },
        once: (eventName, listener) => {
            events.once(eventName, listener);
            return manager;
        },
        off: (eventName, listener) => {
            events.off(eventName, listener);
            return manager;
        },
    };

    return manager;
}
