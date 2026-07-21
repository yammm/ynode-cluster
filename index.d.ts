import type * as cluster from "node:cluster";

/**
 * Configuration options for the cluster manager.
 */
export interface ClusterTtyOptions {
    /**
     * Enables TTY command mode in the master process.
     * Default: false.
     */
    enabled?: boolean;

    /**
     * Enables stdin command handling when TTY is enabled.
     * Default: true.
     */
    commands?: boolean;

    /**
     * Command that triggers cluster reload.
     * Default: "/rl".
     */
    reloadCommand?: string;

    /**
     * Input stream for command mode.
     * Command handling starts only when isTTY is true.
     * Default: process.stdin.
     */
    stdin?: NodeJS.ReadableStream & { isTTY?: boolean };

    /**
     * Output stream for command mode.
     * Default: process.stdout.
     */
    stdout?: NodeJS.WritableStream;

    /**
     * Optional command prompt text.
     */
    prompt?: string;
}

export interface ClusterLogger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

export interface ReloadHealthCheckContext {
    oldWorker: cluster.Worker;
    signal: AbortSignal;
    workerCount: number;
}

export type ReloadHealthCheck = (
    worker: cluster.Worker,
    context: ReloadHealthCheckContext,
) => boolean | void | Promise<boolean | void>;

export interface ClusterOptions {
    /**
     * Whether clustering is enabled. Default: true.
     */
    enabled?: boolean;

    /**
     * Minimum number of workers to keep alive in "smart" mode.
     * Default: 2 (or available parallelism if lower).
     */
    minWorkers?: number;

    /**
     * Maximum number of workers.
     * Default: os.availableParallelism().
     */
    maxWorkers?: number;

    /**
     * Event loop lag (ms) threshold to trigger scaling up.
     * Default: 50.
     */
    scaleUpThreshold?: number;

    /**
     * Event loop lag (ms) threshold to trigger scaling down.
     * Default: 10.
     */
    scaleDownThreshold?: number;

    /**
     * Clustering mode.
     * "smart": Auto-scales based on load.
     * "max": Starts maxWorkers and maintains them.
     * Default: "smart".
     */
    mode?: "smart" | "max";

    /**
     * Minimum time (ms) to wait between scaling actions.
     * Default: 10000.
     */
    scalingCooldown?: number;

    /**
     * Grace period (ms) after scaling up before scaling down is allowed.
     * Default: 30000.
     */
    scaleDownGrace?: number;

    /**
     * Interval (ms) for capacity and load-scaling checks.
     * Default: 5000.
     */
    autoScaleInterval?: number;

    /**
     * Maximum age (ms) of a heartbeat used for scaling decisions.
     * Default: 10000.
     */
    heartbeatStaleAfter?: number;

    /**
     * Signals to listen for to trigger graceful shutdown.
     * Default: ["SIGINT", "SIGTERM", "SIGQUIT"].
     */
    shutdownSignals?: NodeJS.Signals[];

    /**
     * Time (ms) to wait for workers to shutdown before forced exit.
     * Default: 10000.
     */
    shutdownTimeout?: number;

    /**
     * Threshold (MB) for average heap usage to trigger scaling up.
     * Default: 0 (disabled).
     */
    scaleUpMemory?: number;

    /**
     * Threshold (MB) for average RSS to trigger scaling up.
     * Default: 0 (disabled).
     */
    scaleUpRss?: number;

    /**
     * Maximum heap usage (MB) for a single worker before it is restarted, checked on heartbeat.
     * Default: 0 (disabled).
     */
    maxWorkerMemory?: number;

    /**
     * Maximum RSS (MB) for a single worker before it is restarted, checked on heartbeat.
     * Default: 0 (disabled).
     */
    maxWorkerRss?: number;

    /**
     * If true, workers will not be restarted when they die.
     * Default: false.
     */
    norestart?: boolean;

    /**
     * Timeout (ms) waiting for replacement worker to emit "online" during reload.
     * Default: 10000.
     */
    reloadOnlineTimeout?: number;

    /**
     * Timeout (ms) waiting for replacement worker to emit "listening" during reload.
     * Default: 10000.
     */
    reloadListeningTimeout?: number;

    /**
     * Timeout (ms) waiting for reloadHealthCheck during reload.
     * Default: 10000.
     */
    reloadHealthTimeout?: number;

    /**
     * Optional health check for a replacement worker during reload. Returning false,
     * throwing, rejecting, or timing out fails the reload before the old worker is retired.
     */
    reloadHealthCheck?: ReloadHealthCheck;

    /**
     * Time (ms) to wait for old worker disconnect during each reload step.
     * Default: 10000.
     */
    reloadDisconnectWait?: number;

    /**
     * Optional TTY command mode settings.
     */
    tty?: ClusterTtyOptions;
}

export type ClusterEventName =
    | "worker_online"
    | "worker_exit"
    | "worker_restart_scheduled"
    | "worker_listening"
    | "scale_up"
    | "scale_down"
    | "reload_start"
    | "reload_end"
    | "reload_fail"
    | "shutdown_start"
    | "shutdown_end";

export interface ClusterEvent {
    type: ClusterEventName;
    [key: string]: unknown;
}

/**
 * Metrics for a single worker.
 */
export interface WorkerMetrics {
    id: number;
    pid?: number;
    state: "starting" | "online" | "listening" | "draining";
    listening: boolean;
    lag?: number;
    memory?: number;
    rss?: number;
    external?: number;
    arrayBuffers?: number;
    lastSeen?: number;
    stale: boolean;
    uptime?: number;
}

/**
 * aggregated metrics for the cluster.
 */
export interface ClusterMetrics {
    workers: WorkerMetrics[];
    totalLag: number;
    avgLag: number;
    /** Active workers, excluding workers currently draining. */
    workerCount: number;
    /** Total OS worker processes, including a reload surge or draining worker. */
    processCount: number;
    desiredWorkers: number;
    maxWorkers: number;
    minWorkers: number;
    scaleUpThreshold: number;
    scaleDownThreshold: number;
    mode: "smart" | "max";
}

/**
 * The cluster manager instance.
 */
export interface ClusterManager {
    /**
     * Returns the current metrics of the cluster.
     */
    getMetrics: () => ClusterMetrics;
    reload: () => Promise<void>;
    close: () => Promise<void>;
    on: (eventName: ClusterEventName, listener: (event: ClusterEvent) => void) => ClusterManager;
    once: (eventName: ClusterEventName, listener: (event: ClusterEvent) => void) => ClusterManager;
    off: (eventName: ClusterEventName, listener: (event: ClusterEvent) => void) => ClusterManager;
}

/**
 * Manages the application's clustering.
 *
 * @param startWorker - The function to execute when a worker process starts.
 * @param options - Configuration object or boolean to enable/disable.
 * @param log - Optional logger instance (defaults to console).
 * @returns A ClusterManager instance if clustering is enabled and we are the master process, otherwise the return value from startWorker.
 */
export function run<T = void>(
    startWorker: () => T | Promise<T>,
    options?: ClusterOptions | boolean,
    log?: ClusterLogger,
): ClusterManager | T | Promise<T>;
