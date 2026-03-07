import { run } from "../../src/cluster.js";

run(
    () => {
        console.log("Worker starting...");
        setTimeout(() => {
            console.log("Worker dying...");
            process.exit(1);
        }, 100);
    },
    {
        mode: "max",
        minWorkers: 1,
        maxWorkers: 1,
        norestart: true,
    },
);
