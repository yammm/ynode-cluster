import metadata from "@ynode/cluster/package.json" with { type: "json" };
import {
    run,
    type ClusterEvent,
    type ClusterLogger,
    type ClusterManager,
    type ClusterMetrics,
    type ClusterOptions,
    type ReloadHealthCheck,
} from "@ynode/cluster";

const logger: ClusterLogger = {
    debug: (..._args: unknown[]) => {},
    info: (..._args: unknown[]) => {},
    warn: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => {},
};

const healthCheck: ReloadHealthCheck = async (worker, context) => {
    context.signal.throwIfAborted();
    return worker.id > 0 && context.workerCount > 0 && context.oldWorker.id > 0;
};

const options = {
    maxWorkers: 4,
    mode: "smart",
    reloadHealthCheck: healthCheck,
    tty: { commands: true, enabled: true },
} satisfies ClusterOptions;

const result: ClusterManager | void | Promise<void> = run(async () => {}, options, logger);

function consumeManager(manager: ClusterManager): ClusterMetrics {
    const listener = (event: ClusterEvent): void => {
        event.type satisfies string;
    };
    manager.on("worker_online", listener).once("scale_up", listener).off("worker_online", listener);
    return manager.getMetrics();
}

// @ts-expect-error Invalid modes must not be accepted by the public API.
run(() => {}, { mode: "elastic" });

metadata.name satisfies string;
void consumeManager;
void result;
