import { run } from "../../src/cluster.js";

run(
    () => {
        // Keep the worker alive until shutdown is requested.
        const keepAlive = setInterval(() => {}, 1000);

        // Log if we receive the shutdown message
        process.on("message", (msg) => {
            if (msg === "shutdown") {
                console.log(`Worker ${process.pid} received shutdown message`);
                clearInterval(keepAlive);
                setTimeout(() => process.exit(0), 20).unref();
            }
        });

        process.on("disconnect", () => {
            clearInterval(keepAlive);
            process.exit(0);
        });

        // Log exit
        process.on("exit", () => {
            console.log(`Worker ${process.pid} exiting`);
        });
    },
    {
        minWorkers: 2,
        mode: "smart",
        shutdownTimeout: 2000, // Short timeout for test
    },
);
