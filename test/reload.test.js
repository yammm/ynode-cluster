import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runFixtureWithOutput } from "./helpers/fixture-process.js";

describe("Cluster Reload", () => {
    it("should reload workers (change PIDs)", async () => {
        const originalPids = new Set();
        const newPids = new Set();
        let reloadTriggered = false;
        let reloadCompleted = false;

        const { output } = await runFixtureWithOutput("reload_app.js", {
            timeoutMs: 15000,
            onStdout: (chunk, child) => {
                for (const line of chunk.split("\n")) {
                    if (!line.trim()) {
                        continue;
                    }

                    if (line.includes("PID:")) {
                        const pid = line.split("PID:")[1].trim();
                        if (!reloadTriggered) {
                            originalPids.add(pid);
                        } else {
                            newPids.add(pid);
                        }
                    }

                    if (!reloadTriggered && originalPids.size === 2) {
                        reloadTriggered = true;
                        child.stdin.write("reload\n");
                    }

                    if (!reloadCompleted && line.includes("Reload complete")) {
                        reloadCompleted = true;
                        try {
                            child.kill("SIGTERM");
                        } catch (err) {
                            console.debug(err);
                        }
                    }
                }
            },
        });

        assert.ok(reloadTriggered, `Reload was not triggered. Output:\n${output}`);
        assert.ok(reloadCompleted, `Reload did not complete. Output:\n${output}`);
        assert.ok(newPids.size > 0, `Should have started new workers. Output:\n${output}`);
        assert.notDeepEqual([...originalPids].sort(), [...newPids].sort());
    });
});
