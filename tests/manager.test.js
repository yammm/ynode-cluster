import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { createManager } from "../src/manager.js";

function createHarness({ workerCount = 2, desiredWorkers = workerCount } = {}) {
    const workers = Array.from({ length: workerCount }, (_, index) => ({
        id: index + 1,
        process: { pid: 30000 + index },
    }));
    const events = new EventEmitter();
    const state = {
        config: {
            maxWorkers: 4,
            minWorkers: 1,
            scaleUpThreshold: 50,
            scaleDownThreshold: 10,
            heartbeatStaleAfter: 10_000,
            mode: "smart",
            reloadListeningTimeout: 100,
            reloadOnlineTimeout: 100,
        },
        events,
        desiredWorkers,
        isShuttingDown: false,
        workerLoads: new Map(),
        workerStartTimes: new Map(),
        listeningWorkers: new Set(),
        workerStates: new Map(workers.map((worker) => [worker.id, "starting"])),
    };
    const lifecycle = {
        getWorkers: () => workers,
        getWorkerCount: () => workers.length,
        getActiveWorkerCount: () =>
            workers.filter((worker) => state.workerStates.get(worker.id) !== "draining").length,
    };
    const manager = createManager(
        state,
        lifecycle,
        { reload: async () => {} },
        { closeCluster: async () => {} },
    );
    return { events, manager, state, workers };
}

function listenerCounts(events) {
    return {
        online: events.listenerCount("worker_online"),
        listening: events.listenerCount("worker_listening"),
        shutdown: events.listenerCount("shutdown_start"),
    };
}

describe("Cluster manager waitForCapacity", () => {
    it("validates options synchronously with stable errors", () => {
        const { manager } = createHarness();

        assert.throws(() => manager.waitForCapacity(null), {
            name: "TypeError",
            message: "waitForCapacity options must be an object",
        });
        assert.throws(() => manager.waitForCapacity({ state: "ready" }), {
            name: "TypeError",
            message: 'waitForCapacity state must be "online" or "listening"',
        });
        assert.throws(() => manager.waitForCapacity({ readyState: "listening" }), {
            name: "TypeError",
            message: "waitForCapacity received unknown option: readyState",
        });
        assert.throws(() => manager.waitForCapacity({ count: 0 }), {
            name: "RangeError",
            message: "waitForCapacity count must be an integer between 1 and 4",
        });
        assert.throws(() => manager.waitForCapacity({ count: 5 }), {
            name: "RangeError",
            message: "waitForCapacity count must be an integer between 1 and 4",
        });
        assert.throws(() => manager.waitForCapacity({ timeoutMs: Number.NaN }), {
            name: "RangeError",
            message: "waitForCapacity timeoutMs must be a non-negative finite number",
        });
        assert.throws(() => manager.waitForCapacity({ signal: {} }), {
            name: "TypeError",
            message: "waitForCapacity signal must be an AbortSignal",
        });
    });

    it("resolves immediately when online capacity is already satisfied", async () => {
        const { events, manager, state, workers } = createHarness();
        state.workerStates.set(workers[0].id, "online");
        state.workerStates.set(workers[1].id, "listening");
        state.listeningWorkers.add(workers[1].id);

        const metrics = await manager.waitForCapacity({ state: "online" });

        assert.equal(metrics.workerCount, 2);
        assert.deepEqual(listenerCounts(events), { online: 0, listening: 0, shutdown: 0 });
    });

    it("defaults to desired listening capacity and resolves from lifecycle events", async () => {
        const { events, manager, state, workers } = createHarness();
        state.workerStates.set(workers[0].id, "online");
        state.workerStates.set(workers[1].id, "online");

        const waiting = manager.waitForCapacity();
        assert.deepEqual(listenerCounts(events), { online: 1, listening: 1, shutdown: 1 });

        state.workerStates.set(workers[0].id, "listening");
        state.listeningWorkers.add(workers[0].id);
        events.emit("worker_listening", { id: workers[0].id });

        state.workerStates.set(workers[1].id, "listening");
        state.listeningWorkers.add(workers[1].id);
        events.emit("worker_listening", { id: workers[1].id });

        const metrics = await waiting;
        assert.equal(metrics.workers.filter((worker) => worker.listening).length, 2);
        assert.deepEqual(listenerCounts(events), { online: 0, listening: 0, shutdown: 0 });
    });

    it("times out with a stable code and removes every listener", async () => {
        const { events, manager } = createHarness();

        await assert.rejects(manager.waitForCapacity({ timeoutMs: 10 }), {
            code: "CLUSTER_WAIT_TIMEOUT",
            message: "Timed out after 10ms waiting for 2 listening worker(s)",
        });
        assert.deepEqual(listenerCounts(events), { online: 0, listening: 0, shutdown: 0 });
    });

    it("supports an indefinite wait that can be aborted", async () => {
        const { events, manager } = createHarness();
        const controller = new AbortController();
        const reason = new Error("deployment cancelled");
        const waiting = manager.waitForCapacity({ timeoutMs: 0, signal: controller.signal });

        controller.abort(reason);

        await assert.rejects(waiting, (error) => {
            assert.equal(error.name, "AbortError");
            assert.equal(error.code, "CLUSTER_WAIT_ABORTED");
            assert.equal(error.cause, reason);
            return true;
        });
        assert.deepEqual(listenerCounts(events), { online: 0, listening: 0, shutdown: 0 });

        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        await assert.rejects(
            manager.waitForCapacity({ signal: alreadyAborted.signal }),
            (error) => error.name === "AbortError" && error.code === "CLUSTER_WAIT_ABORTED",
        );
        assert.deepEqual(listenerCounts(events), { online: 0, listening: 0, shutdown: 0 });
    });

    it("rejects an existing or newly-started shutdown and cleans up", async () => {
        const existing = createHarness();
        existing.state.isShuttingDown = true;
        await assert.rejects(existing.manager.waitForCapacity(), {
            code: "CLUSTER_SHUTTING_DOWN",
        });

        const active = createHarness();
        const waiting = active.manager.waitForCapacity({ timeoutMs: 0 });
        active.state.isShuttingDown = true;
        active.events.emit("shutdown_start", { signal: null });

        await assert.rejects(waiting, { code: "CLUSTER_SHUTTING_DOWN" });
        assert.deepEqual(listenerCounts(active.events), {
            online: 0,
            listening: 0,
            shutdown: 0,
        });
    });
});
