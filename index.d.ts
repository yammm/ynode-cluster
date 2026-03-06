/**
 * Configuration options for the cluster manager.
 */
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
     * Interval (ms) for auto-scaling checks in "smart" mode.
     * Default: 5000.
     */
    autoScaleInterval?: number;

    /**
     * Signals to listen for to trigger graceful shutdown.
     * Default: ["SIGINT", "SIGTERM", "SIGQUIT"].
     */
    shutdownSignals?: string[];

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
     * Maximum heap usage (MB) for a single worker before it is restarted (Leak Protection).
     * Default: 0 (disabled).
     */
    maxWorkerMemory?: number;

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
     * Time (ms) to wait for old worker disconnect during each reload step.
     * Default: 2000.
     */
    reloadDisconnectWait?: number;
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
    lag: number;
    memory?: number;
    lastSeen: number;
    uptime?: number;
}

/**
 * aggregated metrics for the cluster.
 */
export interface ClusterMetrics {
    workers: WorkerMetrics[];
    totalLag: number;
    avgLag: number;
    workerCount: number;
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
    log?: Console | any,
): ClusterManager | T | Promise<T>;
