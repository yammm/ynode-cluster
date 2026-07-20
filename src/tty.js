// ynode/cluster — TTY command mode

/*
The MIT License (MIT)

Copyright (c) 2026 Michael Welter <me@mikinho.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

import { createInterface } from "node:readline";

import { formatMemoryMB, formatUptime } from "./format.js";

const TTY_BUILTIN_COMMANDS = ["/status", "/ping", "/version"];

/**
 * Creates the TTY command-mode controller. When `tty.enabled` is true and
 * stdin is an actual TTY, attaches a readline interface that accepts the
 * configured reload command plus `/status`, `/ping`, `/version`.
 *
 * @param {object} state - Shared cluster state.
 * @param {object} lifecycle - Lifecycle controller.
 * @param {object} reload - Reload controller (for the reload command).
 * @returns {object} TTY controller surface.
 */
export function createTty(state, lifecycle, reload) {
    const { config, log, ttyConfig } = state;
    const { minWorkers, maxWorkers, mode } = config;

    function buildStatusOutput() {
        const now = Date.now();
        const workers = lifecycle.getWorkers();
        const lines = [
            `Master uptime: ${formatUptime(now - state.masterStartTime)}  |  Mode: ${mode}  |  Active: ${lifecycle.getActiveWorkerCount()}  |  Processes: ${workers.length}  |  Desired: ${state.desiredWorkers} (${minWorkers}–${maxWorkers})`,
        ];

        if (workers.length === 0) {
            lines.push("  No active workers.");
            return lines.join("\n") + "\n";
        }

        lines.push("  PID      State       Uptime       Lag     Heap       RSS        Listening");
        lines.push("  ───      ─────       ──────       ───     ────       ───        ─────────");
        for (const worker of workers) {
            const startTime = state.workerStartTimes.get(worker.id);
            const uptime = startTime ? formatUptime(now - startTime) : "—";
            const load = state.workerLoads.get(worker.id);
            const lag = load ? `${load.lag}ms` : "—";
            const stateName = state.workerStates.get(worker.id) ?? "starting";
            const heap = load ? formatMemoryMB(load.memory) : "—";
            const rss = load ? formatMemoryMB(load.rss) : "—";
            const listening = state.listeningWorkers.has(worker.id) ? "yes" : "no";
            lines.push(
                `  ${String(worker.process.pid).padEnd(9)}${stateName.padEnd(12)}${uptime.padEnd(13)}${lag.padEnd(8)}${heap.padEnd(11)}${rss.padEnd(11)}${listening}`,
            );
        }

        return lines.join("\n") + "\n";
    }

    async function handleTtyPing(commandOutput) {
        commandOutput.write("Pinging workers...\n");
        const replies = await lifecycle.collectWorkerReplies("ping");
        const workers = lifecycle.getWorkers();

        if (replies.length === 0) {
            commandOutput.write("  No responses received.\n");
            return;
        }

        for (const reply of replies) {
            commandOutput.write(`  Worker ${reply.pid}: pong\n`);
        }

        if (replies.length < workers.length) {
            commandOutput.write(
                `  (${workers.length - replies.length} worker(s) did not respond)\n`,
            );
        }
    }

    async function handleTtyVersion(commandOutput) {
        commandOutput.write(`Master: node ${process.version}\n`);
        const replies = await lifecycle.collectWorkerReplies("version");
        const workers = lifecycle.getWorkers();

        if (replies.length === 0) {
            commandOutput.write("  No worker responses received.\n");
            return;
        }

        for (const reply of replies) {
            const appVersion = reply.appVersion ?? "—";
            commandOutput.write(
                `  Worker ${reply.pid}: ${appVersion} (node ${reply.nodeVersion ?? process.version})\n`,
            );
        }

        if (replies.length < workers.length) {
            commandOutput.write(
                `  (${workers.length - replies.length} worker(s) did not respond)\n`,
            );
        }
    }

    function close() {
        if (!state.ttyReadline) {
            return;
        }
        state.ttyReadline.close();
        state.ttyReadline = undefined;
    }

    function setup() {
        if (!ttyConfig.enabled || !ttyConfig.commands) {
            return;
        }

        const commandInput = ttyConfig.stdin;
        const commandOutput = ttyConfig.stdout;
        const reloadCommand = ttyConfig.reloadCommand;
        const prompt = ttyConfig.prompt;

        if (commandInput.isTTY !== true) {
            log.info("TTY command mode skipped (non-TTY stdin).");
            return;
        }

        state.ttyReadline = createInterface({
            input: commandInput,
            output: commandOutput,
            terminal: true,
        });
        log.info(`TTY command mode enabled. Type '${reloadCommand}' to reload workers.`);

        const showPrompt = () => {
            if (typeof prompt === "string" && prompt.length > 0 && state.ttyReadline) {
                state.ttyReadline.setPrompt(prompt);
                state.ttyReadline.prompt();
            }
        };

        state.ttyReadline.on("line", async (line) => {
            const command = line.trim();

            if (command === reloadCommand) {
                if (state.reloadPromise) {
                    log.info("TTY: reload already in progress.");
                    showPrompt();
                    return;
                }

                log.info("TTY: reload command received.");
                reload.reload().catch((err) => {
                    log.error("TTY: reload command failed.", err);
                });
                showPrompt();
                return;
            }

            if (command === "/status") {
                commandOutput.write(buildStatusOutput());
                showPrompt();
                return;
            }

            if (command === "/ping") {
                await handleTtyPing(commandOutput);
                showPrompt();
                return;
            }

            if (command === "/version") {
                await handleTtyVersion(commandOutput);
                showPrompt();
                return;
            }

            if (command.length > 0) {
                const allCommands = [...new Set([reloadCommand, ...TTY_BUILTIN_COMMANDS])];
                commandOutput.write(`TTY commands: ${allCommands.join(", ")}\n`);
            }
            showPrompt();
        });

        state.ttyReadline.on("close", () => {
            if (state.ttyReadline) {
                state.ttyReadline = undefined;
            }
        });

        showPrompt();
    }

    return {
        setup,
        close,
        buildStatusOutput,
    };
}
