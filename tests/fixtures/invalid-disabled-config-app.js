import { run } from "../../src/cluster.js";

run(() => {}, {
    enabled: false,
    minWorkers: Number.NaN,
});
