// ynode/cluster — display formatting utilities

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

/**
 * Formats a duration in milliseconds as a human-readable uptime string.
 * Omits zero-valued leading units (e.g. "5s", "1m 30s", "2h 10m 5s").
 * @param {number} ms - Duration in milliseconds.
 * @returns {string} Formatted uptime.
 */
export function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const parts = [];
    if (days > 0) {
        parts.push(`${days}d`);
    }
    if (hours > 0) {
        parts.push(`${hours}h`);
    }
    if (minutes > 0) {
        parts.push(`${minutes}m`);
    }
    parts.push(`${secs}s`);
    return parts.join(" ");
}

/**
 * Formats a memory measurement in bytes as a megabyte string with one
 * decimal of precision. Returns an em dash for non-finite input so the
 * status output stays aligned for workers that have not yet reported a
 * heartbeat.
 * @param {number} bytes - Memory measurement in bytes.
 * @returns {string} Formatted memory string (e.g. "12.3 MB" or "—").
 */
export function formatMemoryMB(bytes) {
    if (!Number.isFinite(bytes)) {
        return "—";
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
