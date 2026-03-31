import cluster from "node:cluster";

import { run } from "../../src/cluster.js";

const control = run(
    () => {
        const keepAlive = setInterval(() => {}, 1000);
        process.on("message", (msg) => {
            if (msg === "shutdown") {
process.exit(0);
}
        });
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
    },
);

if (!cluster.isWorker && control) {
    for (const eventName of [
        "worker_online",
        "reload_start",
        "reload_end",
        "shutdown_start",
        "shutdown_end",
    ]) {
        let count = 0;
        control.on(eventName, () => {
            count += 1;
            console.log(`EVENT:${eventName}:${count}`);
        });
    }

    process.stdin.on("data", async (data) => {
        if (!data.toString().includes("exercise")) {
            return;
        }

        try {
            await Promise.all([control.reload(), control.reload()]);
            console.log("RELOAD_DONE");
            await control.close();
            console.log("CLOSE_DONE");
            process.exit(0);
        } catch (err) {
            console.error("EXERCISE_ERROR", err);
            process.exit(1);
        }
    });
}
