import { run } from "../../src/cluster.js";

run(() => {}, {
    autoScaleInterval: 0,
    enabled: true,
});
