import cluster from "node:cluster";

import { run } from "../../src/cluster.js";

const manager = run(
    () => {
        let reportHighLoad = true;
        const keepAlive = setInterval(() => {}, 1000);
        const heartbeat = setInterval(() => {
            if (!cluster.worker.isConnected()) {
                return;
            }
            const { heapUsed, rss } = process.memoryUsage();
            cluster.worker.send({
                cmd: "heartbeat",
                lag: reportHighLoad ? 100 : 0,
                memory: { heapUsed, rss },
            });
        }, 10);

        const stop = () => {
            clearInterval(keepAlive);
            clearInterval(heartbeat);
        };
        process.on("message", (message) => {
            if (message === "settle") {
                reportHighLoad = false;
                return;
            }
            if (message === "idle" || message === "shutdown") {
                stop();
                cluster.worker.disconnect();
            }
        });
    },
    {
        mode: "smart",
        minWorkers: 1,
        maxWorkers: 2,
        scaleUpThreshold: 10,
        scaleDownThreshold: 1,
        scalingCooldown: 0,
        scaleDownGrace: 10000,
        autoScaleInterval: 25,
        heartbeatStaleAfter: 1000,
        shutdownTimeout: 500,
    },
);

if (cluster.isPrimary) {
    let scaledUp = false;
    let retirementRequested = false;

    manager.on("scale_up", () => {
        scaledUp = true;
    });
    manager.on("worker_online", () => {
        const workers = Object.values(cluster.workers).filter(Boolean);
        if (!scaledUp || retirementRequested || workers.length < 2) {
            return;
        }

        retirementRequested = true;
        for (const worker of workers) {
            worker.send("settle");
        }
        workers.at(-1).send("idle");
    });
    manager.on("worker_exit", () => {
        if (!retirementRequested) {
            return;
        }
        setTimeout(async () => {
            const metrics = manager.getMetrics();
            console.log(
                `VOLUNTARY_SCALE_DOWN:${metrics.workerCount}:${metrics.processCount}:${metrics.desiredWorkers}`,
            );
            await manager.close();
        }, 150).unref();
    });
}
