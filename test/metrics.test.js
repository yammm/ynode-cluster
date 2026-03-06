import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { join } from "node:path";

describe("Metrics API", () => {
    it("should export metrics via getMetrics()", async (t) => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "metrics_app.js");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: "pipe",
                env: { ...process.env },
            });

            let output = "";
            let resolved = false;

            const cleanup = () => {
                try {
                    child.kill();
                } catch (err) {
                    console.debug(err);
                }
            };

            setTimeout(() => {
                if (!resolved) {
                    cleanup();
                    reject(
                        new Error(
                            `Timeout waiting for metrics output. Captured output:\n${output}`,
                        ),
                    );
                }
            }, 10000).unref();

            child.stdout.on("data", (data) => {
                output += data.toString();
                if (output.includes("METRICS_JSON:")) {
                    const line = output.split("\n").find((l) => l.includes("METRICS_JSON:"));
                    if (line) {
                        try {
                            const json = JSON.parse(line.split("METRICS_JSON:")[1]);
                            assert.equal(typeof json.avgLag, "number");
                            assert.equal(typeof json.workerCount, "number");
                            assert.ok(json.workerCount >= 2, "Should have at least 2 workers");
                            assert.ok(Array.isArray(json.workers));
                            assert.equal(json.workers.length, json.workerCount);

                            resolved = true;
                            cleanup();
                            resolve();
                        } catch (err) {
                            // wait for more data if JSON incomplete? No, line should be complete
                            console.debug(err);
                        }
                    }
                }
            });

            child.addListener("close", (code) => {
                if (!resolved) {
                    reject(new Error("Child exited without printing metrics. Output:\n" + output));
                }
            });
        });
    });
});
