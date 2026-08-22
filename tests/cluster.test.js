import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildClusterConfig, validateClusterConfig } from "../src/config.js";
import {
    expectFixtureFailure,
    killFixture,
    runFixtureWithOutput,
    spawnFixture,
} from "./helpers/fixture-process.js";

describe("Cluster Integration", () => {
    it("should start master and workers", async () => {
        await new Promise((resolve, reject) => {
            const child = spawnFixture("app.js");

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
                    killFixture(child);
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

                const matches = output.match(/Worker .*?\d+.*? is online/g);
                if (matches) {
                    workerCount = matches.length;
                }

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

                cleanup();
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

it("should support null options by using default cluster settings", async () => {
    await new Promise((resolve, reject) => {
        const child = spawnFixture("null-options-app.js");

        let output = "";
        let resolved = false;

        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
            }
            try {
                child.stdout?.removeAllListeners();
                child.stderr?.removeAllListeners();
                child.removeAllListeners();
                killFixture(child);
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
            output += data.toString();

            const hasMasterLog = output.includes("Shogun is the master!");
            const workerOnlineMatches = output.match(/Worker .*?\d+.*? is online/g);
            const hasWorkerOnline = workerOnlineMatches && workerOnlineMatches.length >= 1;

            if (!resolved && hasMasterLog && hasWorkerOnline) {
                resolved = true;
                cleanup();
                resolve();
            }
        });

        child.on("close", (code) => {
            if (resolved) {
                return;
            }

            cleanup();
            reject(new Error(`Child exited early. code=${code}\nOutput:\n${output}`));
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

it("should ignore malformed worker IPC messages", async () => {
    await new Promise((resolve, reject) => {
        const child = spawnFixture("malformed-message-app.js");

        let output = "";
        let settled = false;

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
                reject(
                    new Error("Timeout waiting for malformed-message fixture. Output:\n" + output),
                );
            });
        }, 10000).unref();

        child.stdout.on("data", (data) => {
            output += data.toString();
        });

        child.stderr.on("data", (data) => {
            output += data.toString();
        });

        child.on("close", (code) => {
            finish(() => {
                try {
                    assert.equal(
                        code,
                        0,
                        `Expected clean exit for malformed IPC handling.\n${output}`,
                    );
                    assert.match(output, /Shogun is the master!/);
                    assert.doesNotMatch(output, /TypeError/);
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

it("should reject null TTY streams with configuration errors", () => {
    assert.throws(
        () => validateClusterConfig(buildClusterConfig({ tty: { stdin: null } })),
        /Invalid configuration: tty.stdin must be a readable stream/,
    );
    assert.throws(
        () => validateClusterConfig(buildClusterConfig({ tty: { stdout: null } })),
        /Invalid configuration: tty.stdout must be a writable stream/,
    );
});

it("should run the application in-process without worker logs when clustering is disabled", async () => {
    const { code, output } = await runFixtureWithOutput("disabled-mode-app.js");

    assert.equal(code, 0, `Expected a clean disabled-mode exit.\n${output}`);
    assert.match(output, /Clustering disabled\. Running the application in the current process\./);
    assert.match(output, /DISABLED_MODE_WORKER:\d+/);
    assert.doesNotMatch(output, /Running worker process\./);
    assert.doesNotMatch(output, /Shogun is the master!/);
});

it("should reject unknown TTY configuration keys", () => {
    assert.throws(
        () => validateClusterConfig(buildClusterConfig({ tty: { promt: "> " } })),
        /Invalid configuration: unknown option \(tty\.promt\)/,
    );
});

it("should reject invalid reload health-check configuration", () => {
    assert.throws(
        () => validateClusterConfig(buildClusterConfig({ reloadHealthTimeout: 0 })),
        /Invalid configuration: reloadHealthTimeout \(0\) must be greater than 0/,
    );
    assert.throws(
        () => validateClusterConfig(buildClusterConfig({ reloadHealthCheck: true })),
        /Invalid configuration: reloadHealthCheck \(true\) must be a function/,
    );
});

const invalidConfigCases = [
    {
        name: "should throw error on invalid configuration",
        fixture: "invalid-app.js",
        pattern: /Invalid configuration/,
    },
    {
        name: "should throw error on non-finite numeric configuration",
        fixture: "invalid-numeric-config-app.js",
        pattern: /Invalid configuration: minWorkers \(NaN\) must be a finite number/,
    },
    {
        name: "should throw error on non-boolean enabled configuration",
        fixture: "invalid-enabled-config-app.js",
        pattern: /Invalid configuration: enabled \(false\) must be a boolean/,
    },
    {
        name: "should throw error on non-boolean norestart configuration",
        fixture: "invalid-norestart-config-app.js",
        pattern: /Invalid configuration: norestart \(no\) must be a boolean/,
    },
    {
        name: "should throw error on invalid shutdownSignals configuration",
        fixture: "invalid-shutdown-signals-app.js",
        pattern:
            /Invalid configuration: shutdownSignals \(SIGTERM\) must be an array of non-empty strings/,
    },
    {
        name: "should throw error when minWorkers is not an integer",
        fixture: "invalid-min-workers-integer-app.js",
        pattern: /Invalid configuration: minWorkers \(1.5\) must be an integer >= 1/,
    },
    {
        name: "should throw error when maxWorkers is less than 1",
        fixture: "invalid-max-workers-minimum-app.js",
        pattern: /Invalid configuration: maxWorkers \(0\) must be an integer >= 1/,
    },
    {
        name: "should throw error on negative scalingCooldown",
        fixture: "invalid-negative-scaling-cooldown-app.js",
        pattern: /Invalid configuration: scalingCooldown \(-1\) must be >= 0/,
    },
    {
        name: "should throw error on negative scaleUpMemory",
        fixture: "invalid-negative-scale-up-memory-app.js",
        pattern: /Invalid configuration: scaleUpMemory \(-5\) must be >= 0/,
    },
    {
        name: "should throw error on non-positive autoScaleInterval",
        fixture: "invalid-zero-auto-scale-interval-app.js",
        pattern: /Invalid configuration: autoScaleInterval \(0\) must be greater than 0/,
    },
    {
        name: "should throw error on negative scaleDownThreshold",
        fixture: "invalid-negative-scale-down-threshold-app.js",
        pattern: /Invalid configuration: scaleDownThreshold \(-1\) must be >= 0/,
    },
    {
        name: "should throw error on duplicate shutdownSignals",
        fixture: "invalid-duplicate-shutdown-signals-app.js",
        pattern:
            /Invalid configuration: shutdownSignals \(SIGTERM,SIGTERM\) must not contain duplicates/,
    },
    {
        name: "should throw error on unsupported shutdown signals",
        fixture: "invalid-unsupported-shutdown-signal-app.js",
        pattern: /Invalid configuration: unsupported shutdown signal \(SIG_NOT_REAL\)/,
    },
    {
        name: "should throw error when startWorker is not a function",
        fixture: "invalid-start-worker-app.js",
        pattern: /Invalid configuration: startWorker \(string\) must be a function/,
    },
    {
        name: "should throw error on invalid mode",
        fixture: "invalid-mode-app.js",
        pattern: /Invalid configuration: mode/,
    },
    {
        name: "should throw error on unknown configuration keys",
        fixture: "invalid-unknown-key-app.js",
        pattern: /Invalid configuration: unknown option \(maxworkers\)/,
    },
    {
        name: "should validate configuration when clustering is disabled",
        fixture: "invalid-disabled-config-app.js",
        pattern: /Invalid configuration: minWorkers \(NaN\) must be a finite number/,
    },
];

for (const { name, fixture, pattern } of invalidConfigCases) {
    it(name, async () => {
        await expectFixtureFailure(fixture, pattern);
    });
}
