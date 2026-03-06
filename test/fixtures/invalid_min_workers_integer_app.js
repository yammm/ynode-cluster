import { run } from "../../src/cluster.js";

run(() => {}, {
    minWorkers: 1.5,
    enabled: true,
});
