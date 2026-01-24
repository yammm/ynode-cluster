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
                env: { ...process.env }
            });

            let output = "";

            child.stdout.on("data", (data) => {
                const str = data.toString();
                output += str;

                // Check for expected output
                if (output.includes("Shogun is the master!") &&
                    output.includes("Worker") &&
                    output.includes("is online")) {

                    // If we see workers online, we can assume success for this basic sanity check
                    // Kill the child using SIGKILL to avoid the 10s graceful shutdown delay in the app
                    child.kill("SIGKILL");
                    resolve();
                }
            });

            // child.stderr.on("data", (data) => {
            //     console.error("STDERR:", data.toString());
            // });

            child.on("close", (code) => {
                // If the promise is already resolved, this does nothing
                // If unexpected close, verify output match
                try {
                    assert.match(output, /Shogun is the master!/);
                    assert.match(output, /Worker .*?\d+.*? is online/);
                    // If resolve wasn't called (e.g. timeout), resolve now if matches? 
                    // But we want to kill explicitly.
                } catch (err) {
                    // reject(err); // Don't reject here if we already resolved?
                    console.error(err);
                }
            });

            // Timeout safety
            setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error("Test timed out waiting for output"));
            }, 5000);
        });
    });
});
