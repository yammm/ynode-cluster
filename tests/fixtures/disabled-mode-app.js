import { run } from "../../src/cluster.js";

run(
    () => {
        console.log(`DISABLED_MODE_WORKER:${process.pid}`);
    },
    {
        enabled: false,
        minWorkers: 1,
        maxWorkers: 1,
    },
);
