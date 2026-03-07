import { run } from "../../src/cluster.js";

const manager = run(
    () => {
        // Keep worker alive without opening sockets (sandbox-safe).
        const keepAlive = setInterval(() => {}, 1000);
        process.on("disconnect", () => {
            clearInterval(keepAlive);
            process.exit(0);
        });
    },
    {
        minWorkers: 2,
        mode: "smart",
        autoScaleInterval: 1000, // speed it up
    },
);

if (manager) {
    // We are in master
    const startedAt = Date.now();
    const interval = setInterval(() => {
        const metrics = manager.getMetrics();
        const ready = metrics.workerCount >= 2 && metrics.workers.length === metrics.workerCount;

        if (ready) {
            console.log("METRICS_JSON:" + JSON.stringify(metrics));
            clearInterval(interval);
            process.exit(0);
            return;
        }

        if (Date.now() - startedAt > 12000) {
            console.log("METRICS_JSON:" + JSON.stringify(metrics));
            clearInterval(interval);
            process.exit(1);
        }
    }, 200);
}
