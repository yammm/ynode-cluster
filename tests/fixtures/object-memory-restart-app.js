import cluster from "node:cluster";

import { run } from "../../src/cluster.js";

const HIGH_HEAP_USED = 256 * 1024 * 1024;
const SAFE_HEAP_USED = 8 * 1024 * 1024;
const useRssLimit = process.env.CLUSTER_TEST_MEMORY_KIND === "rss";

const manager = run(
    () => {
        const keepAlive = setInterval(() => {}, 1000);

        process.on("disconnect", () => {
            clearInterval(keepAlive);
            process.exit(0);
        });

        if (cluster.isWorker) {
            const heapUsed = cluster.worker.id === 1 ? HIGH_HEAP_USED : SAFE_HEAP_USED;
            const rss = cluster.worker.id === 1 ? HIGH_HEAP_USED : SAFE_HEAP_USED;
            setTimeout(() => {
                cluster.worker.send({
                    cmd: "heartbeat",
                    lag: 0,
                    memory: { heapUsed, rss, external: 1024, arrayBuffers: 512 },
                });
            }, 500).unref();
        }
    },
    {
        mode: "smart",
        minWorkers: 1,
        maxWorkers: 1,
        maxWorkerMemory: useRssLimit ? 0 : 128,
        maxWorkerRss: useRssLimit ? 128 : 0,
        autoScaleInterval: 5000,
        heartbeatStaleAfter: 10,
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
            console.log(useRssLimit ? "OBJECT_RSS_RESTART" : "OBJECT_MEMORY_RESTART");
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
