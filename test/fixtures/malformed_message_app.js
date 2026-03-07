import cluster from "node:cluster";

import { run } from "../../src/cluster.js";

run(
    () => {
        const keepAlive = setInterval(() => {}, 1000);

        if (cluster.isWorker) {
            setTimeout(() => {
                cluster.worker.send(null);
                cluster.worker.send("malformed");
                cluster.worker.send({ cmd: "heartbeat", lag: 5, memory: 1024 });
            }, 100).unref();

            setTimeout(() => {
                cluster.worker.disconnect();
                clearInterval(keepAlive);
            }, 500).unref();
        }
    },
    {
        minWorkers: 1,
        maxWorkers: 1,
        mode: "smart",
        enabled: true,
    },
);
