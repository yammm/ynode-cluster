import http from "node:http";
import { describe, it } from "node:test";

import { spawnFixture } from "./helpers/fixture-process.js";

describe("Memory Scaling", () => {
    it("should restart worker on memory leak", async () => {
        // eslint-disable-next-line no-control-regex
        const sanitize = new RegExp("\\x1b\\[\\d+m", "g");

        await new Promise((resolve, reject) => {
            const child = spawnFixture("memory_app.js", {
                stdio: ["pipe", "pipe", "pipe", "ipc"], // Enable IPC for messages if needed, though we rely on stdout
            });

            let output = "";
            let port = 0;
            let initialPid = null;
            let settled = false;

            const cleanup = (signal = "SIGTERM") => {
                clearTimeout(timeout);
                try {
                    child.kill(signal);
                } catch (err) {
                    console.debug(err);
                }
            };

            child.stdout.on("data", (data) => {
                const str = data.toString();
                output += str;

                // Remove escape sequences
                const cleanStr = str.replace(sanitize, "");

                // Need to find port to trigger leak.
                // The wrapper logs "connected to ... :port"
                const match = cleanStr.match(/connected to .*?:(\d+)/);
                if (match && !port) {
                    port = Number.parseInt(match[1], 10);
                    // Trigger leak
                    setTimeout(() => {
                        http.get(`http://localhost:${port}/leak`, () => {
                            // Keep triggering until it dies?
                            // One request might be enough if leak is big
                        }).on("error", () => {});
                    }, 1000);
                }

                // Track PIDs
                const pidMatch = cleanStr.match(/Worker (\d+) is online/);
                if (pidMatch) {
                    const pid = pidMatch[1];
                    if (!initialPid) {
                        initialPid = pid;
                    } else if (pid !== initialPid) {
                        settled = true;
                        cleanup("SIGTERM");
                        resolve();
                    }
                }
            });

            child.stderr.on("data", (data) => {
                output += data.toString();
            });

            child.on("close", (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                reject(
                    new Error(
                        `Child exited before memory restart. code=${code}\nOutput:\n${output}`,
                    ),
                );
            });

            child.on("error", (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                reject(err);
            });

            const timeout = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup("SIGKILL");
                reject(new Error("Timeout waiting for memory restart. Output:\n" + output));
            }, 30000).unref();
        });
    });
});
