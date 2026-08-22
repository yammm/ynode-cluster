import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { createTty } from "../src/tty.js";
import { killFixture, spawnFixture } from "./helpers/fixture-process.js";

function createTtyHarness({ collectWorkerReplies = async () => [] } = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    Object.defineProperty(input, "isTTY", { value: true });
    const errors = [];
    const state = {
        config: { minWorkers: 1, maxWorkers: 1, mode: "smart" },
        log: {
            debug() {},
            info() {},
            warn() {},
            error: (...args) => errors.push(args),
        },
        ttyConfig: {
            enabled: true,
            commands: true,
            reloadCommand: "/rl",
            stdin: input,
            stdout: output,
        },
        masterStartTime: Date.now(),
        desiredWorkers: 1,
        workerStartTimes: new Map(),
        workerLoads: new Map(),
        workerStates: new Map(),
        listeningWorkers: new Set(),
        reloadPromise: null,
        ttyReadline: null,
    };
    const lifecycle = {
        getWorkers: () => [],
        getActiveWorkerCount: () => 0,
        collectWorkerReplies,
    };
    const reload = { reload: async () => {} };
    const tty = createTty(state, lifecycle, reload);
    tty.setup();
    return { errors, input, output, state, tty };
}

describe("TTY Command Mode", () => {
    it("contains input stream errors and disables command mode", () => {
        const { errors, input, state } = createTtyHarness();

        input.emit("error", new Error("input failed"));

        assert.strictEqual(state.ttyReadline, null);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0][0], /TTY input stream failed/);
    });

    it("contains output stream errors and disables command mode", () => {
        const { errors, output, state } = createTtyHarness();

        output.emit("error", new Error("output failed"));

        assert.strictEqual(state.ttyReadline, null);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0][0], /TTY output stream failed/);
    });

    it("observes asynchronous command failures", async () => {
        const { errors, input, state } = createTtyHarness({
            collectWorkerReplies: async () => {
                throw new Error("ping failed");
            },
        });

        input.write("/ping\n");
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(state.ttyReadline, null);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0][0], /TTY command failed/);
    });

    it("removes output error handling when input reaches EOF", async () => {
        const { input, output, state } = createTtyHarness();
        assert.strictEqual(output.listenerCount("error"), 1);

        input.end();
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(state.ttyReadline, null);
        assert.strictEqual(output.listenerCount("error"), 0);
    });

    it("strips control characters from worker-supplied version replies", async () => {
        const { input, output } = createTtyHarness({
            collectWorkerReplies: async () => [
                { pid: 101, appVersion: "1.0.0\x1b[31mred", nodeVersion: "v20.0.0\x07" },
                { pid: 102, appVersion: 42, nodeVersion: null },
            ],
        });

        const chunks = [];
        output.on("data", (chunk) => chunks.push(chunk.toString()));

        input.write("/version\n");
        await new Promise((resolve) => setImmediate(resolve));

        const written = chunks.join("");
        assert.match(written, /Worker 101: 1\.0\.0\[31mred \(node v20\.0\.0\)/);
        assert.match(written, /Worker 102: — \(node/);
        // eslint-disable-next-line no-control-regex
        assert.doesNotMatch(written, /[\x00\x07\x1b\x7f\x9b]/);
    });

    it("should handle reload commands and ignore duplicate reload trigger", async () => {
        await new Promise((resolve, reject) => {
            const child = spawnFixture("tty-app.js", {
                stdio: ["pipe", "pipe", "pipe", "ipc"],
                env: { TEST_STDIN_IS_TTY: "1" },
            });

            let output = "";
            let settled = false;
            let commandsSent = false;
            let exitRequested = false;

            const finish = (fn) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                try {
                    child.stdout?.removeAllListeners();
                    child.stderr?.removeAllListeners();
                    child.removeAllListeners();
                } catch (err) {
                    console.debug(err);
                }
                fn();
            };

            const safeSend = (payload) => {
                try {
                    child.send(payload);
                } catch (err) {
                    console.debug(err);
                }
            };

            const maybeDrive = () => {
                if (
                    !commandsSent &&
                    output.includes("TTY command mode enabled. Type '/rl' to reload workers.")
                ) {
                    commandsSent = true;
                    safeSend({ cmd: "send", line: "help" });
                    safeSend({ cmd: "send", line: "/rl" });
                    safeSend({ cmd: "send", line: "/rl" });
                }

                if (
                    commandsSent &&
                    !exitRequested &&
                    output.includes("TTY: reload command received.") &&
                    output.includes("TTY: reload already in progress.") &&
                    output.includes("TTY_OUT:TTY commands: /rl") &&
                    output.includes("EVENT:reload_end")
                ) {
                    exitRequested = true;
                    safeSend({ cmd: "exit" });
                }
            };

            const timeout = setTimeout(() => {
                finish(() => {
                    try {
                        killFixture(child);
                    } catch (err) {
                        console.debug(err);
                    }
                    reject(new Error("Timeout waiting for TTY command flow. Output:\n" + output));
                });
            }, 15000).unref();

            child.stdout.on("data", (data) => {
                output += data.toString();
                maybeDrive();
            });

            child.stderr.on("data", (data) => {
                output += data.toString();
                maybeDrive();
            });

            child.on("close", (code) => {
                finish(() => {
                    try {
                        assert.equal(code, 0, `Expected clean exit.\nOutput:\n${output}`);
                        assert.match(
                            output,
                            /TTY command mode enabled\. Type '\/rl' to reload workers\./,
                        );
                        assert.match(output, /TTY: reload command received\./);
                        assert.match(output, /TTY: reload already in progress\./);
                        assert.match(output, /TTY_OUT:TTY commands: \/rl/);

                        const reloadStarts = output.match(/EVENT:reload_start/g)?.length ?? 0;
                        assert.equal(
                            reloadStarts,
                            1,
                            `Expected one reload start event.\nOutput:\n${output}`,
                        );
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            child.on("error", (err) => {
                finish(() => reject(err));
            });
        });
    });

    it("should answer ping and version through the built-in worker responder", async () => {
        await new Promise((resolve, reject) => {
            const child = spawnFixture("tty-app.js", {
                stdio: ["pipe", "pipe", "pipe", "ipc"],
                env: { TEST_STDIN_IS_TTY: "1" },
            });

            let output = "";
            let settled = false;
            let commandsSent = false;
            let exitRequested = false;

            const finish = (fn) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                try {
                    child.stdout?.removeAllListeners();
                    child.stderr?.removeAllListeners();
                    child.removeAllListeners();
                } catch (err) {
                    console.debug(err);
                }
                fn();
            };

            const safeSend = (payload) => {
                try {
                    child.send(payload);
                } catch (err) {
                    console.debug(err);
                }
            };

            const maybeDrive = () => {
                if (
                    !commandsSent &&
                    output.includes("TTY command mode enabled. Type '/rl' to reload workers.")
                ) {
                    commandsSent = true;
                    safeSend({ cmd: "send", line: "/ping" });
                    safeSend({ cmd: "send", line: "/version" });
                }

                if (
                    commandsSent &&
                    !exitRequested &&
                    /TTY_OUT: {2}Worker \d+: pong/.test(output) &&
                    /TTY_OUT: {2}Worker \d+: .+ \(node v/.test(output)
                ) {
                    exitRequested = true;
                    safeSend({ cmd: "exit" });
                }
            };

            const timeout = setTimeout(() => {
                finish(() => {
                    try {
                        killFixture(child);
                    } catch (err) {
                        console.debug(err);
                    }
                    reject(
                        new Error("Timeout waiting for ping/version replies. Output:\n" + output),
                    );
                });
            }, 15000).unref();

            child.stdout.on("data", (data) => {
                output += data.toString();
                maybeDrive();
            });

            child.stderr.on("data", (data) => {
                output += data.toString();
                maybeDrive();
            });

            child.on("close", (code) => {
                finish(() => {
                    try {
                        assert.equal(code, 0, `Expected clean exit.\nOutput:\n${output}`);
                        assert.match(output, /TTY_OUT: {2}Worker \d+: pong/);
                        assert.match(output, /TTY_OUT:Master: node v/);
                        assert.match(output, /TTY_OUT: {2}Worker \d+: .+ \(node v/);
                        assert.doesNotMatch(output, /did not respond/);
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            child.on("error", (err) => {
                finish(() => reject(err));
            });
        });
    });

    it("should skip command mode when stdin is non-TTY", async () => {
        await new Promise((resolve, reject) => {
            const child = spawnFixture("tty-app.js", {
                stdio: ["pipe", "pipe", "pipe", "ipc"],
                env: { TEST_STDIN_IS_TTY: "0" },
            });

            let output = "";
            let settled = false;
            let exitRequested = false;

            const finish = (fn) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                try {
                    child.stdout?.removeAllListeners();
                    child.stderr?.removeAllListeners();
                    child.removeAllListeners();
                } catch (err) {
                    console.debug(err);
                }
                fn();
            };

            const timeout = setTimeout(() => {
                finish(() => {
                    try {
                        killFixture(child);
                    } catch (err) {
                        console.debug(err);
                    }
                    reject(new Error("Timeout waiting for non-TTY TTY flow. Output:\n" + output));
                });
            }, 10000).unref();

            child.stdout.on("data", (data) => {
                output += data.toString();
                if (
                    !exitRequested &&
                    output.includes("TTY command mode skipped (non-TTY stdin).")
                ) {
                    exitRequested = true;
                    child.send({ cmd: "exit" });
                }
            });

            child.stderr.on("data", (data) => {
                output += data.toString();
            });

            child.on("close", (code) => {
                finish(() => {
                    try {
                        assert.equal(code, 0, `Expected clean exit.\nOutput:\n${output}`);
                        assert.match(output, /TTY command mode skipped \(non-TTY stdin\)\./);
                        assert.doesNotMatch(output, /TTY command mode enabled/);
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            child.on("error", (err) => {
                finish(() => reject(err));
            });
        });
    });
});
