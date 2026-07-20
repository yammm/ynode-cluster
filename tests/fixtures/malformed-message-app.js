import cluster from "node:cluster";

import { run } from "../../src/cluster.js";

const manager = run(
    () => {
        const keepAlive = setInterval(() => {}, 1000);

        if (cluster.isWorker) {
            setTimeout(() => {
                cluster.worker.send(null);
                cluster.worker.send("malformed");
                cluster.worker.send({ cmd: "heartbeat", lag: 5, memory: 1024 });
            }, 100).unref();

            process.on("message", (message) => {
                if (message === "shutdown") {
                    clearInterval(keepAlive);
                    cluster.worker.disconnect();
                }
            });
        }
    },
    {
        minWorkers: 1,
        maxWorkers: 1,
        mode: "smart",
        enabled: true,
    },
);

if (cluster.isPrimary) {
    setTimeout(() => {
        void manager.close();
    }, 500).unref();
}
