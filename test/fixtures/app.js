import { run } from "../../src/cluster.js";
import http from "node:http";

process.on("uncaughtException", (err) => {
    if (err.code === "EPIPE") {
        process.exit(0);
    }
    console.error(err);
    process.exit(1);
});

run(() => {
    const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end("hello world\n");
    });

    server.listen(0, () => {
        // console.log("Worker listening");
    });
}, {
    minWorkers: 2,
    mode: "smart",
    enabled: true
});
