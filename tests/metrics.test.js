import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runFixtureWithOutput } from "./helpers/fixture-process.js";

describe("Metrics API", () => {
    it("should export metrics via getMetrics()", async () => {
        const { code, output } = await runFixtureWithOutput("metrics-app.js", {
            timeoutMs: 15000,
        });

        assert.equal(code, 0, "Child exited without printing metrics. Output:\n" + output);

        const line = output
            .split("\n")
            .find((entry) => entry.includes("METRICS_JSON:") && entry.split("METRICS_JSON:")[1]);

        assert.ok(line, "Child exited before metrics assertion completed. Output:\n" + output);

        const json = JSON.parse(line.split("METRICS_JSON:")[1]);
        assert.equal(typeof json.avgLag, "number");
        assert.equal(typeof json.workerCount, "number");
        assert.ok(json.workerCount >= 2, "Should have at least 2 workers");
        assert.ok(Array.isArray(json.workers));
        assert.equal(json.workers.length, json.workerCount);
        for (const worker of json.workers) {
            assert.equal(typeof worker.uptime, "number");
            assert.ok(worker.uptime >= 0, "Expected uptime >= 0");
        }
    });
});
