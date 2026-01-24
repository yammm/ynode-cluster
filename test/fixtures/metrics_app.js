import { run } from "../../src/cluster.js";
import http from "node:http";

const manager = run(() => {
    // Worker code
    const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end("hello world\n");
    });
    server.listen(0);
}, {
    minWorkers: 2,
    mode: "smart",
    autoScaleInterval: 1000 // speed it up
});

if (manager) {
    // We are in master
    setTimeout(() => {
        const metrics = manager.getMetrics();
        console.log("METRICS_JSON:" + JSON.stringify(metrics));
        // Force exit to cleanup
        process.exit(0);
    }, 3000);
}
