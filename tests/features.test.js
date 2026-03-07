import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runFixtureWithOutput } from "./helpers/fixture-process.js";

describe("Cluster Manager Features", () => {
    it("should dedupe concurrent reload calls and expose lifecycle events", async () => {
        let exerciseSent = false;

        const { code, output } = await runFixtureWithOutput("features_app.js", {
            onStdout: (_str, child, currentOutput) => {
                if (!exerciseSent && currentOutput.includes("EVENT:worker_online:1")) {
                    exerciseSent = true;
                    child.stdin.write("exercise\n");
                }
            },
        });

        assert.equal(code, 0, `Expected exit code 0.\nOutput:\n${output}`);
        assert.match(output, /RELOAD_DONE/);
        assert.match(output, /CLOSE_DONE/);
        assert.match(output, /EVENT:reload_start:1/);
        assert.match(output, /EVENT:reload_end:1/);
        assert.match(output, /EVENT:shutdown_start:1/);
        assert.match(output, /EVENT:shutdown_end:1/);

        const reloadStarts = output.match(/Starting zero-downtime cluster reload\.\.\./g)?.length ?? 0;
        assert.equal(reloadStarts, 1, `Expected one reload execution despite two calls.\nOutput:\n${output}`);
    });

    it("should validate reload timeout options", async () => {
        const { code, output } = await runFixtureWithOutput("invalid_reload_timeout_app.js", {
            timeoutMs: 5000,
        });

        assert.notEqual(code, 0, `Expected non-zero exit for invalid config.\nOutput:\n${output}`);
        assert.match(output, /Invalid configuration: reloadOnlineTimeout/);
    });

    it("should dedupe concurrent reload failures and reject both callers", async () => {
        let exerciseSent = false;

        const { code, output } = await runFixtureWithOutput("reload_fail_dedupe_app.js", {
            onStdout: (_str, child, currentOutput) => {
                if (!exerciseSent && currentOutput.includes(" is online")) {
                    exerciseSent = true;
                    child.stdin.write("exercise\n");
                }
            },
        });

        assert.equal(code, 0, `Expected exit code 0.\nOutput:\n${output}`);
        assert.match(output, /RELOAD_RESULTS:rejected,rejected/);
        assert.match(output, /RELOAD_ERROR_A:/);
        assert.match(output, /RELOAD_ERROR_B:/);

        const errorA = output.match(/RELOAD_ERROR_A:(.+)/)?.[1]?.trim();
        const errorB = output.match(/RELOAD_ERROR_B:(.+)/)?.[1]?.trim();
        assert.equal(
            errorA,
            errorB,
            `Expected both callers to receive the same rejection message.\nOutput:\n${output}`,
        );

        const reloadStarts = output.match(/Starting zero-downtime cluster reload\.\.\./g)?.length ?? 0;
        assert.equal(reloadStarts, 1, `Expected one reload execution despite two failing calls.\nOutput:\n${output}`);
    });
});
