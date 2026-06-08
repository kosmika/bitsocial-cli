// Reproduces the `bitsocial update install` restart race (issue #70).
//
// `update install` stops the running daemon, then restarts it with the new binary. The bug:
// it only waits for the daemon's *RPC port* to free before restarting. But the RPC port is
// released by daemonServer.destroy() — which happens *before* the daemon finishes killing its
// kubo child. So the new daemon can be spawned while the old kubo still holds the IPFS API
// port, and it dies on startup with "Cannot start IPFS daemon because the IPFS API port ...
// is already in use" — port 9138 never comes up. This is exactly what was observed in prod
// after updating in place.
//
// The fix makes `update install` wait for the old daemon's PID to actually exit before
// restarting. The daemon's exit hook kills kubo before the process exits, so "PID gone"
// guarantees the kubo API port is free.
//
// How this test pins the race down deterministically:
//   * PKC_CLI_TEST_KUBO_SHUTDOWN_DELAY_MS makes the old daemon hold its kubo alive (and its
//     process alive) for a fixed window after SIGINT, while the RPC port frees immediately.
//   * A `bitsocial` PATH shim is what `update install` spawns for the restart. It records
//     whether the kubo API port is still in use *at the moment of restart*, then exec's the
//     real daemon. That marker — not the eventual daemon state, which self-heals via the
//     watchdog — is the red/green discriminator.
//
// Isolation: the daemon-state directory `update install` enumerates lives under env-paths'
// data dir, which is derived from HOME on every platform (XDG_DATA_HOME only on Linux). We
// override HOME (and XDG_DATA_HOME) for the daemon and the install command so this test sees
// only its own daemon and never stops/restarts other tests' daemons running in parallel.

import { spawn } from "child_process";
import { describe, it, expect, afterEach } from "vitest";
import { directory as randomDirectory } from "tempy";
import { readFileSync } from "fs";
import fs from "fs/promises";
import path from "path";
import {
    stopPkcDaemon,
    startPkcDaemon,
    ensureKuboNodeStopped,
    waitForKuboReady,
    type ManagedChildProcess
} from "../helpers/daemon-helpers.js";

// Ports unique to this file (avoid collisions with other test files and external processes).
const RPC_PORT = 9468;
const KUBO_PORT = 50121;
const GATEWAY_PORT = 6581;
const RPC_URL = `ws://localhost:${RPC_PORT}`;
const KUBO_URL = `http://0.0.0.0:${KUBO_PORT}/api/v0`;
const KUBO_API_URL = `http://localhost:${KUBO_PORT}/api/v0`;
const GATEWAY_URL = `http://0.0.0.0:${GATEWAY_PORT}`;

const CLI_VERSION = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf-8")).version as string;

// How long the old daemon holds kubo alive after SIGINT. Long enough that, with the buggy
// (RPC-port-only) wait, the restart is guaranteed to land inside the window.
const KUBO_SHUTDOWN_DELAY_MS = 8000;

