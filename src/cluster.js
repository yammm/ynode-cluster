// ynode/cluster

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
 * cluster.js: Process Manager / Cluster Orchestrator.
 *
 * Its sole responsibility is to wire together the per-concern modules
 * (config, lifecycle, reload, scaling, shutdown, tty) into the public
 * `run()` entry point. The actual logic for each concern lives in its
 * own module under src/.
 *
 * @module cluster
 */

import cluster from "node:cluster";

import {
    buildClusterConfig,
    buildTtyConfig,
    resolveClusteringEnabled,
    validateClusterConfig,
} from "./config.js";
import { createLifecycle } from "./lifecycle.js";
import { createManager } from "./manager.js";
import { createReload } from "./reload.js";
import { createScaling } from "./scaling.js";
import { createShutdown } from "./shutdown.js";
import { createState } from "./state.js";
import { createTty } from "./tty.js";

const HEARTBEAT_INTERVAL_MS = 2000;

/**
 * Starts the per-worker heartbeat loop that reports event-loop lag and
 * memory usage to the master. Called inside worker processes only.
 * @param {object} log - Logger instance.
 */
function startWorkerHeartbeat(log) {
    const worker = cluster.worker;
    let lastCheck = Date.now();

    const interval = setInterval(() => {
        if (!worker.isConnected()) {
            return clearInterval(interval);
        }

        const now = Date.now();

        // Approximate event loop lag
        const lag = now - lastCheck - HEARTBEAT_INTERVAL_MS;
        lastCheck = now;

        const { heapUsed, rss, external, arrayBuffers } = process.memoryUsage();

        try {
            worker.send({
                cmd: "heartbeat",
                lag: Math.max(0, lag),
                memory: { heapUsed, rss, external, arrayBuffers },
            });
        } catch (err) {
            // Ignore, channel probably closed
            log.debug("Failed to send heartbeat to master", err);
        }
    }, HEARTBEAT_INTERVAL_MS).unref();
}

/**
 * Manages the application's clustering.
 * @param {function} startWorker - The function to execute when a worker process starts.
 * @param {object|boolean} options - Configuration object or boolean to enable/disable.
 * @param {boolean} [options.enabled=true] - Whether clustering is enabled.
 * @param {number} [options.minWorkers=Math.min(2, os.availableParallelism())] - Minimum number of workers (smart mode).
 * @param {number} [options.maxWorkers=os.availableParallelism()] - Maximum number of workers.
 * @param {number} [options.scaleUpThreshold=50] - Event loop lag (ms) threshold to scale up.
 * @param {number} [options.scaleDownThreshold=10] - Event loop lag (ms) threshold to scale down.
 * @param {string} [options.mode="smart"] - "smart" (auto-scaling) or "max" (all cores).
 * @param {number} [options.scalingCooldown=10000] - Ms to wait between scaling actions.
 * @param {number} [options.scaleDownGrace=30000] - Ms to wait after scale-up before allowing scale-down.
 * @param {number} [options.autoScaleInterval=5000] - Ms between capacity and load-scaling checks.
 * @param {number} [options.heartbeatStaleAfter=10000] - Max heartbeat age used for scaling decisions.
 * @param {string[]} [options.shutdownSignals] - Signals that initiate graceful primary shutdown.
 * @param {number} [options.shutdownTimeout=10000] - Total graceful worker shutdown budget in ms.
 * @param {number} [options.scaleUpMemory=0] - Average worker heap MB that triggers scale-up.
 * @param {number} [options.scaleUpRss=0] - Average worker RSS MB that triggers scale-up.
 * @param {number} [options.maxWorkerMemory=0] - Per-worker heap MB restart threshold, checked on heartbeat.
 * @param {number} [options.maxWorkerRss=0] - Per-worker RSS MB restart threshold, checked on heartbeat.
 * @param {number} [options.reloadOnlineTimeout=10000] - Max ms to wait for replacement worker "online" during reload.
 * @param {number} [options.reloadListeningTimeout=10000] - Max ms to wait for replacement worker "listening" during reload.
 * @param {number} [options.reloadDisconnectWait=10000] - Max ms to wait for old worker to exit during each reload step.
 * @param {object} [options.tty] - Optional TTY command mode options.
 * @param {boolean} [options.tty.enabled=false] - Enable TTY mode in master process.
 * @param {boolean} [options.tty.commands=true] - Enable line-based command handling when TTY mode is enabled.
 * @param {string} [options.tty.reloadCommand="/rl"] - Command that triggers a cluster reload.
 * @param {object} [options.tty.stdin=process.stdin] - Readable input stream used for command mode; commands require isTTY=true.
 * @param {object} [options.tty.stdout=process.stdout] - Writable output stream used for command mode.
 * @param {string} [options.tty.prompt] - Optional command prompt text.
 * @param {object} log - The logger instance.
 * @returns {object|*} The cluster manager (in master), or the return value of startWorker (in worker / clustering-disabled mode).
 */
export function run(startWorker, options = true, log = console) {
    if (typeof startWorker !== "function") {
        throw new Error(
            `Invalid configuration: startWorker (${typeof startWorker}) must be a function`,
        );
    }

    const isEnabled = resolveClusteringEnabled(options);

    if (cluster.isWorker || !isEnabled) {
        log.info(`Running worker process.`);

        if (cluster.isWorker) {
            startWorkerHeartbeat(log);
        }

        return startWorker();
    }

    const config = buildClusterConfig(options);
    validateClusterConfig(config);

    const ttyConfig = buildTtyConfig(config.tty);
    const state = createState({ config, log, ttyConfig });

    const lifecycle = createLifecycle(state);
    const reload = createReload(state, lifecycle);
    const scaling = createScaling(state, lifecycle);
    const tty = createTty(state, lifecycle, reload);
    const shutdown = createShutdown(state, lifecycle, {
        beforeShutdown: () => {
            tty.close();
            scaling.stop();
            for (const timer of state.pendingRestartTimers) {
                clearTimeout(timer);
            }
            state.pendingRestartTimers.clear();
        },
    });

    lifecycle.attachClusterEvents();
    shutdown.attachSignalHandlers();
    scaling.start();
    tty.setup();

    const initialWorkers = config.mode === "max" ? config.maxWorkers : config.minWorkers;
    lifecycle.setDesiredWorkerCount(initialWorkers);
    log.info(
        `Shogun is the master! Starting ${initialWorkers} workers (Max: ${config.maxWorkers}).`,
    );

    const startedWorkers = lifecycle.ensureDesiredCapacity("fork initial worker");
    if (startedWorkers.length !== initialWorkers) {
        log.warn(
            `Started ${startedWorkers.length} of ${initialWorkers} requested initial workers; the capacity controller will keep retrying.`,
        );
    }
    state.lastScaleUpTime = Date.now();

    return createManager(state, lifecycle, reload, shutdown);
}
