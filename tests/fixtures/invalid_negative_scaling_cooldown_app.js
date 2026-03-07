import { run } from "../../src/cluster.js";

run(() => {}, {
    scalingCooldown: -1,
    enabled: true,
});
