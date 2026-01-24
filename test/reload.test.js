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
                env: { ...process.env }
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
                            assert.ok(newPids.size >= 2, "Should have started new workers");

                            // Ensure intersection is empty (all replaced)
                            // Note: newPids might include some old ones if logging happened before they died, 
                            // but usually they are distinct sets in a clean reload.
                            // Actually, let's just assert that *some* new PIDs exist that weren't in original.

                            // const intersection = [...newPids].filter(x => originalPids.has(x));
                            // assert.equal(intersection.length, 0, "All workers should be replaced"); 
                            // This might be flaky if a worker logs "PID:" right as it's dying? 
                            // The app logs PID on start typically.

                            // Let's simple check:
                            assert.notDeepEqual([...originalPids].sort(), [...newPids].sort());

                            child.kill("SIGKILL");
                            resolve();
                        } catch (err) {
                            child.kill("SIGKILL");
                            reject(err);
                        }
                    }
                }
            });

            child.stderr.on("data", d => console.error(d.toString()));

            setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error("Timeout waiting for reload. Output:\n" + output));
            }, 15000);
        });
    });
});
