import { run } from "../../src/cluster.js";
import http from "node:http";

const leak = [];

run(() => {
    http.createServer((req, res) => {
        if (req.url === "/leak") {
            // Leak memory
            for (let i = 0; i < 50000; i++) {
                leak.push(new Array(1000).fill("x"));
            }
            console.log(`Leaked. Heap: ${process.memoryUsage().heapUsed / 1024 / 1024} MB`);
            res.end("leaked");
        } else {
            res.end("ok");
        }
    }).listen(0);
}, {
    mode: "smart",
    minWorkers: 1,
    maxWorkers: 1,
    maxWorkerMemory: 1, // Low limit for testing
    autoScaleInterval: 1000 // Fast check
});
