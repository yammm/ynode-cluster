import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createScaling } from "../src/scaling.js";

function createWorker(id) {
    return { id, process: { pid: 20000 + id } };
}

function createScalingHarness({ workerCount = 3, maxWorkers = 4 } = {}) {
    const workers = Array.from({ length: workerCount }, (_, index) => createWorker(index + 1));
    const now = Date.now();
    const state = {
        config: {
            mode: "smart",
            minWorkers: 1,
            maxWorkers,
            scaleUpThreshold: 50,
            scaleDownThreshold: 10,
            scalingCooldown: 0,
            scaleDownGrace: 0,
            autoScaleInterval: 1000,
            heartbeatStaleAfter: 10000,
            scaleUpMemory: 0,
            scaleUpRss: 0,
            shutdownTimeout: 100,
            norestart: false,
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        desiredWorkers: workerCount,
        workerLoads: new Map(),
        workerStates: new Map(),
        workerRetirementPromises: new Map(),
        reloadPromise: null,
        lastScalingAction: 0,
        lastScaleUpTime: 0,
    };
    for (const worker of workers) {
        state.workerStates.set(worker.id, "listening");
        state.workerLoads.set(worker.id, { lag: 0, lastSeen: now });
    }

    const ensureCalls = [];
    const desiredTargets = [];
    const lifecycle = {
        getActiveWorkerCount: () =>
            workers.filter((worker) => state.workerStates.get(worker.id) !== "draining").length,
        getWorkers: () => workers,
        setDesiredWorkerCount: (count) => {
            state.desiredWorkers = Math.max(1, Math.min(maxWorkers, count));
            desiredTargets.push(state.desiredWorkers);
            return state.desiredWorkers;
        },
        ensureDesiredCapacity: (context, options) => {
            ensureCalls.push({ context, options });
            return [];
        },
        emitLifecycle() {},
    };

    return { ensureCalls, desiredTargets, lifecycle, state, workers };
}

describe("Scaling hardening", () => {
    it("serializes scale-down and restores capacity after retirement failure", async () => {
        const { ensureCalls, desiredTargets, lifecycle, state, workers } = createScalingHarness();
        let rejectRetirement;
        let retirementCalls = 0;
        const pendingRetirement = new Promise((_, reject) => {
            rejectRetirement = reject;
        });
        lifecycle.retireWorker = (worker) => {
            ++retirementCalls;
            state.workerStates.set(worker.id, "draining");
            const tracked = pendingRetirement.finally(() => {
                state.workerRetirementPromises.delete(worker.id);
            });
            state.workerRetirementPromises.set(worker.id, tracked);
            return tracked;
        };
        const scaling = createScaling(state, lifecycle);

        scaling.tick();
        scaling.tick();

        assert.strictEqual(retirementCalls, 1);
        assert.strictEqual(state.desiredWorkers, 2);
        rejectRetirement(new Error("worker refused to exit"));
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepStrictEqual(desiredTargets, [2, 3]);
        assert.strictEqual(state.desiredWorkers, 3);
        assert.deepStrictEqual(ensureCalls.at(-1), {
            context: "recover failed scale down",
            options: { allowSurge: true },
        });
        assert.strictEqual(state.workerStates.get(workers.at(-1).id), "draining");
    });

    it("does not overwrite a newer desired target after scale-down failure", async () => {
        const { ensureCalls, lifecycle, state } = createScalingHarness();
        let rejectRetirement;
        const pendingRetirement = new Promise((_, reject) => {
            rejectRetirement = reject;
        });
        lifecycle.retireWorker = (worker) => {
            state.workerStates.set(worker.id, "draining");
            state.workerRetirementPromises.set(worker.id, pendingRetirement);
            return pendingRetirement;
        };
        const scaling = createScaling(state, lifecycle);

        scaling.tick();
        state.desiredWorkers = 4;
        rejectRetirement(new Error("worker refused to exit"));
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(state.desiredWorkers, 4);
        assert.deepStrictEqual(ensureCalls.at(-1), {
            context: "recover failed scale down",
            options: { allowSurge: true },
        });
    });

    it("does not lower desired capacity while crash restarts are reserved", () => {
        const { desiredTargets, lifecycle, state, workers } = createScalingHarness({
            workerCount: 2,
            maxWorkers: 4,
        });
        state.desiredWorkers = 4;
        state.pendingRestartTimers = new Set([{}, {}]);
        for (const worker of workers) {
            state.workerLoads.set(worker.id, { lag: 100, lastSeen: Date.now() });
        }
        const scaling = createScaling(state, lifecycle);

        scaling.tick();

        assert.strictEqual(state.desiredWorkers, 4);
        assert.deepStrictEqual(desiredTargets, []);
    });

    it("scales up from desired capacity while crash restarts are reserved", () => {
        const { desiredTargets, lifecycle, state, workers } = createScalingHarness({
            workerCount: 1,
            maxWorkers: 4,
        });
        state.desiredWorkers = 3;
        state.pendingRestartTimers = new Set([{}, {}]);
        state.workerLoads.set(workers[0].id, { lag: 100, lastSeen: Date.now() });
        const scaling = createScaling(state, lifecycle);

        scaling.tick();

        assert.strictEqual(state.desiredWorkers, 4);
        assert.deepStrictEqual(desiredTargets, [4]);
    });

    it("does not scale down at max capacity while memory pressure remains high", () => {
        for (const metric of ["memory", "rss"]) {
            const { desiredTargets, lifecycle, state, workers } = createScalingHarness({
                workerCount: 2,
                maxWorkers: 2,
            });
            state.config[metric === "memory" ? "scaleUpMemory" : "scaleUpRss"] = 10;
            for (const worker of workers) {
                state.workerLoads.set(worker.id, {
                    lag: 0,
                    lastSeen: Date.now(),
                    [metric]: 20 * 1024 * 1024,
                });
            }
            let retirements = 0;
            lifecycle.retireWorker = () => {
                ++retirements;
                return Promise.resolve();
            };
            const scaling = createScaling(state, lifecycle);

            scaling.tick();

            assert.strictEqual(retirements, 0, `${metric} pressure must preserve capacity`);
            assert.strictEqual(state.desiredWorkers, 2);
            assert.deepStrictEqual(desiredTargets, []);
        }
    });

    it("retires the least-loaded worker instead of the most recently forked worker", () => {
        const { lifecycle, state, workers } = createScalingHarness();
        state.workerLoads.set(workers[0].id, { lag: 1, lastSeen: Date.now() });
        state.workerLoads.set(workers[1].id, { lag: 8, lastSeen: Date.now() });
        state.workerLoads.set(workers[2].id, { lag: 5, lastSeen: Date.now() });
        let retiredWorker;
        lifecycle.retireWorker = (worker) => {
            retiredWorker = worker;
            return Promise.resolve();
        };
        const scaling = createScaling(state, lifecycle);

        scaling.tick();

        assert.strictEqual(retiredWorker, workers[0]);
        assert.strictEqual(state.desiredWorkers, 2);
    });

    it("does not treat workers without a heartbeat as zero-lag samples", () => {
        const { desiredTargets, lifecycle, state, workers } = createScalingHarness({
            workerCount: 2,
        });
        for (const worker of workers) {
            state.workerLoads.delete(worker.id);
        }
        let retirements = 0;
        lifecycle.retireWorker = () => {
            ++retirements;
            return Promise.resolve();
        };
        const scaling = createScaling(state, lifecycle);

        scaling.tick();

        assert.strictEqual(retirements, 0);
        assert.strictEqual(state.desiredWorkers, 2);
        assert.deepStrictEqual(desiredTargets, []);
    });

    it("does not infer load or health actions from stale telemetry", () => {
        const { ensureCalls, lifecycle, state, workers } = createScalingHarness({
            workerCount: 1,
        });
        state.workerLoads.set(workers[0].id, {
            lag: 1000,
            lastSeen: Date.now() - state.config.heartbeatStaleAfter - 1,
            memory: 1024 * 1024 * 1024,
            rss: 1024 * 1024 * 1024,
        });
        let retirements = 0;
        lifecycle.retireWorker = () => {
            ++retirements;
            return Promise.resolve();
        };
        const scaling = createScaling(state, lifecycle);

        scaling.tick();

        assert.strictEqual(retirements, 0);
        assert.deepStrictEqual(ensureCalls, []);
        assert.strictEqual(state.desiredWorkers, 1);
    });
});
