import cluster from "node:cluster";
import { PassThrough } from "node:stream";
import { run } from "../../src/cluster.js";

const ttyInput = new PassThrough();
const ttyOutput = new PassThrough();
const isTtyInput = process.env.TEST_STDIN_IS_TTY === "1";

if (isTtyInput) {
    Object.defineProperty(ttyInput, "isTTY", { value: true });
}

ttyOutput.on("data", (chunk) => {
    process.stdout.write(`TTY_OUT:${chunk.toString()}`);
});

const manager = run(
    () => {
        const keepAlive = setInterval(() => {}, 1000);
        process.on("disconnect", () => {
            clearInterval(keepAlive);
            process.exit(0);
        });
    },
    {
        mode: "smart",
        minWorkers: 1,
        maxWorkers: 1,
        shutdownTimeout: 1500,
        tty: {
            enabled: true,
            stdin: ttyInput,
            stdout: ttyOutput,
        },
    },
);

if (!cluster.isWorker && manager) {
    manager.on("reload_start", () => {
        console.log("EVENT:reload_start");
    });
    manager.on("reload_end", () => {
        console.log("EVENT:reload_end");
    });

    process.on("message", async (msg) => {
        if (!msg || typeof msg !== "object") {
            return;
        }

        if (msg.cmd === "send" && typeof msg.line === "string") {
            ttyInput.write(`${msg.line}\n`);
            return;
        }

        if (msg.cmd === "exit") {
            await manager.close();
            process.exit(0);
        }
    });
}
