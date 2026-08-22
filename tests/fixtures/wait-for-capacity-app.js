import cluster from "node:cluster";

import { run } from "../../src/cluster.js";

const manager = run(
    () => {
        const keepAlive = setInterval(() => {}, 1000);
        process.on("message", (message) => {
            if (message === "shutdown") {
                clearInterval(keepAlive);
                process.exit(0);
            }
        });
    },
    {
        maxWorkers: 2,
        minWorkers: 2,
        mode: "smart",
        shutdownTimeout: 1000,
    },
);

if (cluster.isPrimary && manager) {
    try {
        const metrics = await manager.waitForCapacity({ state: "online", timeoutMs: 5000 });
        console.log(`CAPACITY_READY:${metrics.workers.length}`);
        await manager.close();
        process.exit(0);
    } catch (error) {
        console.error("CAPACITY_ERROR", error);
        process.exit(1);
    }
}
