import cluster from "node:cluster";

import { run } from "../../src/cluster.js";

const manager = run(
    () => {
        const keepAlive = setInterval(() => {}, 1000);

        process.on("message", (message) => {
            if (message === "shutdown") {
                clearInterval(keepAlive);
                cluster.worker.disconnect();
            }
        });

        if (cluster.worker.id === 1) {
            setTimeout(() => {
                clearInterval(keepAlive);
                cluster.worker.disconnect();
            }, 100).unref();
        }
    },
    {
        mode: "max",
        minWorkers: 1,
        maxWorkers: 2,
        norestart: true,
        autoScaleInterval: 50,
        scalingCooldown: 0,
        shutdownTimeout: 500,
    },
);

if (cluster.isPrimary) {
    let unexpectedReplacement = false;
    manager.on("worker_online", ({ id }) => {
        if (id > 2) {
            unexpectedReplacement = true;
        }
    });
    manager.on("worker_exit", ({ id }) => {
        if (id !== 1) {
            return;
        }
        setTimeout(() => {
            const metrics = manager.getMetrics();
            console.log(
                `NORESTART_CAPACITY:${metrics.workerCount}:${metrics.processCount}:${metrics.desiredWorkers}:${unexpectedReplacement}`,
            );
            void manager.close();
        }, 250).unref();
    });
}
