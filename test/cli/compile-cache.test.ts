import { spawn } from "node:child_process";
import { describe, it, expect } from "vitest";
import { directory as randomDirectory } from "tempy";
import * as nodeModule from "node:module";
import fs from "node:fs";
import path from "node:path";

// bin/run calls module.enableCompileCache() before importing anything, so the CLI's own
// dist/, @oclif/core and the rest of the dependency closure get bytecode-cached across
// invocations (issue #90). enableCompileCache exists from Node 22.8; skip below it.
const compileCacheSupported = typeof (nodeModule as { enableCompileCache?: unknown }).enableCompileCache === "function";

const runBitsocial = (
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> => {
    return new Promise((resolve, reject) => {
        const proc = spawn("node", ["./bin/run", ...args], { stdio: ["pipe", "pipe", "pipe"], env });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
        proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            reject(new Error(`Timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
        }, timeoutMs);
        proc.on("close", (exitCode) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode });
        });
    });
};

describe.skipIf(!compileCacheSupported)("bin/run enables the V8 compile cache (issue #90)", () => {
    it("populates the default compile-cache dir on a plain --version run", { timeout: 40_000 }, async () => {
        const tmpDir = randomDirectory();
        // enableCompileCache() with no dir and no NODE_COMPILE_CACHE writes to
        // os.tmpdir()/node-compile-cache. Redirect os.tmpdir() to an isolated dir
        // (TMPDIR on POSIX, TEMP/TMP on Windows) so the run can't touch the real cache.
        const cacheDir = path.join(tmpDir, "node-compile-cache");

        // Strip any inherited NODE_COMPILE_CACHE / disable flag so the ONLY thing that can
        // populate cacheDir is bin/run's own enableCompileCache() call, not the env var.
        const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir };
        delete env.NODE_COMPILE_CACHE;
        delete env.NODE_DISABLE_COMPILE_CACHE;

        expect(fs.existsSync(cacheDir), "compile cache dir should not exist before the run").toBe(false);

        const result = await runBitsocial(["--version"], env);
        expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
        expect(result.stdout).toContain("bitsocial-cli");

        expect(fs.existsSync(cacheDir), `expected compile cache to be created at ${cacheDir}`).toBe(true);
        const entries = fs.readdirSync(cacheDir);
        expect(entries.length, `compile cache dir was empty: ${cacheDir}`).toBeGreaterThan(0);
    });

    it("respects NODE_DISABLE_COMPILE_CACHE=1 (no cache written)", { timeout: 40_000 }, async () => {
        const tmpDir = randomDirectory();
        const cacheDir = path.join(tmpDir, "node-compile-cache");

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            TMPDIR: tmpDir,
            TMP: tmpDir,
            TEMP: tmpDir,
            NODE_DISABLE_COMPILE_CACHE: "1"
        };
        delete env.NODE_COMPILE_CACHE;

        const result = await runBitsocial(["--version"], env);
        expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
        // With the cache disabled the dir is never created (CLI still works normally).
        expect(fs.existsSync(cacheDir), `compile cache should be disabled, found ${cacheDir}`).toBe(false);
    });
});
