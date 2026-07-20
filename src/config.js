// ynode/cluster — configuration validation and defaults

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

import os from "node:os";

export const DEFAULT_TTY_RELOAD_COMMAND = "/rl";
const VALID_MODES = new Set(["smart", "max"]);
const DEFAULT_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT"].filter((signal) =>
    Object.hasOwn(os.constants.signals ?? {}, signal),
);

const NUMERIC_CONFIG_KEYS = [
    "minWorkers",
    "maxWorkers",
    "scaleUpThreshold",
    "scaleDownThreshold",
    "scalingCooldown",
    "scaleDownGrace",
    "autoScaleInterval",
    "heartbeatStaleAfter",
    "shutdownTimeout",
    "scaleUpMemory",
    "scaleUpRss",
    "maxWorkerMemory",
    "maxWorkerRss",
    "reloadOnlineTimeout",
    "reloadListeningTimeout",
    "reloadDisconnectWait",
];

const NON_NEGATIVE_NUMERIC_CONFIG_KEYS = [
    "scalingCooldown",
    "scaleDownGrace",
    "autoScaleInterval",
    "heartbeatStaleAfter",
    "shutdownTimeout",
    "scaleUpMemory",
    "scaleUpRss",
    "maxWorkerMemory",
    "maxWorkerRss",
];

/**
 * Tests whether the given value is a plain options object (not null, not an array).
 * @param {*} options - Candidate options value.
 * @returns {boolean} True when the value is a non-array plain object.
 */
export function isOptionsObject(options) {
    return options !== null && typeof options === "object" && !Array.isArray(options);
}

/**
 * Resolves whether clustering is enabled given the raw user-supplied options.
 * Accepts an options object with an `enabled` flag, a bare boolean, or undefined.
 * @param {object|boolean} options - Raw options passed to run().
 * @returns {boolean} True when clustering should run in master mode.
 * @throws {Error} If options.enabled is set to a non-boolean value.
 */
export function resolveClusteringEnabled(options) {
    if (isOptionsObject(options)) {
        if (options.enabled === undefined) {
            return true;
        }

        if (typeof options.enabled !== "boolean") {
            throw new Error(
                `Invalid configuration: enabled (${options.enabled}) must be a boolean`,
            );
        }

        return options.enabled;
    }

    if (typeof options === "boolean") {
        return options;
    }

    return true;
}

/**
 * Builds a fully-defaulted cluster configuration object from the user-supplied
 * options. Numeric defaults reflect a smart-mode auto-scaling profile with
 * conservative shutdown and reload timeouts.
 * @param {object|boolean} options - Raw options passed to run().
 * @returns {object} Cluster configuration with all defaults applied.
 */
export function buildClusterConfig(options) {
    const cpuCount = os.availableParallelism();
    const rawOptions = isOptionsObject(options) ? options : {};

    return {
        minWorkers: Math.min(2, cpuCount),
        maxWorkers: cpuCount,
        scaleUpThreshold: 50,
        scaleDownThreshold: 10,
        mode: "smart",
        scalingCooldown: 10000,
        scaleDownGrace: 30000,
        autoScaleInterval: 5000,
        heartbeatStaleAfter: 10000,
        shutdownSignals: [...DEFAULT_SHUTDOWN_SIGNALS],
        shutdownTimeout: 10000,
        scaleUpMemory: 0,
        scaleUpRss: 0,
        maxWorkerMemory: 0,
        maxWorkerRss: 0,
        norestart: false,
        reloadOnlineTimeout: 10000,
        reloadListeningTimeout: 10000,
        reloadDisconnectWait: 10000,
        ...rawOptions,
    };
}

function validateFiniteNumericConfig(config) {
    for (const key of NUMERIC_CONFIG_KEYS) {
        const value = config[key];
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`Invalid configuration: ${key} (${value}) must be a finite number`);
        }
    }
}

function validateNonNegativeNumericConfig(config) {
    for (const key of NON_NEGATIVE_NUMERIC_CONFIG_KEYS) {
        const value = config[key];
        if (value < 0) {
            throw new Error(`Invalid configuration: ${key} (${value}) must be >= 0`);
        }
    }
}

function validateTtyConfig(ttyConfig) {
    if (ttyConfig === undefined) {
        return;
    }

    if (!isOptionsObject(ttyConfig)) {
        throw new Error("Invalid configuration: tty must be an object");
    }

    if (ttyConfig.enabled !== undefined && typeof ttyConfig.enabled !== "boolean") {
        throw new Error(
            `Invalid configuration: tty.enabled (${ttyConfig.enabled}) must be a boolean`,
        );
    }

    if (ttyConfig.commands !== undefined && typeof ttyConfig.commands !== "boolean") {
        throw new Error(
            `Invalid configuration: tty.commands (${ttyConfig.commands}) must be a boolean`,
        );
    }

    if (
        ttyConfig.reloadCommand !== undefined &&
        (typeof ttyConfig.reloadCommand !== "string" || ttyConfig.reloadCommand.trim().length === 0)
    ) {
        throw new Error(
            `Invalid configuration: tty.reloadCommand (${ttyConfig.reloadCommand}) must be a non-empty string`,
        );
    }

    if (ttyConfig.stdin !== undefined && typeof ttyConfig.stdin.on !== "function") {
        throw new Error("Invalid configuration: tty.stdin must be a readable stream");
    }

    if (ttyConfig.stdout !== undefined && typeof ttyConfig.stdout.write !== "function") {
        throw new Error("Invalid configuration: tty.stdout must be a writable stream");
    }

    if (ttyConfig.prompt !== undefined && typeof ttyConfig.prompt !== "string") {
        throw new Error(`Invalid configuration: tty.prompt (${ttyConfig.prompt}) must be a string`);
    }
}

