# @ynode/cluster

Copyright (c) 2025 Michael Welter <me@mikinho.com>

[![npm version](https://img.shields.io/npm/v/@ynode/cluster.svg)](https://www.npmjs.com/package/@ynode/cluster)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Smart & Easy Node.js Clustering.**

`@ynode/cluster` removes the complexity of managing Node.js cluster processes. It provides out-of-the-box support for:
- **Smart Auto-Scaling**: Automatically spawns and kills workers based on Event Loop Lag (CPU load).
- **Resiliency**: Automatically restarts workers if they crash.
- **Zero-Config Defaults**: Works immediately with sensible defaults, but fully configurable.

## Installation

```bash
npm install @ynode/cluster
```

## Usage

Simply wrap your application startup logic in the `run()` function.

```javascript
import { run } from "@ynode/cluster";
import Fastify from "fastify";

// Define your worker logic
const startServer = async () => {
    const app = Fastify({ logger: true });

    app.get("/", async () => "Hello from worker " + process.pid);

    try {
        await app.listen({ port: 3000 });
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

// Start the cluster
run(startServer, {
    mode: "smart", // Enable auto-scaling (default)
    minWorkers: 2,
    maxWorkers: 8 // Default is os.availableParallelism()
});
```

## Configuration

The `run(startWorker, options)` function accepts the following options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Whether to enable clustering. If `false`, runs `startWorker` directly in the main process. |
| `mode` | `"smart" \| "max"` | `"smart"` | `"smart"` enables auto-scaling based on load. `"max"` spawns `maxWorkers` and keeps them running. |
| `minWorkers` | `number` | `2` | Minimum number of workers to keep alive in "smart" mode. |
| `maxWorkers` | `number` | `os.cpus()` | Maximum number of workers to spawn. |
| `scaleUpThreshold` | `number` | `50` | Event loop lag (ms) threshold to trigger scaling up. |
| `scaleDownThreshold` | `number` | `10` | Event loop lag (ms) threshold to trigger scaling down. |
| `scalingCooldown` | `number` | `10000` | Minimum time (ms) between scaling actions. |
| `scaleDownGrace` | `number` | `30000` | Grace period (ms) after scaling up before scaling down is allowed. |
| `autoScaleInterval` | `number` | `5000` | Interval (ms) for auto-scaling checks in "smart" mode. |
| `shutdownSignals` | `string[]` | `['SIGINT', 'SIGTERM', 'SIGQUIT']` | Signals to listen for to trigger graceful shutdown. |
| `shutdownTimeout` | `number` | `10000` | Time (ms) to wait for workers to shutdown before forced exit. |
 
## Accessing Metrics
 
The `run()` function returns a `ClusterManager` instance (when in cluster mode) which exposes current metrics.
 
```javascript
const manager = run(startWorker, { mode: "smart" });
 
// In your monitoring loop or API endpoint:
if (manager) {
    const metrics = manager.getMetrics();
    console.log(`Current Lag: ${metrics.avgLag.toFixed(2)}ms`);
    console.log(`Active Workers: ${metrics.workerCount}`);
}
```

## Working with @ynode/autoshutdown

This package works seamlessly with **[@ynode/autoshutdown](https://www.npmjs.com/package/@ynode/autoshutdown)**.

While `@ynode/cluster` manages the **pool size** based on overall system load (scaling up when busy, down when quiet), `@ynode/autoshutdown` manages the **lifecycle of individual workers** based on their specific inactivity.

- **@ynode/cluster**: "We are overloaded, add more workers!" or "We are effectively idle, remove the extra workers."3
- **@ynode/autoshutdown**: "I haven't received a request in 10 minutes, I should shut down to save memory."

Using them together ensures optimal resource usage: responsive scaling for traffic spikes and aggressive cleanup for idle periods.

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