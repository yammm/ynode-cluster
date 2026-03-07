import { run } from "../../src/cluster.js";

run(() => {}, {
    minWorkers: Number.NaN,
    enabled: true,
});
