import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { join } from "node:path";

describe("Worker Restart Backoff", () => {
    it("should increase restart delay on repeated crashes", async () => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "crash_loop_app.js");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: "pipe",
                env: { ...process.env },
            });

            let output = "";
            const delays = [];

            const maybeParseDelays = (chunk) => {
                const matches = chunk.matchAll(/Restarting in (\d+)ms/g);
                for (const match of matches) {
                    delays.push(Number.parseInt(match[1], 10));
                }

                if (delays.length >= 3) {
                    try {
                        assert.ok(delays[0] > 0, "Expected a positive restart delay");
                        assert.ok(delays[1] >= delays[0], "Expected second delay to be >= first");
                        assert.ok(delays[2] >= delays[1], "Expected third delay to be >= second");
                        child.kill("SIGKILL");
                        resolve();
                    } catch (err) {
                        child.kill("SIGKILL");
                        reject(new Error(`${err.message}\nOutput:\n${output}`));
                    }
                }
            };

            child.stdout.on("data", (data) => {
                const str = data.toString();
                output += str;
                maybeParseDelays(str);
            });

            child.stderr.on("data", (data) => {
                const str = data.toString();
                output += str;
                maybeParseDelays(str);
            });

            child.on("error", (err) => {
                reject(err);
            });

            setTimeout(() => {
                child.kill("SIGKILL");
                reject(
                    new Error(
                        `Timeout waiting for restart delay logs. Delays seen: ${delays.join(", ")}\nOutput:\n${output}`,
                    ),
                );
            }, 8000).unref();
        });
    });
});
