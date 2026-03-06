import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { join } from "node:path";

describe("Cluster Manager Features", () => {
    it("should dedupe concurrent reload calls and expose lifecycle events", async () => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "features_app.js");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: "pipe",
                env: { ...process.env },
            });

            let output = "";
            let settled = false;
            let exerciseSent = false;

            const cleanup = (signal = "SIGTERM") => {
                clearTimeout(timeout);
                try {
                    child.kill(signal);
                } catch (err) {
                    console.debug(err);
                }
            };

            child.stdout.on("data", (data) => {
                const str = data.toString();
                output += str;

                if (!exerciseSent && output.includes("EVENT:worker_online:1")) {
                    exerciseSent = true;
                    child.stdin.write("exercise\n");
                }
            });

            child.stderr.on("data", (data) => {
                output += data.toString();
            });

            child.on("close", (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);

                try {
                    assert.equal(code, 0, `Expected exit code 0.\nOutput:\n${output}`);
                    assert.match(output, /RELOAD_DONE/);
                    assert.match(output, /CLOSE_DONE/);
                    assert.match(output, /EVENT:reload_start:1/);
                    assert.match(output, /EVENT:reload_end:1/);
                    assert.match(output, /EVENT:shutdown_start:1/);
                    assert.match(output, /EVENT:shutdown_end:1/);

                    const reloadStarts =
                        output.match(/Starting zero-downtime cluster reload\.\.\./g)?.length ?? 0;
                    assert.equal(
                        reloadStarts,
                        1,
                        `Expected one reload execution despite two calls.\nOutput:\n${output}`,
                    );
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });

            const timeout = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup("SIGKILL");
                reject(new Error("Timeout waiting for feature fixture. Output:\n" + output));
            }, 10000).unref();
        });
    });

    it("should validate reload timeout options", async () => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "invalid_reload_timeout_app.js");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: "pipe",
                env: { ...process.env },
            });

            let output = "";
            let settled = false;
            const cleanup = (signal = "SIGTERM") => {
                clearTimeout(timeout);
                try {
                    child.kill(signal);
                } catch (err) {
                    console.debug(err);
                }
            };

            child.stdout.on("data", (data) => {
                output += data.toString();
            });

            child.stderr.on("data", (data) => {
                output += data.toString();
            });

            child.on("close", (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);

                try {
                    assert.notEqual(code, 0, `Expected non-zero exit for invalid config.\nOutput:\n${output}`);
                    assert.match(output, /Invalid configuration: reloadOnlineTimeout/);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });

            const timeout = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup("SIGKILL");
                reject(new Error("Timeout waiting for invalid reload timeout fixture. Output:\n" + output));
            }, 5000).unref();
        });
    });

    it("should dedupe concurrent reload failures and reject both callers", async () => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "reload_fail_dedupe_app.js");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: "pipe",
                env: { ...process.env },
            });

            let output = "";
            let settled = false;
            let exerciseSent = false;

            const cleanup = (signal = "SIGTERM") => {
                clearTimeout(timeout);
                try {
                    child.kill(signal);
                } catch (err) {
                    console.debug(err);
                }
            };

            child.stdout.on("data", (data) => {
                const str = data.toString();
                output += str;
                if (!exerciseSent && output.includes(" is online")) {
                    exerciseSent = true;
                    child.stdin.write("exercise\n");
                }
            });

            child.stderr.on("data", (data) => {
                output += data.toString();
            });

            child.on("close", (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);

                try {
                    assert.equal(code, 0, `Expected exit code 0.\nOutput:\n${output}`);
                    assert.match(output, /RELOAD_RESULTS:rejected,rejected/);
                    assert.match(output, /RELOAD_ERROR_A:/);
                    assert.match(output, /RELOAD_ERROR_B:/);

                    const errorA = output.match(/RELOAD_ERROR_A:(.+)/)?.[1]?.trim();
                    const errorB = output.match(/RELOAD_ERROR_B:(.+)/)?.[1]?.trim();
                    assert.equal(
                        errorA,
                        errorB,
                        `Expected both callers to receive the same rejection message.\nOutput:\n${output}`,
                    );

                    const reloadStarts =
                        output.match(/Starting zero-downtime cluster reload\.\.\./g)?.length ?? 0;
                    assert.equal(
                        reloadStarts,
                        1,
                        `Expected one reload execution despite two failing calls.\nOutput:\n${output}`,
                    );
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });

            const timeout = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup("SIGKILL");
                reject(new Error("Timeout waiting for reload failure dedupe fixture. Output:\n" + output));
            }, 10000).unref();
        });
    });
});
