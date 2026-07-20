import cluster from "node:cluster";

import { run } from "../../src/cluster.js";

const mode = process.env.CLUSTER_TEST_MODE === "max" ? "max" : "smart";
const initialWorkers = mode === "max" ? 2 : 1;

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
        mode,
        minWorkers: 1,
        maxWorkers: 2,
        autoScaleInterval: 50,
        scalingCooldown: 0,
        shutdownTimeout: 500,
    },
);

if (cluster.isPrimary) {
    manager.on("worker_online", ({ id }) => {
        if (id > initialWorkers) {
            setTimeout(() => {
                const metrics = manager.getMetrics();
                console.log(
                    `FLOOR_RESTORED:${id}:${metrics.workerCount}:${metrics.processCount}:${metrics.desiredWorkers}`,
                );
                void manager.close();
            }, 50).unref();
        }
    });
}
