import { run } from "../../src/cluster.js";

run(
    () => {
        setInterval(() => {}, 1000);
        console.log(`HUNG_WORKER_PID:${process.pid}`);

        process.on("message", (message) => {
            if (message === "shutdown") {
                console.log(`IGNORED_SHUTDOWN:${process.pid}`);
            }
        });
        process.on("SIGTERM", () => {
            console.log(`IGNORED_SIGTERM:${process.pid}`);
        });
    },
    {
        mode: "max",
        minWorkers: 1,
        maxWorkers: 1,
        shutdownTimeout: 100,
    },
);
