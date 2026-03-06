import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { join } from "node:path";

describe("Cluster Shutdown", () => {
    it("should shut down workers gracefully on SIGTERM", async () => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "shutdown_app.js");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: "pipe",
                env: { ...process.env },
            });

            let output = "";
            let workersOnline = 0;
            let signalSent = false;
            let settled = false;

            child.stdout.on("data", (data) => {
                const str = data.toString();
                output += str;

                const onlineMatches = str.match(/Worker .*?\d+.*? is online/g);
                if (onlineMatches) {
                    workersOnline += onlineMatches.length;
                }
                if (!signalSent && workersOnline >= 2) {
                    signalSent = true;
                    setTimeout(() => {
                        child.kill("SIGTERM");
                    }, 200).unref();
                }
            });

            child.stderr.on("data", (d) => {
                output += d.toString();
            });

            child.on("close", (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);

                try {
                    assert.match(output, /Master received SIGTERM, shutting down workers/);
                    assert.doesNotMatch(output, /Master force exiting/);
                    assert.doesNotMatch(output, /Restarting in \d+ms/);

                    const shutdownMessages = output.match(/received shutdown message/g) ?? [];
                    assert.ok(
                        shutdownMessages.length >= 2,
                        `Expected both workers to receive shutdown message.\nOutput:\n${output}`,
                    );
                    assert.notEqual(code, null, `Expected process to exit normally.\nOutput:\n${output}`);

                    resolve();
                } catch (err) {
                    reject(err);
                }
            });

            const timeout = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                child.kill("SIGKILL");
                reject(new Error("Timeout. Output:\n" + output));
            }, 5000).unref();
        });
    });
});
