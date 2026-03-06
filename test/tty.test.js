import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawnFixture } from "./helpers/fixture-process.js";

describe("TTY Command Mode", () => {
    it("should handle reload commands and ignore duplicate reload trigger", async () => {
        await new Promise((resolve, reject) => {
            const child = spawnFixture("tty_app.js", {
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
                    output.includes("TTY command mode enabled. Type 'rl' to reload workers.")
                ) {
                    commandsSent = true;
                    safeSend({ cmd: "send", line: "help" });
                    safeSend({ cmd: "send", line: "rl" });
                    safeSend({ cmd: "send", line: "rl" });
                }

                if (
                    commandsSent &&
                    !exitRequested &&
                    output.includes("TTY: reload command received.") &&
                    output.includes("TTY: reload already in progress.") &&
                    output.includes("TTY_OUT:TTY commands: rl") &&
                    output.includes("EVENT:reload_end")
                ) {
                    exitRequested = true;
                    safeSend({ cmd: "exit" });
                }
            };

            const timeout = setTimeout(() => {
                finish(() => {
                    try {
                        child.kill("SIGKILL");
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
                            /TTY command mode enabled\. Type 'rl' to reload workers\./,
                        );
                        assert.match(output, /TTY: reload command received\./);
                        assert.match(output, /TTY: reload already in progress\./);
                        assert.match(output, /TTY_OUT:TTY commands: rl/);

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

    it("should skip command mode when stdin is non-TTY", async () => {
        await new Promise((resolve, reject) => {
            const child = spawnFixture("tty_app.js", {
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
                        child.kill("SIGKILL");
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
