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

/**
 * Builds the public manager object returned by run(). The surface is
 * unchanged from prior versions:
 *   - getMetrics() — instantaneous worker/lag/memory snapshot.
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
    } = config;

    const manager = {
        getMetrics: () => {
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
        },
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
