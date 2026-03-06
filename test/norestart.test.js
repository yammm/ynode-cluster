import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { join } from "node:path";

describe("No Restart Option", () => {
    it("should not restart workers when norestart is true", async () => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "dying_app.js");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: "pipe",
                env: { ...process.env },
            });

            let output = "";
            let workerStarts = 0;
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
                const str = data.toString();
                output += str;
                if (str.includes("Worker starting...")) {
                    workerStarts++;
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
                    // With norestart: true, the worker dies, master logs it and should eventually exit
                    // (immediately if no other handles, or we might need to kill it if it hangs).
                    // BUT effectively we want to ensure it didn't restart.
                    // So workerStarts should be 1.
                    assert.equal(workerStarts, 1, "Worker should start exactly once");
                    assert.match(output, /Not restarting \(norestart enabled\)/);
                    resolve();
                } catch (err) {
                    reject(new Error(`${err.message}\nOutput:\n${output}`));
                }
            });

            // If it hangs (meaning master didn't exit or kept restarting), timeout kills it
            const timeout = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup("SIGKILL");
                reject(new Error(`Timeout. Worker starts: ${workerStarts}\nOutput:\n${output}`));
            }, 5000).unref();
        });
    });
});
