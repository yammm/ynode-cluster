# @ynode/cluster

Copyright (c) 2026 Michael Welter <me@mikinho.com>

[![npm version](https://img.shields.io/npm/v/@ynode/cluster.svg)](https://www.npmjs.com/package/@ynode/cluster) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Smart & Easy Node.js Clustering.**

`@ynode/cluster` removes the complexity of managing Node.js cluster processes. It provides out-of-the-box support for:

- **Smart Auto-Scaling**: Automatically adjusts the worker pool using event-loop lag, heap, and RSS thresholds.
- **Resiliency**: Automatically restarts workers if they crash.
- **Zero-Config Defaults**: Works immediately with sensible defaults, but fully configurable.

## Installation

```bash
npm install @ynode/cluster
```

## Usage

Simply wrap your application startup logic in the `run()` function.

```javascript
import cluster from "node:cluster";

import { run } from "@ynode/cluster";
import Fastify from "fastify";

// Define your worker logic
const startServer = async () => {
    const app = Fastify({ logger: true });

    app.get("/", async () => "Hello from worker " + process.pid);
    process.on("message", (message) => {
        if (message === "shutdown") {
            void app.close().then(
                () => process.exit(0),
                (err) => {
                    app.log.error(err);
                    process.exit(1);
                },
            );
        }
    });

    try {
        await app.listen({ port: 3000 });
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

// Start the cluster
const control = run(startServer, {
    mode: "smart",
    minWorkers: 2,
    maxWorkers: 4,
});

if (cluster.isPrimary) {
    // Manager APIs are available in the primary process only.
    setInterval(() => {
        console.log(control.getMetrics());
    }, 5000);

    // Trigger zero-downtime reload (e.g., on SIGHUP or API call)
    // await control.reload();
}
```

### Zero-Downtime Reload

You can reload the cluster (e.g. after a code deployment) without dropping connections using `control.reload()`. This will:

1. Sequentially start a new worker.
2. Wait for it to come online, and if the old worker was serving traffic, wait for the replacement to become listening.
3. Run the optional replacement health check.
4. Gracefully shut down the old worker and verify that its process exits before continuing.

Only one surge process is permitted during a reload. A replacement that exits, disconnects, or fails the configured health check is reaped without disturbing the original worker. Starting cluster shutdown cancels any active reload.

```js
if (cluster.isPrimary) {
    await control.reload();
    console.log("Reload complete!");
}
```

Use `reloadHealthCheck` when "online" or "listening" is too early for your app to receive traffic. Returning `false`, throwing, rejecting, or exceeding `reloadHealthTimeout` fails the reload before the old worker is retired.

```js
const healthPorts = new Map();

const control = run(startServer, {
    reloadHealthTimeout: 5000,
    reloadHealthCheck: async (worker) => {
        const port = healthPorts.get(worker.id);
        if (!port) {
            return false;
        }
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        return res.ok;
    },
});
```

## Configuration

The `run(startWorker, options)` function accepts the following options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Whether to enable clustering. If `false`, runs `startWorker` directly in the main process. |
| `mode` | `"smart" \| "max"` | `"smart"` | `"smart"` enables auto-scaling based on load. `"max"` spawns `maxWorkers` and keeps them running. |
| `minWorkers` | `number` | `Math.min(2, os.availableParallelism())` | Minimum number of workers to keep alive in "smart" mode. |
| `maxWorkers` | `number` | `os.availableParallelism()` | Maximum active workers; rolling reload may add one temporary surge process. |
| `scaleUpThreshold` | `number` | `50` | Event loop lag (ms) threshold to trigger scaling up. |
| `scaleDownThreshold` | `number` | `10` | Event loop lag (ms) threshold to trigger scaling down. |
| `scalingCooldown` | `number` | `10000` | Minimum time (ms) between scaling actions. |
| `scaleDownGrace` | `number` | `30000` | Grace period (ms) after scaling up before scaling down is allowed. |
| `autoScaleInterval` | `number` | `5000` | Interval (ms) for capacity and smart-mode load-scaling checks. |
| `heartbeatStaleAfter` | `number` | `10000` | Maximum heartbeat age (ms) included in scaling decisions. |
| `shutdownSignals` | `string[]` | `['SIGINT', 'SIGTERM', 'SIGQUIT']` on POSIX | Supported process signals that trigger graceful shutdown. |
| `shutdownTimeout` | `number` | `10000` | Overall shutdown budget per worker; up to two seconds are reserved for SIGTERM/SIGKILL escalation after the graceful IPC shutdown wait. |
| `reloadOnlineTimeout` | `number` | `10000` | Max time (ms) to wait for replacement worker `online` during reload. |
| `reloadListeningTimeout` | `number` | `10000` | Max time (ms) to wait for replacement worker `listening` when replacing a listening worker. |
| `reloadHealthTimeout` | `number` | `10000` | Max time (ms) to wait for `reloadHealthCheck` during reload. |
| `reloadHealthCheck` | `function` | `undefined` | Optional replacement-worker health check. Returning `false`, throwing, rejecting, or timing out fails the reload before the old worker is retired. |
| `reloadDisconnectWait` | `number` | `10000` | Graceful IPC shutdown wait (ms) for the old worker during each reload step before SIGTERM/SIGKILL escalation. |
| `tty` | `object` | `{ enabled: false }` | Optional TTY command mode settings for interactive master commands. |
| `tty.enabled` | `boolean` | `false` | Enables TTY command mode in the master process. |
| `tty.commands` | `boolean` | `true` | Enables command handling when `tty.enabled` is true. |
| `tty.reloadCommand` | `string` | `"/rl"` | Command text that triggers a zero-downtime reload. |
| `tty.stdin` | `Readable` | `process.stdin` | Input stream used for TTY command mode; commands start only when `isTTY === true`. |
| `tty.stdout` | `Writable` | `process.stdout` | Output stream used for TTY command mode. |
| `tty.prompt` | `string` | _(none)_ | Optional prompt text shown by command mode. |
| `scaleUpMemory` | `number` | `0` | Threshold (MB) for average heap usage to trigger scaling up. |
| `scaleUpRss` | `number` | `0` | Threshold (MB) for average resident set size to trigger scaling up. |
| `maxWorkerMemory` | `number` | `0` | Max heap usage (MB) for a worker before restart, evaluated on each heartbeat. |
| `maxWorkerRss` | `number` | `0` | Max resident set size (MB) for a worker before restart, evaluated on each heartbeat. |
| `norestart` | `boolean` | `false` | If true, workers will not be restarted when they die. |

The primary owns process-level termination signals. The first configured signal begins or joins graceful shutdown; any later configured signal immediately kills the remaining workers and exits non-zero. `SIGQUIT` is graceful by default on POSIX. Worker retirement escalates from an IPC shutdown request to `SIGTERM` and finally `SIGKILL`, so the primary never reports a clean shutdown while descendants remain alive.

### TTY Command Mode

When `tty.enabled` is set to `true`, the master process listens to `process.stdin` for operations. By default, the following commands are available:

- `/rl` - Triggers a zero-downtime cluster reload (can be customized via `tty.reloadCommand`).
- `/status` - Displays active/process/desired capacity plus each worker's state, PID, uptime, load lag, heap, RSS, and listening status.
- `/ping` - Pings all active workers over IPC to ensure responsiveness.
- `/version` - Gathers and prints the `appVersion` and Node.js version from all workers.

Workers answer `/ping` and `/version` automatically — no application code is required. The version reply reports the worker's `npm_package_version` (falling back to the `version` field of the `package.json` in its working directory, or `—` when neither is available) plus its Node.js runtime version.

## Accessing Metrics

The `run()` function returns a `ClusterManager` instance (when in cluster mode) which exposes current metrics.

```javascript
const manager = run(startWorker, { mode: "smart" });

// In your monitoring loop or API endpoint:
if (cluster.isPrimary) {
    const metrics = manager.getMetrics();
    console.log(`Current Lag: ${metrics.avgLag.toFixed(2)}ms`);
    console.log(`Active Workers: ${metrics.workerCount}`);
    console.log(`Worker Processes: ${metrics.processCount}`);
    console.log(`Desired Workers: ${metrics.desiredWorkers}`);
}
```

`workerCount` excludes draining workers. `processCount` includes starting, draining, and the single temporary reload surge process. Per-worker metrics expose lifecycle state, listening/readiness state, heartbeat freshness, heap, RSS, external memory, and array-buffer usage.

### Lifecycle Events and Programmatic Shutdown

The returned manager also provides lifecycle events and a programmatic close API:

```javascript
const manager = run(startWorker, { mode: "smart" });

if (cluster.isPrimary) {
    manager.on("scale_up", (event) => console.log("Scaled up:", event));
    manager.on("reload_fail", (event) => console.error("Reload failed:", event.error));

    await manager.reload();
    await manager.close(); // graceful shutdown without sending OS signals
}
```

`close()` settles only after every worker exits. If a process survives the full graceful/termination escalation, `close()` rejects rather than silently leaving an orphan.

Available event names: `worker_online`, `worker_exit`, `worker_restart_scheduled`, `worker_listening`, `scale_up`, `scale_down`, `reload_start`, `reload_end`, `reload_fail`, `shutdown_start`, `shutdown_end`.

## Working with @ynode/autoshutdown

This package works seamlessly with **[@ynode/autoshutdown](https://www.npmjs.com/package/@ynode/autoshutdown)**.

While `@ynode/cluster` manages the **pool size** based on overall system load (scaling up when busy, down when quiet), `@ynode/autoshutdown` manages the **lifecycle of individual workers** based on their specific inactivity.

- **@ynode/cluster**: "We are overloaded, add more workers!" or "We are effectively idle, remove the extra workers."
- **@ynode/autoshutdown**: "I haven't received a request in 10 minutes, I should shut down to save memory."

Using them together ensures optimal resource usage: responsive scaling for traffic spikes and aggressive cleanup for idle periods. A voluntary idle exit can reduce a smart pool, but Cluster reconciles immediately when the exit would cross `minWorkers`. In `mode: "max"`, voluntary exits are replaced to preserve `maxWorkers`.

Autoshutdown must retire a Node cluster worker with `cluster.worker.disconnect()`. Cluster uses Node's `worker.exitedAfterDisconnect` signal to distinguish an intentional idle exit from a crash. A smart pool above its floor reduces `desiredWorkers`; a failed or non-voluntary exit restores the previous desired capacity. The integration suite verifies both the scale-down-above-floor and floor-restoration cases with real worker processes.

Cluster already owns worker heartbeat and heap/RSS retirement. When using the packages together, leave Autoshutdown `reportLoad` disabled and configure memory thresholds with Cluster's `maxWorkerMemory` or `maxWorkerRss`. `@ynode/bootify` enforces this ownership split automatically.

```javascript
import { run } from "@ynode/cluster";
import autoShutdown from "@ynode/autoshutdown";
import Fastify from "fastify";

run(async () => {
    const app = Fastify();

    // Register auto-shutdown to kill this specific worker if it's unused
    await app.register(autoShutdown, {
        sleep: 600, // 10 minutes
    });

    await app.listen({ port: 3000 });
});
```

## License

This project is licensed under the [MIT License](./LICENSE).
