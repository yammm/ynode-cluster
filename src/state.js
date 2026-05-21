// ynode/cluster — shared cluster state

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

import { EventEmitter } from "node:events";

/**
 * Constructs the mutable state object shared across cluster modules
 * (lifecycle, scaling, reload, shutdown, tty). The object is intentionally
 * a bag of fields so the same instance can be passed by reference and
 * mutated in place by each module without rebuilding the dependency tree.
 *
 * Fields:
 *   - config, log, ttyConfig — immutable references resolved at boot.
 *   - workerLoads — Map<workerId, {lag, lastSeen, memory}>.
 *   - workerStartTimes — Map<workerId, ms epoch>.
 *   - workerMessageHandlers — Map<workerId, {worker, handler}>.
 *   - listeningWorkers — Set<workerId>.
 *   - workersWithErrorHandler — WeakSet<worker>.
 *   - signalHandlers — Map<signal, handler>.
 *   - events — EventEmitter exposed via the public manager.on/off API.
 *   - isShuttingDown, lastScalingAction, lastScaleUpTime,
 *     consecutiveCrashRestarts — scalar mutation targets.
 *   - autoScaleTimer, forceExitTimer, ttyReadline — handles cleared on
 *     shutdown.
 *   - closePromise, reloadPromise — one-shot promises that serialize
 *     concurrent close/reload requests.
 *
 * @param {object} args
 * @param {object} args.config - Validated cluster configuration.
 * @param {object} args.log - Logger instance (console-shaped).
 * @param {object} args.ttyConfig - Validated TTY configuration.
 * @returns {object} Cluster state.
 */
export function createState({ config, log, ttyConfig }) {
    return {
        config,
        log,
        ttyConfig,
        masterStartTime: Date.now(),
        isShuttingDown: false,
        workerLoads: new Map(),
        workerStartTimes: new Map(),
        workerMessageHandlers: new Map(),
        listeningWorkers: new Set(),
        workersWithErrorHandler: new WeakSet(),
        signalHandlers: new Map(),
        lastScalingAction: Date.now(),
        lastScaleUpTime: Date.now(),
        consecutiveCrashRestarts: 0,
        autoScaleTimer: null,
        forceExitTimer: null,
        pendingRestartTimers: new Set(),
        closePromise: null,
        reloadPromise: null,
        ttyReadline: null,
        events: new EventEmitter(),
    };
}
