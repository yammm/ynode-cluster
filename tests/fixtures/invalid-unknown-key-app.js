import { run } from "../../src/cluster.js";

run(() => {}, {
    maxworkers: 2,
});
