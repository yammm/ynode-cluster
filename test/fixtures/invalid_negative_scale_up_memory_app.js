import { run } from "../../src/cluster.js";

run(() => {}, {
    scaleUpMemory: -5,
    enabled: true,
});
