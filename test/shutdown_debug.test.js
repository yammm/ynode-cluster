import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runFixtureWithOutput } from "./helpers/fixture-process.js";

describe("Cluster Shutdown", () => {
    it("should shut down workers gracefully on SIGTERM", async () => {
        let workersOnline = 0;
        let signalSent = false;

        const { code, output } = await runFixtureWithOutput("shutdown_app.js", {
            timeoutMs: 5000,
            onStdout: (chunk, child) => {
                const onlineMatches = chunk.match(/Worker .*?\d+.*? is online/g);
                if (onlineMatches) {
                    workersOnline += onlineMatches.length;
                }
                if (!signalSent && workersOnline >= 2) {
                    signalSent = true;
                    setTimeout(() => {
                        try {
                            child.kill("SIGTERM");
                        } catch (err) {
                            console.debug(err);
                        }
                    }, 200).unref();
                }
            },
        });

        assert.match(output, /Master received SIGTERM, shutting down workers/);
        assert.doesNotMatch(output, /Master force exiting/);
        assert.doesNotMatch(output, /Restarting in \d+ms/);

        const shutdownMessages = output.match(/received shutdown message/g) ?? [];
        assert.ok(
            shutdownMessages.length >= 2,
            `Expected both workers to receive shutdown message.\nOutput:\n${output}`,
        );
        assert.notEqual(code, null, `Expected process to exit normally.\nOutput:\n${output}`);
    });
});
