import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { join } from "node:path";

describe("Cluster Reload", () => {
    it("should reload workers (change PIDs)", async (t) => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "reload_app.js");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: "pipe",
                env: { ...process.env },
            });

            let output = "";
            const originalPids = new Set();
            const newPids = new Set();
            let reloadTriggered = false;

            child.stdout.on("data", (data) => {
                const lines = data.toString().split("\n");
                for (const line of lines) {
                    if (!line.trim()) {
                        continue;
                    }
                    output += line + "\n";

                    if (line.includes("PID:")) {
                        const pid = line.split("PID:")[1].trim();
                        if (!reloadTriggered) {
                            originalPids.add(pid);
                        } else {
                            newPids.add(pid);
                        }
                    }

                    // Wait until we have 2 original workers then trigger reload
                    if (!reloadTriggered && originalPids.size === 2) {
                        reloadTriggered = true;
                        console.log("Triggering reload via IPC...");
                        child.stdin.write("reload\n");
                    }

                    if (line.includes("Reload complete")) {
                        // Validate
                        try {
                            // Ensure we have new PIDs
                            assert.ok(newPids.size > 0, "Should have started new workers");

                            // Let's simple check:
                            assert.notDeepEqual([...originalPids].sort(), [...newPids].sort());

                            child.kill("SIGTERM");
                            resolve();
                        } catch (err) {
                            child.kill("SIGTERM");
                            reject(err);
                        }
                    }
                }
            });

            child.stderr.on("data", (d) => console.error(d.toString()));

            setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error("Timeout waiting for reload. Output:\n" + output));
            }, 15000);
        });
    });
});
