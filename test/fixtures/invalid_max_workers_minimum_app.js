import { run } from "../../src/cluster.js";

run(() => {}, {
    maxWorkers: 0,
    enabled: true,
});
