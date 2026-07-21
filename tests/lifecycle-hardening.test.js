import { strict as assert } from "node:assert";
import cluster from "node:cluster";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { createLifecycle } from "../src/lifecycle.js";
import { createReload } from "../src/reload.js";
import { createShutdown } from "../src/shutdown.js";
import { runFixtureWithOutput } from "./helpers/fixture-process.js";

function createFakeWorker(id, pid = 10000 + id) {
    const worker = new EventEmitter();
    worker.id = id;
    worker.process = { pid };
    worker.isConnected = () => true;
    worker.isDead = () => false;
    worker.send = (_payload, callback) => callback?.();
    worker.kill = () => {};
    return worker;
}

function installClusterWorkers(t, workers, fork) {
    const originalFork = cluster.fork;
    const originalWorkers = { ...cluster.workers };
    for (const id of Object.keys(cluster.workers)) {
        delete cluster.workers[id];
    }
    for (const worker of workers) {
        cluster.workers[worker.id] = worker;
    }
    if (fork) {
        cluster.fork = fork;
    }

    t.after(() => {
        cluster.fork = originalFork;
        for (const id of Object.keys(cluster.workers)) {
            delete cluster.workers[id];
        }
        Object.assign(cluster.workers, originalWorkers);
    });
}

function createLifecycleState({
    desiredWorkers = 1,
    maxWorkers = 2,
    maxWorkerMemory = 0,
    maxWorkerRss = 0,
} = {}) {
    return {
        config: {
            maxWorkers,
            minWorkers: 1,
            mode: "smart",
            norestart: false,
            shutdownTimeout: 100,
            maxWorkerMemory,
            maxWorkerRss,
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        events: new EventEmitter(),
        desiredWorkers,
        isShuttingDown: false,
        workerLoads: new Map(),
        workerStartTimes: new Map(),
        workerMessageHandlers: new Map(),
        listeningWorkers: new Set(),
        workerStates: new Map(),
        workerRetirements: new Map(),
        workerRetirementPromises: new Map(),
        workersWithErrorHandler: new WeakSet(),
        pendingRestartTimers: new Set(),
    };
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        if (err?.code === "ESRCH") {
            return false;
        }
        throw err;
    }
}

async function waitForProcessesToExit(pids, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pids.every((pid) => !isProcessAlive(pid))) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepStrictEqual(
        pids.filter(isProcessAlive),
        [],
        "Expected every cluster worker process to exit",
    );
}

