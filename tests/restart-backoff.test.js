import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runFixtureWithOutput } from "./helpers/fixture-process.js";

describe("Worker Restart Backoff", () => {
    it("should increase restart delay on repeated crashes", async () => {
        const delays = [];
        let stopTriggered = false;

        const collectDelays = (chunk, child) => {
            const matches = chunk.matchAll(/Restarting in (\d+)ms/g);
            for (const match of matches) {
                delays.push(Number.parseInt(match[1], 10));
            }

            if (!stopTriggered && delays.length >= 3) {
                stopTriggered = true;
                try {
                    child.kill("SIGKILL");
                } catch (err) {
                    console.debug(err);
                }
            }
        };

        const { output } = await runFixtureWithOutput("crash-loop-app.js", {
            timeoutMs: 8000,
            onStdout: collectDelays,
            onStderr: collectDelays,
        });

        assert.ok(delays.length >= 3, `Expected at least 3 delays. Output:\n${output}`);
        assert.ok(delays[0] > 0, "Expected a positive restart delay");
        assert.ok(delays[1] >= delays[0], "Expected second delay to be >= first");
        assert.ok(delays[2] >= delays[1], "Expected third delay to be >= second");
    });
});
