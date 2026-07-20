import cluster from "node:cluster";
import http from "node:http";

import { run } from "../src/cluster.js";

const manager = run(
    () => {
        const server = http.createServer((_request, response) => {
            response.end(`Hello from worker ${process.pid}\n`);
        });
        server.on("error", (err) => {
            console.error("Worker server failed", err);
            process.exit(1);
        });

        process.on("message", (message) => {
            if (message === "shutdown") {
                server.close(() => process.exit(0));
            }
        });

        server.listen(Number(process.env.PORT ?? 3000));
        return server;
    },
    {
        mode: "smart",
        minWorkers: 2,
        maxWorkers: 4,
    },
);

if (cluster.isPrimary) {
    manager.on("reload_end", () => console.log("Reload complete"));
    process.on("SIGHUP", () => {
        void manager.reload().catch((err) => console.error("Reload failed", err));
    });
}
