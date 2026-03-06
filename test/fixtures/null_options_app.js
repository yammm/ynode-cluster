import { run } from "../../src/cluster.js";
import http from "node:http";
import cluster from "node:cluster";

run(() => {
    const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end("hello world\n");
    });

    server.listen(0, () => {
        setTimeout(() => {
            cluster.worker.disconnect();
            server.close();
        }, 1500);
    });
}, null);