/**
 * Builds a fully-defaulted TTY configuration object. When no TTY options are
 * supplied, returns a disabled configuration whose stdin/stdout default to the
 * current process streams.
 * @param {object} [ttyOptions] - Raw tty options nested under cluster options.
 * @returns {object} TTY configuration with all defaults applied.
 */
export function buildTtyConfig(ttyOptions) {
    const rawTty = isOptionsObject(ttyOptions) ? ttyOptions : {};

    return {
        enabled: rawTty.enabled ?? false,
        commands: rawTty.commands ?? true,
        reloadCommand: rawTty.reloadCommand ?? DEFAULT_TTY_RELOAD_COMMAND,
        stdin: rawTty.stdin ?? process.stdin,
        stdout: rawTty.stdout ?? process.stdout,
        prompt: rawTty.prompt,
    };
}

/**
 * Validates a fully-defaulted cluster configuration object. Throws on any
 * invalid value so the master fails fast at startup rather than producing
 * subtle scaling/shutdown misbehavior later.
 * @param {object} config - Cluster configuration to validate.
 * @throws {Error} On any invalid value.
 */
export function validateClusterConfig(config) {
    validateFiniteNumericConfig(config);
    validateNonNegativeNumericConfig(config);
    validateTtyConfig(config.tty);

    if (typeof config.norestart !== "boolean") {
        throw new Error(`Invalid configuration: norestart (${config.norestart}) must be a boolean`);
    }

    if (
        !Array.isArray(config.shutdownSignals) ||
        config.shutdownSignals.some((signal) => typeof signal !== "string" || signal.length === 0)
    ) {
        throw new Error(
            `Invalid configuration: shutdownSignals (${config.shutdownSignals}) must be an array of non-empty strings`,
        );
    }

    if (new Set(config.shutdownSignals).size !== config.shutdownSignals.length) {
        throw new Error(
            `Invalid configuration: shutdownSignals (${config.shutdownSignals}) must not contain duplicates`,
        );
    }

    const supportedSignals = os.constants.signals ?? {};
    const invalidSignal = config.shutdownSignals.find(
        (signal) => !Object.hasOwn(supportedSignals, signal),
    );
    if (invalidSignal) {
        throw new Error(`Invalid configuration: unsupported shutdown signal (${invalidSignal})`);
    }

    if (!Number.isInteger(config.minWorkers) || config.minWorkers < 1) {
        throw new Error(
            `Invalid configuration: minWorkers (${config.minWorkers}) must be an integer >= 1`,
        );
    }

    if (!Number.isInteger(config.maxWorkers) || config.maxWorkers < 1) {
        throw new Error(
            `Invalid configuration: maxWorkers (${config.maxWorkers}) must be an integer >= 1`,
        );
    }

    if (config.autoScaleInterval <= 0) {
        throw new Error(
            `Invalid configuration: autoScaleInterval (${config.autoScaleInterval}) must be greater than 0`,
        );
    }

    if (config.heartbeatStaleAfter <= 0) {
        throw new Error(
            `Invalid configuration: heartbeatStaleAfter (${config.heartbeatStaleAfter}) must be greater than 0`,
        );
    }

    if (config.scaleUpThreshold < 0) {
        throw new Error(
            `Invalid configuration: scaleUpThreshold (${config.scaleUpThreshold}) must be >= 0`,
        );
    }

    if (config.scaleDownThreshold < 0) {
        throw new Error(
            `Invalid configuration: scaleDownThreshold (${config.scaleDownThreshold}) must be >= 0`,
        );
    }

    if (config.minWorkers > config.maxWorkers) {
        throw new Error(
            `Invalid configuration: minWorkers (${config.minWorkers}) cannot be greater than maxWorkers (${config.maxWorkers})`,
        );
    }

    if (!VALID_MODES.has(config.mode)) {
        throw new Error(
            `Invalid configuration: mode (${config.mode}) must be either "smart" or "max"`,
        );
    }

    if (config.scaleUpThreshold <= config.scaleDownThreshold) {
        throw new Error(
            `Invalid configuration: scaleUpThreshold (${config.scaleUpThreshold}) must be greater than scaleDownThreshold (${config.scaleDownThreshold})`,
        );
    }

    if (config.reloadOnlineTimeout <= 0) {
        throw new Error(
            `Invalid configuration: reloadOnlineTimeout (${config.reloadOnlineTimeout}) must be greater than 0`,
        );
    }

    if (config.reloadListeningTimeout <= 0) {
        throw new Error(
            `Invalid configuration: reloadListeningTimeout (${config.reloadListeningTimeout}) must be greater than 0`,
        );
    }

    if (config.reloadDisconnectWait <= 0) {
        throw new Error(
            `Invalid configuration: reloadDisconnectWait (${config.reloadDisconnectWait}) must be greater than 0`,
        );
    }
}
