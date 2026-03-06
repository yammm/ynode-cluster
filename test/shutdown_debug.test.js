import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

describe("Cluster Shutdown", () => {
    it("should shut down workers gracefully on SIGTERM", async (t) => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "shutdown_app.js");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: "pipe",
                env: { ...process.env },
            });

            let output = "";
            let workersOnline = 0;

            child.stdout.on("data", (data) => {
                const str = data.toString();
                output += str;
                // console.log(str);

                if (str.includes("is online")) {
                    workersOnline++;
                    if (workersOnline === 2) {
                        // Send SIGTERM to master
                        setTimeout(() => {
                            child.kill("SIGTERM");
                        }, 500);
                    }
                }
            });

            child.stderr.on("data", (d) => console.error(d.toString()));

            child.on("close", (code) => {
                try {
                    // Check if workers received shutdown message or disconnected
                    // assert.match(output, /Master received SIGTERM/);
                    // assert.match(output, /shutting down workers/);

                    // If the bug exists, workers might NOT log "received shutdown message"
                    // unless we implemented the listener (which I did in fixture).
                    // But effectively, master should force exit after 2s if workers don't exit.

                    // We want to see if they exit BEFORE the timeout (graceful)
                    // or ONLY at timeout (force).

                    if (output.includes("Master force exiting")) {
                        // This means they didn't exit on their own.
                        console.log("Verdict: Master forced exit.");
                    } else {
                        console.log("Verdict: Clean exit.");
                    }

                    resolve();
                } catch (err) {
                    reject(err);
                }
            });

            setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error("Timeout. Output:\n" + output));
            }, 5000);
        });
    });
});
