import cluster from "node:cluster";

import { run } from "../../src/cluster.js";

const HIGH_HEAP_USED = 256 * 1024 * 1024;
const SAFE_HEAP_USED = 8 * 1024 * 1024;

const manager = run(
    () => {
        const keepAlive = setInterval(() => {}, 1000);

        process.on("disconnect", () => {
            clearInterval(keepAlive);
            process.exit(0);
        });

        if (cluster.isWorker) {
            const heapUsed = cluster.worker.id === 1 ? HIGH_HEAP_USED : SAFE_HEAP_USED;
            setTimeout(() => {
                cluster.worker.send({
                    cmd: "heartbeat",
                    lag: 0,
                    memory: { heapUsed },
                });
            }, 500).unref();
        }
    },
    {
        mode: "smart",
        minWorkers: 1,
        maxWorkers: 1,
        maxWorkerMemory: 128,
        autoScaleInterval: 50,
        scalingCooldown: 0,
    },
);

if (manager) {
    const startedAt = Date.now();
    let initialPid = null;

    const interval = setInterval(() => {
        const metrics = manager.getMetrics();
        const pid = metrics.workers[0]?.pid;

        if (!initialPid && pid) {
            initialPid = pid;
            return;
        }

        if (initialPid && pid && pid !== initialPid) {
            console.log("OBJECT_MEMORY_RESTART");
            clearInterval(interval);
            process.exit(0);
            return;
        }

        if (Date.now() - startedAt > 1900) {
            console.error("Timeout waiting for object-form heartbeat memory restart.");
            clearInterval(interval);
            process.exit(1);
        }
    }, 25);
}