const runUpdateInstall = (env: Record<string, string>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
    return new Promise((resolve, reject) => {
        const proc = spawn("node", ["./bin/run", "update", "install", CLI_VERSION], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...env }
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("error", reject);
        proc.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
};

describe("bitsocial update install restart race (issue #70)", async () => {
    let daemonA: ManagedChildProcess | undefined;
    let restartedPidFile: string | undefined;

    afterEach(async () => {
        if (daemonA) await stopPkcDaemon(daemonA);
        daemonA = undefined;
        // The restarted daemon (B) is detached from update install — the shim recorded its PID.
        if (restartedPidFile) {
            const pids = (await fs.readFile(restartedPidFile, "utf-8").catch(() => ""))
                .split("\n")
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isInteger(n) && n > 0);
            for (const pid of pids) {
                try {
                    process.kill(pid, "SIGINT");
                } catch {
                    /* already gone */
                }
            }
        }
        restartedPidFile = undefined;
        await ensureKuboNodeStopped(KUBO_API_URL);
    });

    it.skipIf(process.platform === "win32")(
        "does not restart the daemon until the old kubo has released the IPFS API port",
        { timeout: 120000 },
        async () => {
            // Isolate the daemon-state directory cross-platform (see file header).
            const isolatedHome = randomDirectory();
            const tmpBin = randomDirectory();
            const markerFile = path.join(randomDirectory(), "restart-kubo-port.marker");
            const pidFile = path.join(path.dirname(markerFile), "restart-daemon.pids");
            restartedPidFile = pidFile;
            const repoRoot = process.cwd();

            // The check script the shim runs: record whether the kubo API port is still bound
            // at the instant update install spawns the restart.
            const checkScript = path.join(tmpBin, "record-kubo-port.cjs");
            await fs.writeFile(
                checkScript,
                [
                    `const net = require("net");`,
                    `const fs = require("fs");`,
                    `const port = Number(new URL(process.env.KUBO_RPC_URL).port);`,
                    `const marker = process.env.PKC_CLI_TEST_RESTART_MARKER;`,
                    `const s = net.connect(port, "127.0.0.1");`,
                    `s.on("connect", () => { fs.appendFileSync(marker, "inuse\\n"); s.destroy(); process.exit(0); });`,
                    `s.on("error", () => { fs.appendFileSync(marker, "free\\n"); process.exit(0); });`,
                    `setTimeout(() => { try { s.destroy(); } catch {} process.exit(0); }, 3000);`
                ].join("\n")
            );

            // The `bitsocial` shim update install will spawn for the restart: record the kubo port
            // state, record this process's PID (it becomes the real daemon via exec), then become
            // the real daemon so it actually comes back up.
            const shim = path.join(tmpBin, "bitsocial");
            await fs.writeFile(
                shim,
                [
                    `#!/bin/sh`,
                    `node "${checkScript}"`,
                    `echo "$$" >> "${pidFile}"`,
                    `exec node "${repoRoot}/bin/run" "$@"`
                ].join("\n") + "\n"
            );
            await fs.chmod(shim, 0o755);

            const sharedEnv = {
                HOME: isolatedHome,
                XDG_DATA_HOME: path.join(isolatedHome, ".local", "share"),
                KUBO_RPC_URL: KUBO_URL,
                IPFS_GATEWAY_URL: GATEWAY_URL
            };

            await ensureKuboNodeStopped(KUBO_API_URL);

            // Start daemon A — a real daemon with a real kubo, writing its state file into the
            // isolated home so update install discovers only this daemon.
            daemonA = await startPkcDaemon(["--pkcRpcUrl", RPC_URL], {
                ...sharedEnv,
                PKC_CLI_TEST_KUBO_SHUTDOWN_DELAY_MS: String(KUBO_SHUTDOWN_DELAY_MS)
            });
            expect(typeof daemonA.pid).toBe("number");
            expect(await waitForKuboReady(KUBO_API_URL, 45000)).toBe(true);

            // Run the real `bitsocial update install <currentVersion>`: same version => skips npm,
            // but runs the full stop + _restartDaemons path. The shim (first on PATH) is what it
            // spawns for the restart.
            const result = await runUpdateInstall({
                ...sharedEnv,
                PATH: `${tmpBin}:${process.env.PATH}`,
                PKC_CLI_TEST_RESTART_MARKER: markerFile
            });

            const marker = await fs.readFile(markerFile, "utf-8").catch(() => "");
            const observations = marker.trim().split("\n").filter(Boolean);

            // Sanity: exactly one daemon was discovered and restarted (the shim ran once). If this
            // is >1 the state dir wasn't isolated and we picked up another test's daemon.
            expect(observations.length, `update install output:\n${result.stdout}\n${result.stderr}`).toBe(1);

            // The fix's contract: when update install restarts the daemon, the old kubo must already
            // be gone. With the bug (wait for RPC port only) this is "inuse" => the restarted daemon
            // collides on the IPFS API port.
            expect(observations[0]).toBe("free");
        }
    );
});
