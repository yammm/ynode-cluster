import { resolve } from "node:path";

import ynodeCluster from "../src/plugin.js";

// Initialize a robust, auto-scaling, zero-downtime cluster
// This will spawn worker processes pointing to a target Fastify application file.
ynodeCluster({
    app: () => import(resolve(process.cwd(), "./example/worker.js")),
    workers: 2, // Start with a strict 2 process baseline
    autoScale: true,
    autoRestart: true,
});
