import { run } from "../../src/cluster.js";

run(
    () => {
        setTimeout(() => {
            process.exit(1);
        }, 10);
    },
    {
        mode: "max",
        minWorkers: 1,
        maxWorkers: 1,
    },
);
