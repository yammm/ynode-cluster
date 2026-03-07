import { run } from "../../src/cluster.js";

run(() => {}, {
    scaleDownThreshold: -1,
    enabled: true,
});
