import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { join } from "node:path";

export function getFixturePath(fixtureName) {
    return join(process.cwd(), "test", "fixtures", fixtureName);
}

export function spawnFixture(fixtureName, options = {}) {
    const { env = {}, stdio = "pipe", ...rest } = options;

    return spawn("node", [getFixturePath(fixtureName)], {
        stdio,
        env: { ...process.env, ...env },
        ...rest,
    });
}

export async function expectFixtureFailure(fixtureName, stderrPattern, { timeoutMs = 10000 } = {}) {
    await new Promise((resolve, reject) => {
        const child = spawnFixture(fixtureName);
        let stderr = "";
        let output = "";
        let settled = false;

        const finish = (fn) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            try {
                child.stdout?.removeAllListeners();
                child.stderr?.removeAllListeners();
                child.removeAllListeners();
            } catch (err) {
                console.debug(err);
            }
            fn();
        };

        const timeout = setTimeout(() => {
            finish(() => {
                try {
                    child.kill("SIGKILL");
                } catch (err) {
                    console.debug(err);
                }
                reject(new Error(`Timeout waiting for fixture ${fixtureName}. Output:\n${output}`));
            });
        }, timeoutMs).unref();

        child.stdout.on("data", (data) => {
            output += data.toString();
        });

        child.stderr.on("data", (data) => {
            const str = data.toString();
            stderr += str;
            output += str;
        });

        child.on("close", (code) => {
            finish(() => {
                try {
                    assert.notEqual(code, 0, "Process should exit with error code");
                    assert.match(stderr, stderrPattern);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });

        child.on("error", (err) => {
            finish(() => reject(err));
        });
    });
}
