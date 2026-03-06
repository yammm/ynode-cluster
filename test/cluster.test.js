import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { join } from "node:path";

describe("Cluster Integration", () => {
    it("should start master and workers", async (t) => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "app.js");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: "pipe",
                env: { ...process.env },
            });

            let output = "";
            let workerCount = 0;
            let resolved = false;

            const cleanup = () => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                try {
                    child.stdout?.removeAllListeners();
                    child.stderr?.removeAllListeners();
                    child.removeAllListeners();
                    child.kill("SIGKILL");
                } catch (err) {
                    /* ignore */
                    console.debug(err);
                }
            };

            const timeout = setTimeout(() => {
                if (resolved) {
                    return;
                }
                cleanup();
                reject(new Error("Test timed out waiting for output. Output:\n" + output));
            }, 10000).unref();

            child.stdout.on("data", (data) => {
                const str = data.toString();
                output += str;

                // Count worker online occurrences
                const matches = output.match(/Worker .*?\d+.*? is online/g);
                if (matches) {
                    workerCount = matches.length;
                }

                // Check for expected output
                if (!resolved && output.includes("Shogun is the master!") && workerCount >= 2) {
                    resolved = true;
                    cleanup();
                    resolve();
                }
            });

            child.on("close", (code) => {
                if (resolved) {
                    return;
                }

                // If closed unexpectedly
                cleanup();
                // We could check matches one last time here, but usually success happens in stdout
                // If we got here without resolving, it's likely a failure or premature exit
                try {
                    assert.match(output, /Shogun is the master!/);
                    const matches = output.match(/Worker .*?\d+.*? is online/g);
                    assert.ok(matches && matches.length >= 2, "Expected at least 2 workers online");
                    resolved = true;
                    resolve();
                } catch (err) {
                    reject(
                        new Error(
                            `Child exited early. code=${code}\n${err.message}\nOutput:\n${output}`,
                        ),
                    );
                }
            });

            child.on("error", (err) => {
                if (resolved) {
                    return;
                }
                cleanup();
                reject(err);
            });
        });
    });
});

it("should throw error on invalid configuration", async (t) => {
    const scriptPath = join(process.cwd(), "test", "fixtures", "invalid_app.js");

    await new Promise((resolve, reject) => {
        const child = spawn("node", [scriptPath], {
            stdio: "pipe",
            env: { ...process.env },
        });

        let stderr = "";

        child.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        child.on("close", (code) => {
            try {
                assert.notEqual(code, 0, "Process should exit with error code");
                assert.match(stderr, /Invalid configuration/);
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    });
});

it("should throw error on invalid mode", async () => {
    const scriptPath = join(process.cwd(), "test", "fixtures", "invalid_mode_app.js");

    await new Promise((resolve, reject) => {
        const child = spawn("node", [scriptPath], {
            stdio: "pipe",
            env: { ...process.env },
        });

        let stderr = "";

        child.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        child.on("close", (code) => {
            try {
                assert.notEqual(code, 0, "Process should exit with error code");
                assert.match(stderr, /Invalid configuration: mode/);
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    });
});
