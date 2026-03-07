import { run } from "../../src/cluster.js";

run(() => {}, {
    shutdownSignals: ["SIGTERM", "SIGTERM"],
    enabled: true,
});
