// ynode/cluster — smart-mode auto-scaling controller

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
 * Creates the auto-scaling controller for smart mode. The control loop
 * fires every `autoScaleInterval` ms and:
 *   1. Enforces per-worker memory limits (`maxWorkerMemory`) by killing
 *      offending workers — this safety check runs even during reload.
 *   2. Skips scaling decisions while a reload is in flight (worker count
 *      is transiently inflated).
 *   3. Scales up when average event-loop lag exceeds `scaleUpThreshold`
 *      or average heap usage exceeds `scaleUpMemory`.
 *   4. Scales down by disconnecting the most-recently-added worker when
 *      average lag falls below `scaleDownThreshold`, gated by
 *      `scaleDownGrace` after the last scale-up.
 *
 * In `mode: "max"` no interval is created — the cluster runs at
 * `maxWorkers` and the controller is a no-op.
 *
 * @param {object} state - Shared cluster state.
 * @param {object} lifecycle - Lifecycle controller from createLifecycle().
 * @returns {{ start: function(): void, stop: function(): void }}
 */
export function createScaling(state, lifecycle) {
    const { config, log } = state;
    const {
        mode,
        minWorkers,
        maxWorkers,
        scaleUpThreshold,
        scaleDownThreshold,
        scalingCooldown,
        scaleDownGrace,
        autoScaleInterval,
        scaleUpMemory,
        maxWorkerMemory,
    } = config;

    function tick() {
        const now = Date.now();
        if (now - state.lastScalingAction < scalingCooldown) {
            return;
        }

        // Calculate average lag across all workers
        let totalLag = 0;
        let count = 0;

        for (const stats of state.workerLoads.values()) {
            totalLag += stats.lag;
            ++count;
        }

        // Avoid scaling decisions if we have no stats yet
        if (count === 0) {
            return;
        }

        const avgLag = totalLag / count;

        // Calculate Average Memory in MB
        let totalMemory = 0;
        let memorySamples = 0;
        for (const stats of state.workerLoads.values()) {
            if (typeof stats.memory === "number") {
                totalMemory += stats.memory;
                ++memorySamples;
            }
        }
        const avgMemoryMB = memorySamples > 0 ? totalMemory / memorySamples / 1024 / 1024 : 0;

        const currentWorkers = lifecycle.getWorkerCount();

        // Leak Protection (Max Worker Memory) — runs even during reload.
        if (maxWorkerMemory > 0) {
            for (const [id, stats] of state.workerLoads.entries()) {
                if (typeof stats.memory !== "number") {
                    continue;
                }
                const memMB = stats.memory / 1024 / 1024;
                if (memMB > maxWorkerMemory) {
                    log.warn(
                        `Worker ${id} exceeded memory limit (${memMB.toFixed(2)}MB > ${maxWorkerMemory}MB). Restarting...`,
                    );
                    const worker = cluster.workers[id];
                    if (worker) {
                        worker.kill();
                    }
                    return; // Wait for exit handler to restart it.
                }
            }
        }

        // Skip all scaling decisions during an active reload — worker
        // count is transiently inflated and the reload orchestrator owns
        // the lifecycle.
        if (state.reloadPromise) {
            log.debug("Skipping scale decision during active reload.");
            return;
        }

        // Scale Up logic (Lag OR Memory)
        const shouldScaleUpLag = avgLag > scaleUpThreshold;
        const shouldScaleUpMem = scaleUpMemory > 0 && avgMemoryMB > scaleUpMemory;

        if ((shouldScaleUpLag || shouldScaleUpMem) && currentWorkers < maxWorkers) {
            const reason = shouldScaleUpMem
                ? `High Memory (Avg: ${avgMemoryMB.toFixed(2)}MB)`
                : `High Lag (Avg: ${avgLag.toFixed(2)}ms)`;

            log.info(`${reason} detected. Scaling up...`);
            const scaledWorker = lifecycle.forkWorker("scale up");
            if (scaledWorker) {
                lifecycle.emitLifecycle("scale_up", {
                    reason,
                    workerCount: currentWorkers + 1,
                });
            }
            state.lastScaleUpTime = Date.now();
            state.lastScalingAction = now;

            return;
        }

        if (avgLag < scaleDownThreshold && currentWorkers > minWorkers) {
            if (now - state.lastScaleUpTime < scaleDownGrace) {
                log.debug("Skipping scale down due to warm-up grace period.");
                return;
            }

            log.info(`Low load detected (Avg Lag: ${avgLag.toFixed(2)}ms). Scaling down...`);
            const workers = lifecycle.getWorkers();
            const victim = workers[workers.length - 1];
            if (victim) {
                victim.disconnect();
                lifecycle.emitLifecycle("scale_down", {
                    workerId: victim.id,
                    workerPid: victim.process.pid,
                    workerCount: currentWorkers - 1,
                });
                state.lastScalingAction = now;
            }
        }
    }

    function start() {
        if (mode !== "smart") {
            return;
        }
        state.autoScaleTimer = setInterval(tick, autoScaleInterval);
        state.autoScaleTimer.unref();
    }

    function stop() {
        if (state.autoScaleTimer) {
            clearInterval(state.autoScaleTimer);
            state.autoScaleTimer = undefined;
        }
    }

    return { start, stop };
}
