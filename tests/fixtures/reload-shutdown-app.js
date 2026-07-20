import cluster from "node:cluster";

import { run } from "../../src/cluster.js";

const manager = run(
    () => {
        const keepAlive = setInterval(() => {}, 1000);
        console.log(`RELOAD_WORKER_PID:${process.pid}`);

        process.on("message", (message) => {
            if (message === "shutdown") {
                setTimeout(() => {
                    clearInterval(keepAlive);
                    cluster.worker.disconnect();
                }, 250).unref();
            }
        });
    },
    {
        mode: "max",
        minWorkers: 2,
        maxWorkers: 2,
        reloadDisconnectWait: 1000,
        shutdownTimeout: 1000,
    },
);

if (cluster.isPrimary) {
    manager.on("reload_start", () => console.log("RELOAD_STARTED"));
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
        if (chunk.trim() === "reload") {
            void manager.reload().catch((err) => console.log(`RELOAD_RESULT:${err.name}`));
        }
    });
}
