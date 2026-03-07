import cluster from "node:cluster";

import { run } from "../../src/cluster.js";

const control = run(
    () => {
        const keepAlive = setInterval(() => {}, 1000);
        process.on("disconnect", () => {
            clearInterval(keepAlive);
            process.exit(0);
        });
    },
    {
        mode: "max",
        minWorkers: 1,
        maxWorkers: 1,
        shutdownTimeout: 1000,
        norestart: true,
    },
);

if (!cluster.isWorker && control) {
    // Make reload fail deterministically on replacement spawn.
    cluster.fork = () => {
        throw new Error("simulated-fork-failure");
    };

    process.stdin.on("data", async (data) => {
        if (!data.toString().includes("exercise")) {
            return;
        }

        const results = await Promise.allSettled([control.reload(), control.reload()]);
        const statuses = results.map((r) => r.status).join(",");
        console.log(`RELOAD_RESULTS:${statuses}`);

        if (results[0].status === "rejected" && results[1].status === "rejected") {
            const msgA = String(results[0].reason?.message ?? results[0].reason);
            const msgB = String(results[1].reason?.message ?? results[1].reason);
            console.log(`RELOAD_ERROR_A:${msgA}`);
            console.log(`RELOAD_ERROR_B:${msgB}`);
        }

        await control.close();
        process.exit(0);
    });
}
