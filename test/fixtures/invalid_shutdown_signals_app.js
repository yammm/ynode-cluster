import { run } from "../../src/cluster.js";

run(() => {}, {
    shutdownSignals: "SIGTERM",
    enabled: true,
});
