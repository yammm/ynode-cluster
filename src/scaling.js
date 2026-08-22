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

/**
 * Creates the capacity and load-scaling controller. The control loop
 * fires every `autoScaleInterval` ms and:
 *   1. Restores desired capacity when restart policy permits it.
 *   2. Skips scaling decisions while a reload is in flight (worker count
 *      is transiently inflated).
 *   3. Scales up when average event-loop lag, heap, or RSS exceeds its
 *      configured threshold.
 *   4. Scales down by retiring the most-recently-added worker when
 *      average lag falls below `scaleDownThreshold`, gated by
 *      `scaleDownGrace` after the last scale-up.
 *
 * Per-worker memory limits are enforced when each heartbeat arrives in the
 * lifecycle controller. In `mode: "max"`, desired-capacity reconciliation
 * remains active while load-based scaling decisions are naturally bounded by
 * the fixed desired worker count.
 *
 * @param {object} state - Shared cluster state.
 * @param {object} lifecycle - Lifecycle controller from createLifecycle().
 * @returns {{ tick: function(): void, start: function(): void, stop: function(): void }}
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
        heartbeatStaleAfter,
        scaleUpMemory,
        scaleUpRss,
        norestart,
    } = config;

    function tick() {
        const now = Date.now();
        if (!norestart && lifecycle.getActiveWorkerCount() < state.desiredWorkers) {
            lifecycle.ensureDesiredCapacity("restore desired capacity during scaling check");
        }

        const freshLoads = [...state.workerLoads.entries()].filter(
            ([id, stats]) =>
                state.workerStates.get(id) !== "draining" &&
                now - stats.lastSeen <= heartbeatStaleAfter,
        );

        // Calculate average lag across fresh, active workers.
        let totalLag = 0;
        let count = 0;

        for (const [, stats] of freshLoads) {
            totalLag += stats.lag;
            ++count;
        }

        // Avoid load-based scaling decisions if we have no fresh stats. Stale
        // telemetry remains visible through metrics but is not treated as
        // evidence of either high or low load.
        if (count === 0) {
            return;
        }

        const avgLag = totalLag / count;

        // Calculate Average Memory in MB
        let totalMemory = 0;
        let memorySamples = 0;
        let totalRss = 0;
        let rssSamples = 0;
        for (const [, stats] of freshLoads) {
            if (typeof stats.memory === "number") {
                totalMemory += stats.memory;
                ++memorySamples;
            }
            if (typeof stats.rss === "number") {
                totalRss += stats.rss;
                ++rssSamples;
            }
        }
        const avgMemoryMB = memorySamples > 0 ? totalMemory / memorySamples / 1024 / 1024 : 0;
        const avgRssMB = rssSamples > 0 ? totalRss / rssSamples / 1024 / 1024 : 0;

        const currentWorkers = lifecycle.getActiveWorkerCount();

        // Skip all scaling decisions during an active reload — worker
        // count is transiently inflated and the reload orchestrator owns
        // the lifecycle.
        if (state.reloadPromise) {
            log.debug("Skipping scale decision during active reload.");
            return;
        }

        if (now - state.lastScalingAction < scalingCooldown) {
            return;
        }

        if (mode !== "smart") {
            return;
        }

        // Scale Up logic (Lag OR Memory)
        const shouldScaleUpLag = avgLag > scaleUpThreshold;
        const shouldScaleUpHeap = scaleUpMemory > 0 && avgMemoryMB > scaleUpMemory;
        const shouldScaleUpRss = scaleUpRss > 0 && avgRssMB > scaleUpRss;

        if (
            (shouldScaleUpLag || shouldScaleUpHeap || shouldScaleUpRss) &&
            state.desiredWorkers < maxWorkers
        ) {
            const reason = shouldScaleUpRss
                ? `High RSS (Avg: ${avgRssMB.toFixed(2)}MB)`
                : shouldScaleUpHeap
                  ? `High Heap (Avg: ${avgMemoryMB.toFixed(2)}MB)`
                  : `High Lag (Avg: ${avgLag.toFixed(2)}ms)`;

            log.info(`${reason} detected. Scaling up...`);
            lifecycle.setDesiredWorkerCount(state.desiredWorkers + 1);
            const scaledWorkers = lifecycle.ensureDesiredCapacity("scale up");
            if (scaledWorkers.length > 0) {
                lifecycle.emitLifecycle("scale_up", {
                    reason,
                    workerCount: lifecycle.getActiveWorkerCount(),
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

            if ((state.workerRetirementPromises?.size ?? 0) > 0) {
                log.debug("Skipping scale down while a worker retirement is in progress.");
                return;
            }

            log.info(`Low load detected (Avg Lag: ${avgLag.toFixed(2)}ms). Scaling down...`);
            const workers = lifecycle.getWorkers();
            const victim = workers.findLast(
                (worker) => state.workerStates.get(worker.id) !== "draining",
            );
            if (victim) {
                const previousDesiredWorkers = state.desiredWorkers;
                const scaleDownTarget = lifecycle.setDesiredWorkerCount(previousDesiredWorkers - 1);
                void lifecycle
                    .retireWorker(victim, {
                        reason: "scale down",
                        graceMs: config.shutdownTimeout,
                    })
                    .catch((err) => {
                        log.error(
                            `Failed to retire worker ${victim.process.pid} during scale down:`,
                            err,
                        );
                        if (state.desiredWorkers === scaleDownTarget) {
                            lifecycle.setDesiredWorkerCount(previousDesiredWorkers);
                        }
                        lifecycle.ensureDesiredCapacity("recover failed scale down", {
                            allowSurge: true,
                        });
                    });
                lifecycle.emitLifecycle("scale_down", {
                    workerId: victim.id,
                    workerPid: victim.process.pid,
                    workerCount: lifecycle.getActiveWorkerCount(),
                });
                state.lastScalingAction = now;
            }
        }
    }

    function start() {
        state.autoScaleTimer = setInterval(tick, autoScaleInterval);
        state.autoScaleTimer.unref();
    }

    function stop() {
        if (state.autoScaleTimer) {
            clearInterval(state.autoScaleTimer);
            state.autoScaleTimer = null;
        }
    }

    return { tick, start, stop };
}
