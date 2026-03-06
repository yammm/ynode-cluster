import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { join } from "node:path";

describe("Metrics API", () => {
    it("should export metrics via getMetrics()", async () => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "metrics_app.js");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: "pipe",
                env: { ...process.env },
            });

            let output = "";
            let settled = false;

            const cleanup = () => {
                try {
                    child.kill("SIGTERM");
                } catch (err) {
                    console.debug(err);
                }
            };

            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(
                        new Error(
                            `Timeout waiting for metrics output. Captured output:\n${output}`,
                        ),
                    );
                }
            }, 15000).unref();

            child.stdout.on("data", (data) => {
                output += data.toString();
                const line = output
                    .split("\n")
                    .find((l) => l.includes("METRICS_JSON:") && l.split("METRICS_JSON:")[1]);
                if (line && !settled) {
                    settled = true;
                    clearTimeout(timeout);
                    try {
                        const json = JSON.parse(line.split("METRICS_JSON:")[1]);
                        assert.equal(typeof json.avgLag, "number");
                        assert.equal(typeof json.workerCount, "number");
                        assert.ok(json.workerCount >= 2, "Should have at least 2 workers");
                        assert.ok(Array.isArray(json.workers));
                        assert.equal(json.workers.length, json.workerCount);
                        for (const worker of json.workers) {
                            assert.equal(typeof worker.uptime, "number");
                            assert.ok(worker.uptime >= 0, "Expected uptime >= 0");
                        }
                        cleanup();
                        resolve();
                    } catch (err) {
                        cleanup();
                        reject(new Error(`${err.message}\nOutput:\n${output}`));
                    }
                }
            });

            child.addListener("close", (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                if (code !== 0) {
                    reject(new Error("Child exited without printing metrics. Output:\n" + output));
                    return;
                }
                reject(new Error("Child exited before metrics assertion completed. Output:\n" + output));
            });
        });
    });
});
