import { run } from "../../src/cluster.js";
import http from "node:http";

run(() => {
    http.createServer((req, res) => {
        res.end("ok");
    }).listen(0);

    // Log if we receive the shutdown message
    process.on("message", (msg) => {
        if (msg === "shutdown") {
            console.log(`Worker ${process.pid} received shutdown message`);
        }
    });

    // Log exit
    process.on("exit", () => {
        console.log(`Worker ${process.pid} exiting`);
    });
}, {
    minWorkers: 2,
    mode: "smart",
    shutdownTimeout: 2000 // Short timeout for test
});
