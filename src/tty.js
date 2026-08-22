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

// Control characters (including ESC and CSI) that would let a worker inject
// ANSI escape sequences into the operator's terminal.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f\x9b]/g;

/**
 * Sanitizes a worker-supplied reply field for terminal output by stripping
 * control characters. Non-string values are treated as absent so callers fall
 * back to their placeholder text.
 * @param {*} value - Worker-supplied reply field.
 * @returns {string|undefined} Sanitized string, or undefined when not a string.
 */
function sanitizeReplyField(value) {
    if (typeof value !== "string") {
        return undefined;
    }

    return value.replace(CONTROL_CHARACTERS, "");
}

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
    let interfaceErrorHandler;
    let outputErrorHandler;
    let attachedOutput;

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
            const appVersion = sanitizeReplyField(reply.appVersion) ?? "—";
            const nodeVersion = sanitizeReplyField(reply.nodeVersion) ?? process.version;
            commandOutput.write(`  Worker ${reply.pid}: ${appVersion} (node ${nodeVersion})\n`);
        }

        if (replies.length < workers.length) {
            commandOutput.write(
                `  (${workers.length - replies.length} worker(s) did not respond)\n`,
            );
        }
    }

    function cleanup() {
        const readlineInterface = state.ttyReadline;
        state.ttyReadline = undefined;
        if (readlineInterface && interfaceErrorHandler) {
            readlineInterface.off("error", interfaceErrorHandler);
        }
        if (attachedOutput && outputErrorHandler && typeof attachedOutput.off === "function") {
            attachedOutput.off("error", outputErrorHandler);
        }
        interfaceErrorHandler = undefined;
        outputErrorHandler = undefined;
        attachedOutput = undefined;
        return readlineInterface;
    }

    function close() {
        const readlineInterface = cleanup();
        readlineInterface?.close();
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
        interfaceErrorHandler = (err) => {
            log.error("TTY input stream failed; disabling command mode.", err);
            close();
        };
        state.ttyReadline.on("error", interfaceErrorHandler);

        if (
            commandOutput !== commandInput &&
            typeof commandOutput.on === "function" &&
            typeof commandOutput.off === "function"
        ) {
            attachedOutput = commandOutput;
            outputErrorHandler = (err) => {
                log.error("TTY output stream failed; disabling command mode.", err);
                close();
            };
            attachedOutput.on("error", outputErrorHandler);
        }
        log.info(`TTY command mode enabled. Type '${reloadCommand}' to reload workers.`);

        const showPrompt = () => {
            if (typeof prompt === "string" && prompt.length > 0 && state.ttyReadline) {
                state.ttyReadline.setPrompt(prompt);
                state.ttyReadline.prompt();
            }
        };

        const handleLine = async (line) => {
            const command = line.trim();

            if (command === reloadCommand) {
                if (state.reloadPromise) {
                    log.info("TTY: reload already in progress.");
                    return;
                }

                log.info("TTY: reload command received.");
                void reload.reload().catch((err) => {
                    log.error("TTY: reload command failed.", err);
                });
                return;
            }

            if (command === "/status") {
                commandOutput.write(buildStatusOutput());
                return;
            }

            if (command === "/ping") {
                await handleTtyPing(commandOutput);
                return;
            }

            if (command === "/version") {
                await handleTtyVersion(commandOutput);
                return;
            }

            if (command.length > 0) {
                const allCommands = [...new Set([reloadCommand, ...TTY_BUILTIN_COMMANDS])];
                commandOutput.write(`TTY commands: ${allCommands.join(", ")}\n`);
            }
        };

        state.ttyReadline.on("line", (line) => {
            void handleLine(line)
                .then(showPrompt)
                .catch((err) => {
                    log.error("TTY command failed; disabling command mode.", err);
                    close();
                });
        });

        state.ttyReadline.on("close", cleanup);

        try {
            showPrompt();
        } catch (err) {
            log.error("TTY prompt failed; disabling command mode.", err);
            close();
        }
    }

    return {
        setup,
        close,
        buildStatusOutput,
    };
}
