import { strict as assert } from "node:assert";
import cluster from "node:cluster";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { createLifecycle } from "../src/lifecycle.js";
import { createReload } from "../src/reload.js";
import { runFixtureWithOutput } from "./helpers/fixture-process.js";

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
