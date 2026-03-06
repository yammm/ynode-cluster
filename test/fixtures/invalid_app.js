import { run } from "../../src/cluster.js";

// Invalid config: minWorkers > maxWorkers
run(() => {}, {
    minWorkers: 5,
    maxWorkers: 2,
    enabled: true,
});