describe("Lifecycle hardening", () => {
    it("allows a reload surge while another worker is draining", (t) => {
        const first = createFakeWorker(9101);
        const second = createFakeWorker(9102);
        const draining = createFakeWorker(9103);
        const replacement = createFakeWorker(9104);
        installClusterWorkers(t, [first, second, draining], () => {
            cluster.workers[replacement.id] = replacement;
            return replacement;
        });

        const state = createLifecycleState({ desiredWorkers: 2, maxWorkers: 2 });
        state.workerStates.set(first.id, "listening");
        state.workerStates.set(second.id, "listening");
        state.workerStates.set(draining.id, "draining");
        const lifecycle = createLifecycle(state);

        const forked = lifecycle.forkWorker("spawn replacement worker", { allowSurge: true });

        assert.strictEqual(forked, replacement);
        assert.strictEqual(state.workerStates.get(replacement.id), "starting");
        assert.strictEqual(lifecycle.getActiveWorkerCount(), 3);
        assert.strictEqual(lifecycle.getWorkerCount(), 4);
    });

    it("treats pending restart timers as reserved worker capacity", (t) => {
        const active = createFakeWorker(9201);
        let nextId = 9202;
        let forks = 0;
        installClusterWorkers(t, [active], () => {
            const worker = createFakeWorker(nextId++);
            cluster.workers[worker.id] = worker;
            ++forks;
            return worker;
        });

        const state = createLifecycleState({ desiredWorkers: 2, maxWorkers: 2 });
        state.workerStates.set(active.id, "listening");
        const reservation = {};
        state.pendingRestartTimers.add(reservation);
        const lifecycle = createLifecycle(state);

        const reservedWorkers = lifecycle.ensureDesiredCapacity("reconcile during restart backoff");

        assert.strictEqual(reservedWorkers.length, 0);
        assert.strictEqual(forks, 0);

        state.pendingRestartTimers.delete(reservation);
        const restartedWorkers = lifecycle.ensureDesiredCapacity("restart worker");

        assert.strictEqual(restartedWorkers.length, 1);
        assert.strictEqual(forks, 1);
        assert.strictEqual(lifecycle.getActiveWorkerCount(), 2);
    });

    it("keeps master-attributed identity on worker IPC replies", async (t) => {
        const worker = createFakeWorker(9301, 19301);
        worker.send = (payload, callback) => {
            callback?.();
            setImmediate(() => {
                worker.emit("message", { cmd: payload.cmd, pid: 1, id: 9999 });
            });
        };
        installClusterWorkers(t, [worker]);
        const lifecycle = createLifecycle(createLifecycleState());

        const replies = await lifecycle.collectWorkerReplies("ping", 100);

        assert.strictEqual(replies.length, 1);
        assert.strictEqual(replies[0].pid, worker.process.pid);
        assert.strictEqual(replies[0].id, worker.id);
    });

    it("retires only one memory-limit offender at a time", async (t) => {
        const first = createFakeWorker(9351, 19351);
        const second = createFakeWorker(9352, 19352);
        installClusterWorkers(t, [first, second]);
        const state = createLifecycleState({
            desiredWorkers: 2,
            maxWorkers: 2,
            maxWorkerMemory: 1,
        });
        const lifecycle = createLifecycle(state);
        lifecycle.attachClusterEvents();
        t.after(lifecycle.removeClusterEvents);
        cluster.emit("online", first);
        cluster.emit("online", second);

        const heartbeat = {
            cmd: "heartbeat",
            lag: 0,
            memory: { heapUsed: 2 * 1024 * 1024 },
        };
        first.emit("message", heartbeat);
        second.emit("message", heartbeat);

        assert.strictEqual(state.workerStates.get(first.id), "draining");
        assert.strictEqual(state.workerStates.get(second.id), "online");
        assert.strictEqual(state.workerRetirementPromises.size, 1);

        first.emit("exit", 0, null);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(state.workerRetirementPromises.size, 0);

        second.emit("message", heartbeat);
        assert.strictEqual(state.workerStates.get(second.id), "draining");
        second.emit("exit", 0, null);
        await new Promise((resolve) => setImmediate(resolve));
    });

    it("lets the first signal join a programmatic close", async (t) => {
        const worker = createFakeWorker(9401, 19401);
        const killSignals = [];
        worker.kill = (signal) => killSignals.push(signal);
        let workers = [worker];
        let resolveRetirement;
        const retirement = new Promise((resolve) => {
            resolveRetirement = resolve;
        });
        const exitCodes = [];
        const originalExit = process.exit;
        process.exit = (code) => exitCodes.push(code);
        t.after(() => {
            process.exit = originalExit;
        });

        const state = {
            config: { shutdownSignals: ["SIGTERM"], shutdownTimeout: 100 },
            log: { debug() {}, info() {}, warn() {}, error() {} },
            isShuttingDown: false,
            closePromise: null,
            reloadAbortController: null,
            reloadPromise: null,
            signalHandlers: new Map(),
            workerStates: new Map(),
            workerRetirements: new Map(),
        };
        const lifecycle = {
            getWorkers: () => workers,
            getWorkerCount: () => workers.length,
            getActiveWorkerCount: () => workers.length,
            retireWorker: () => retirement,
            removeClusterEvents() {},
            emitLifecycle() {},
        };
        const shutdown = createShutdown(state, lifecycle);
        shutdown.attachSignalHandlers();
        t.after(shutdown.removeSignalHandlers);

        const closePromise = shutdown.closeCluster();
        state.signalHandlers.get("SIGTERM")();

        assert.deepStrictEqual(killSignals, []);
        assert.deepStrictEqual(exitCodes, []);

        workers = [];
        resolveRetirement({ forced: false, phase: "graceful" });
        await closePromise;
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepStrictEqual(killSignals, []);
        assert.deepStrictEqual(exitCodes, [0]);
    });

    it("reduces desired smart-pool capacity after a voluntary exit above the floor", async () => {
        const { code, output } = await runFixtureWithOutput("voluntary-scale-down-app.js", {
            timeoutMs: 5000,
        });

        assert.equal(code, 0, `Expected a clean voluntary scale-down.\n${output}`);
        assert.match(output, /VOLUNTARY_SCALE_DOWN:1:1:1/);
        assert.doesNotMatch(output, /Restarting in \d+ms/);
    });

    it("restores minWorkers after a voluntary worker disconnect", async () => {
        const { code, output } = await runFixtureWithOutput("voluntary-floor-app.js", {
            timeoutMs: 5000,
        });

        assert.equal(code, 0, `Expected a clean programmatic shutdown.\n${output}`);
        assert.match(output, /FLOOR_RESTORED:\d+:1:1:1/);
        assert.doesNotMatch(output, /: 0 of 2\] disconnected voluntarily[\s\S]*No active workers/);
    });

    it("restores maxWorkers after a voluntary disconnect in max mode", async () => {
        const { code, output } = await runFixtureWithOutput("voluntary-floor-app.js", {
            timeoutMs: 5000,
            env: { CLUSTER_TEST_MODE: "max" },
        });

        assert.equal(code, 0, `Expected a clean programmatic shutdown.\n${output}`);
        assert.match(output, /FLOOR_RESTORED:\d+:2:2:2/);
    });

    it("does not restore desired capacity when norestart is enabled", async () => {
        const { code, output } = await runFixtureWithOutput("norestart-capacity-app.js", {
            timeoutMs: 5000,
        });

        assert.equal(code, 0, `Expected a clean programmatic shutdown.\n${output}`);
        assert.match(output, /NORESTART_CAPACITY:1:1:2:false/);
    });

    it("reaps a worker that ignores graceful shutdown and SIGTERM", async () => {
        let signalSent = false;
        let workerPid;
        const { code, output } = await runFixtureWithOutput("hung-shutdown-app.js", {
            timeoutMs: 5000,
            onStdout: (_chunk, child, currentOutput) => {
                const match = currentOutput.match(/HUNG_WORKER_PID:(\d+)/);
                if (!workerPid && match) {
                    workerPid = Number(match[1]);
                }
                if (workerPid && !signalSent) {
                    signalSent = true;
                    child.kill("SIGTERM");
                }
            },
        });

        assert.equal(code, 0, `Expected forced worker retirement to complete.\n${output}`);
        assert.match(output, /IGNORED_SHUTDOWN:/);
        assert.match(output, /IGNORED_SIGTERM:/);
        assert.match(output, /sending SIGKILL/);
        assert.ok(Number.isInteger(workerPid), `Expected a worker PID.\n${output}`);
        await waitForProcessesToExit([workerPid]);
    });

    it("uses a repeated shutdown signal for immediate escalation", async () => {
        let signalSent = false;
        let workerPid;
        const startedAt = Date.now();
        const { code, output } = await runFixtureWithOutput("hung-shutdown-app.js", {
            timeoutMs: 5000,
            onStdout: (_chunk, child, currentOutput) => {
                const match = currentOutput.match(/HUNG_WORKER_PID:(\d+)/);
                if (!workerPid && match) {
                    workerPid = Number(match[1]);
                }
                if (workerPid && !signalSent) {
                    signalSent = true;
                    child.kill("SIGTERM");
                    setTimeout(() => child.kill("SIGTERM"), 50).unref();
                }
            },
        });

        assert.equal(code, 1, `Expected forced shutdown to report a non-zero exit.\n${output}`);
        assert.match(output, /received SIGTERM again; forcing immediate shutdown/);
        assert.ok(Date.now() - startedAt < 1500, "Second signal should bypass graceful timeouts");
        assert.ok(Number.isInteger(workerPid), `Expected a worker PID.\n${output}`);
        await waitForProcessesToExit([workerPid]);
    });

    it("cancels an active reload before shutting down the process tree", async () => {
        const workerPids = new Set();
        let reloadSent = false;
        let shutdownSent = false;
        const { code, output } = await runFixtureWithOutput("reload-shutdown-app.js", {
            timeoutMs: 5000,
            onStdout: (chunk, child, currentOutput) => {
                for (const match of currentOutput.matchAll(/RELOAD_WORKER_PID:(\d+)/g)) {
                    workerPids.add(Number(match[1]));
                }
                if (!reloadSent && workerPids.size >= 2) {
                    reloadSent = true;
                    child.stdin.write("reload\n");
                }
                if (!shutdownSent && chunk.includes("RELOAD_STARTED")) {
                    shutdownSent = true;
                    child.kill("SIGTERM");
                }
            },
        });

        assert.equal(code, 0, `Expected reload cancellation to shut down cleanly.\n${output}`);
        assert.match(output, /RELOAD_STARTED/);
        assert.doesNotMatch(output, /Cluster reload complete/);
        assert.doesNotMatch(output, /Restarting in \d+ms/);
        await waitForProcessesToExit([...workerPids]);
    });

    it("fails immediately when an online replacement exits before listening", async () => {
        const oldWorker = new EventEmitter();
        oldWorker.id = 9001;
        oldWorker.process = { pid: 19001 };
        oldWorker.isConnected = () => true;
        oldWorker.isDead = () => false;

        const replacement = new EventEmitter();
        replacement.id = 9002;
        replacement.process = { pid: 19002 };
        replacement.isConnected = () => true;
        replacement.isDead = () => false;

        const retiredWorkers = [];
        const state = {
            config: {
                reloadOnlineTimeout: 5000,
                reloadListeningTimeout: 5000,
                reloadDisconnectWait: 5000,
            },
            log: { info() {}, warn() {}, error() {}, debug() {} },
            isShuttingDown: false,
            listeningWorkers: new Set([oldWorker.id]),
            reloadPromise: null,
            reloadAbortController: null,
        };
        const lifecycle = {
            getActiveWorkers: () => [oldWorker],
            getActiveWorkerCount: () => 1,
            forkWorker: () => {
                setImmediate(() => {
                    replacement.emit("online");
                    setImmediate(() => replacement.emit("exit", 1, null));
                });
                return replacement;
            },
            attachWorkerErrorHandler() {},
            retireWorker: async (worker) => retiredWorkers.push(worker),
            emitLifecycle() {},
        };

        cluster.workers[oldWorker.id] = oldWorker;
        try {
            const reload = createReload(state, lifecycle);
            const startedAt = Date.now();
            await assert.rejects(reload.reload(), /exited before listening/);
            assert.ok(Date.now() - startedAt < 1000, "Readiness failure should reject promptly");
            assert.deepStrictEqual(retiredWorkers, [replacement]);
        } finally {
            delete cluster.workers[oldWorker.id];
        }
    });

    it("reports reload failure instead of completion when old worker retirement times out", async (t) => {
        const oldWorker = createFakeWorker(9601, 19601);
        const replacement = createFakeWorker(9602, 19602);
        installClusterWorkers(t, [oldWorker]);

        const emittedEvents = [];
        const state = {
            config: {
                reloadOnlineTimeout: 5000,
                reloadListeningTimeout: 5000,
                reloadDisconnectWait: 10,
            },
            log: { info() {}, warn() {}, error() {}, debug() {} },
            isShuttingDown: false,
            listeningWorkers: new Set([oldWorker.id]),
            reloadPromise: null,
            reloadAbortController: null,
        };
        const lifecycle = {
            getActiveWorkers: () => [oldWorker],
            getActiveWorkerCount: () => 1,
            forkWorker: () => {
                cluster.workers[replacement.id] = replacement;
                setImmediate(() => {
                    replacement.emit("online");
                    setImmediate(() => cluster.emit("listening", replacement));
                });
                return replacement;
            },
            attachWorkerErrorHandler() {},
            retireWorker: async (worker) => {
                if (worker === oldWorker) {
                    throw new Error("old worker refused to exit");
                }
            },
            emitLifecycle: (type, payload) => emittedEvents.push({ type, payload }),
        };

        const reload = createReload(state, lifecycle);

        await assert.rejects(reload.reload(), /old worker refused to exit/);
        assert.deepStrictEqual(
            emittedEvents.map((event) => event.type),
            ["reload_start", "reload_fail"],
        );
    });

    it("does not mutate an Error supplied when cancelling reload", async () => {
        const state = {
            config: {
                reloadOnlineTimeout: 5000,
                reloadListeningTimeout: 5000,
                reloadDisconnectWait: 5000,
            },
            log: { info() {}, warn() {}, error() {}, debug() {} },
            isShuttingDown: false,
            listeningWorkers: new Set(),
            reloadPromise: null,
            reloadAbortController: null,
        };
        const lifecycle = {
            getActiveWorkers: () => [createFakeWorker(9501, 19501)],
            getActiveWorkerCount: () => 1,
            emitLifecycle() {},
        };
        const reload = createReload(state, lifecycle);
        const reason = new Error("operator cancelled reload");

        const reloadPromise = reload.reload();
        reload.cancel(reason);

        await assert.rejects(
            reloadPromise,
            (err) => err.name === "AbortError" && err.cause === reason,
        );
        assert.strictEqual(reason.name, "Error");
    });

    it("isolates synchronous and asynchronous lifecycle listener failures", async () => {
        const errors = [];
        const state = {
            config: { maxWorkers: 1, minWorkers: 1, mode: "smart", norestart: false },
            log: {
                debug() {},
                info() {},
                warn() {},
                error: (...args) => errors.push(args),
            },
            events: new EventEmitter(),
            desiredWorkers: 1,
            workerStates: new Map(),
            workerRetirements: new Map(),
            workerRetirementPromises: new Map(),
            workersWithErrorHandler: new WeakSet(),
        };
        const lifecycle = createLifecycle(state);
        state.events.on("reload_start", () => {
            throw new Error("sync listener failure");
        });
        state.events.on("reload_start", async () => {
            throw new Error("async listener failure");
        });

        assert.doesNotThrow(() => lifecycle.emitLifecycle("reload_start"));
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(errors.length, 2);
        assert.match(errors[0][0], /lifecycle listener for reload_start failed/);
        assert.match(errors[1][0], /Async cluster lifecycle listener for reload_start failed/);
    });
});
