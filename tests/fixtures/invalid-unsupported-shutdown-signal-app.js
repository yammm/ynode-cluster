import { run } from "../../src/cluster.js";

run(() => {}, { shutdownSignals: ["SIG_NOT_REAL"] });
