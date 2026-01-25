import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import http from "node:http";

describe("Memory Scaling", () => {
    it("should restart worker on memory leak", async (t) => {
        const scriptPath = join(process.cwd(), "test", "fixtures", "memory_app.js");

        // eslint-disable-next-line no-control-regex
        const sanitize = new RegExp("\\x1b\\[\\d+m", "g");

        await new Promise((resolve, reject) => {
            const child = spawn("node", [scriptPath], {
                stdio: ["pipe", "pipe", "pipe", "ipc"], // Enable IPC for messages if needed, though we rely on stdout
                env: { ...process.env }
            });

            let output = "";
            let port = 0;
            let initialPid = null;
            let restarted = false;

            child.stdout.on("data", (data) => {
                const str = data.toString();
                output += str;

                // Remove escape sequences
                const cleanStr = str.replace(sanitize, "");

                // Need to find port to trigger leak. 
                // The wrapper logs "connected to ... :port"
                const match = cleanStr.match(/connected to .*?:(\d+)/);
                if (match && !port) {
                    port = parseInt(match[1]);
                    // Trigger leak
                    setTimeout(() => {
                        http.get(`http://localhost:${port}/leak`, (res) => {
                            // Keep triggering until it dies? 
                            // One request might be enough if leak is big
                        });
                    }, 1000);
                }

                // Track PIDs
                const pidMatch = cleanStr.match(/Worker (\d+) is online/);
                if (pidMatch) {
                    const pid = pidMatch[1];
                    if (!initialPid) {
                        initialPid = pid;
                    } else if (pid !== initialPid) {
                        restarted = true;
                    }
                }

                // Detection log
                if (cleanStr.includes("exceeded memory limit")) {
                    // Success!
                }
            });

            child.stderr.on("data", d => console.error(d.toString()));

            const checkInterval = setInterval(() => {
                if (restarted) {
                    clearInterval(checkInterval);
                    child.kill("SIGKILL");
                    resolve();
                }
            }, 500);

            setTimeout(() => {
                clearInterval(checkInterval);
                child.kill("SIGKILL");
                reject(new Error("Timeout waiting for memory restart. Output:\n" + output));
            }, 30000);
        });
    });
});
