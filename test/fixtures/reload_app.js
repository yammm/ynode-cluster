import cluster from "node:cluster";
import http from "node:http";

import { run } from "../../src/cluster.js";

const control = run(
    () => {
        http.createServer((req, res) => res.end("ok"))
            .listen(0)
            .on("error", (err) => {
                // Ignore EPIPE/ECONNRESET during reload/shutdown sequences
                if (err.code !== "EPIPE" && err.code !== "ECONNRESET") {
                    console.error("Server error:", err);
                }
            });
        // console.log(`Worker ${process.pid} started`);
        // Send a message to master to log PID?
        // Or just log from worker. Master pipes stdout.
        console.log(`PID:${process.pid}`);
    },
    {
        minWorkers: 2,
        mode: "smart",
        shutdownTimeout: 1000,
    },
);

// Master logic to trigger reload
if (!cluster.isWorker) {
    process.stdin.on("data", async (data) => {
        if (data.toString().includes("reload")) {
            console.log("Master received reload command");
            await control.reload();
            console.log("Reload complete");
        }
    });
}
