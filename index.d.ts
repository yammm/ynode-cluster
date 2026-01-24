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
}

/**
 * Metrics for a single worker.
 */
export interface WorkerMetrics {
    id: string;
    pid?: number;
    lag: number;
    memory?: any;
    lastSeen: number;
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
    mode: string;
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
}

/**
 * Manages the application's clustering.
 * 
 * @param startWorker - The function to execute when a worker process starts.
 * @param options - Configuration object or boolean to enable/disable.
 * @param log - Optional logger instance (defaults to console).
 * @returns A ClusterManager instance if clustering is enabled and we are the master process, otherwise undefined (or the result of startWorker if it returns something, but typically void).
 */
export function run(
    startWorker: () => void | Promise<void>,
    options?: ClusterOptions | boolean,
    log?: Console | any
): ClusterManager | void;
