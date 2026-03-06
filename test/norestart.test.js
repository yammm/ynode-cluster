import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { runFixtureWithOutput } from "./helpers/fixture-process.js";

describe("No Restart Option", () => {
    it("should not restart workers when norestart is true", async () => {
        const { output } = await runFixtureWithOutput("dying_app.js", {
            timeoutMs: 5000,
        });

        const workerStarts = output.match(/Worker starting\.\.\./g)?.length ?? 0;
        assert.equal(workerStarts, 1, "Worker should start exactly once");
        assert.match(output, /Not restarting \(norestart enabled\)/);
    });
});
