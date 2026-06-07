import { describe, it, beforeAll, afterAll, afterEach, beforeEach, expect } from "vitest";
import Sinon from "sinon";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { directory as randomDirectory } from "tempy";
import envPaths from "env-paths";
import { clearPkcRpcConnectOverride, setPkcRpcConnectOverride } from "../helpers/pkc-test-overrides.js";
import { runCliCommand } from "../helpers/run-cli.js";
import Daemon from "../../src/cli/commands/daemon.js";

const EXPORT_ID = "11111111-2222-3333-4444-555555555555";
const COMMUNITY_ADDRESS = "plebbit.bso";

const snapshotContent = Buffer.from("fake sqlite snapshot content for community export test");
const snapshotSha256 = createHash("sha256").update(snapshotContent).digest("hex");

type FakeExportRecord = {
    exportId: string;
    publicKey: string;
    includePrivateKey: boolean;
    progress: number;
    size?: number;
    sha256?: string;
    url?: string;
    error?: { code: string; message: string };
};

describe("bitsocial community export", () => {
    const sandbox = Sinon.createSandbox();

    let httpServer: http.Server;
    let serverPort: number;
    let downloadUrl: string;
    let defaultDownloadUrl: string;
    let rpcUrlFlag: string; // --pkcRpcUrl matching the test http server's origin, so the download URL passes origin validation
    let servedContent: Buffer; // what the http server streams for the download
    let serverRequestPaths: string[] = [];
    let serverStatusCode: number; // status code the http server responds with
    let destroyMidResponse: boolean; // server kills the socket after a few bytes

    let exportFake: Sinon.SinonSpy;
    const destroyFake = sandbox.fake();
    let createCommunityFake: Sinon.SinonSpy;
    let failExportWith: { code: string; message: string } | undefined;
    let omitUrl: boolean; // terminal export record has no url
    let omitSha256: boolean; // terminal export record has no sha256
    let tmpDir: string;

    const makeFakeCommunity = () => {
        const emitter = new EventEmitter();
        const records: FakeExportRecord[] = [];
        exportFake = sandbox.fake(async (options?: { includePrivateKey?: boolean; signal?: AbortSignal }) => {
            const record: FakeExportRecord = {
                exportId: EXPORT_ID,
                publicKey: "12D3KooWTest",
                includePrivateKey: Boolean(options?.includePrivateKey),
                progress: 0
            };
            records.push(record);
            // Emit progress transitions asynchronously, like the real RPC subscription does
            setTimeout(() => {
                record.progress = 0.5;
                emitter.emit("exportschange", [...records]);
                if (failExportWith) record.error = failExportWith;
                else {
                    record.progress = 1;
                    record.size = snapshotContent.length;
                    if (!omitSha256) record.sha256 = snapshotSha256;
                    if (!omitUrl) record.url = downloadUrl;
                }
                emitter.emit("exportschange", [...records]);
            }, 10);
            return { exportId: EXPORT_ID };
        });
        return {
            address: COMMUNITY_ADDRESS,
            on: emitter.on.bind(emitter),
            removeListener: emitter.removeListener.bind(emitter),
            get exports() {
                return [...records];
            },
            export: exportFake
        };
    };

    beforeAll(async () => {
        // Isolate the default data path (used for the default export destination) to a temp dir.
        // env-paths reads XDG_DATA_HOME on linux, and dist's defaults.ts evaluates it lazily when
        // oclif first loads the export command — i.e. after this hook. Each test file runs in its
        // own fork (vitest pool: "forks"), so this doesn't leak to other files.
        process.env["XDG_DATA_HOME"] = randomDirectory();

        httpServer = http.createServer((req, res) => {
            serverRequestPaths.push(req.url ?? "");
            if (destroyMidResponse) {
                // Announce the full length, send a few bytes, then kill the socket so the
                // client sees a premature close mid-download
                res.writeHead(200, { "Content-Length": String(servedContent.length) });
                res.write(servedContent.subarray(0, 10));
                res.destroy();
                return;
            }
            res.statusCode = serverStatusCode;
            res.end(servedContent);
        });
        await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
        serverPort = (httpServer.address() as import("node:net").AddressInfo).port;
        defaultDownloadUrl = `http://127.0.0.1:${serverPort}/exports/${EXPORT_ID}`;
        downloadUrl = defaultDownloadUrl;
        rpcUrlFlag = `--pkcRpcUrl ws://127.0.0.1:${serverPort}`;

        createCommunityFake = sandbox.fake(async () => makeFakeCommunity());
        const pkcInstanceFake = sandbox.fake.resolves({
            createCommunity: createCommunityFake,
            destroy: destroyFake
        });
        setPkcRpcConnectOverride(pkcInstanceFake);
    });

    beforeEach(() => {
        tmpDir = randomDirectory();
        servedContent = snapshotContent;
        serverRequestPaths = [];
        serverStatusCode = 200;
        destroyMidResponse = false;
        failExportWith = undefined;
        omitUrl = false;
        omitSha256 = false;
        downloadUrl = defaultDownloadUrl;
    });

    afterEach(() => {
        createCommunityFake.resetHistory();
        destroyFake.resetHistory();
    });

    afterAll(async () => {
        clearPkcRpcConnectOverride();
        sandbox.restore();
        await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
    });

    it("Exports a community, downloads the snapshot, verifies sha256 and prints the destination path", async () => {
        const destPath = path.join(tmpDir, "plebbit.sqlite");
        const { result, stdout } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeUndefined();
        expect(createCommunityFake.calledOnceWith({ address: COMMUNITY_ADDRESS })).toBe(true);
        expect(exportFake.calledOnce).toBe(true);
        expect(exportFake.args[0][0].includePrivateKey).toBe(false);
        expect(serverRequestPaths).toEqual([`/exports/${EXPORT_ID}`]);
        expect(destroyFake.calledOnce).toBe(true);

        expect(stdout.trim()).toBe(destPath);
        // --quiet suppresses all progress output
        expect(result.stderr).not.toContain("Exporting");
        expect(result.stderr).not.toContain("Downloading");
        const downloaded = await fs.readFile(destPath);
        expect(downloaded.equals(snapshotContent)).toBe(true);
        // No leftover .partial file
        await expect(fs.stat(destPath + ".partial")).rejects.toThrow();
    });

    it("Requests the private key with --includePrivateKey", async () => {
        const destPath = path.join(tmpDir, "with-key.sqlite");
        const { result } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --includePrivateKey --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeUndefined();
        expect(exportFake.calledOnce).toBe(true);
        expect(exportFake.args[0][0].includePrivateKey).toBe(true);
    });

    it("Looks up community by --name", async () => {
        const destPath = path.join(tmpDir, "by-name.sqlite");
        const { result } = await runCliCommand(`community export --name my-community --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeUndefined();
        expect(createCommunityFake.calledOnceWith({ name: "my-community" })).toBe(true);
    });

    it("Looks up community by --publicKey", async () => {
        const destPath = path.join(tmpDir, "by-publickey.sqlite");
        const { result } = await runCliCommand(`community export --publicKey 12D3KooWTest --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeUndefined();
        expect(createCommunityFake.calledOnceWith({ publicKey: "12D3KooWTest" })).toBe(true);
    });

    it("Errors when no identifier is provided", async () => {
        const { result } = await runCliCommand("community export");

        expect(result.error).toBeDefined();
        expect(createCommunityFake.called).toBe(false);
    });

    it("Refuses to overwrite an existing destination file without --force", async () => {
        const destPath = path.join(tmpDir, "existing.sqlite");
        await fs.writeFile(destPath, "previous backup");

        const { result, stderr } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeDefined();
        expect(stderr).toContain("already exists");
        // Existing file untouched, no export started
        expect((await fs.readFile(destPath)).toString()).toBe("previous backup");
        expect(exportFake.called).toBe(false);
        expect(destroyFake.calledOnce).toBe(true); // no leaked RPC connection on failure
    });

    it("Overwrites an existing destination file with --force", async () => {
        const destPath = path.join(tmpDir, "existing.sqlite");
        await fs.writeFile(destPath, "previous backup");

        const { result } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet --force -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeUndefined();
        const downloaded = await fs.readFile(destPath);
        expect(downloaded.equals(snapshotContent)).toBe(true);
    });

    it("Fails and leaves no file behind when the downloaded sha256 does not match the export record", async () => {
        servedContent = Buffer.from("corrupted content that does not match the record's sha256");
        const destPath = path.join(tmpDir, "corrupted.sqlite");

        const { result, stderr } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeDefined();
        expect(stderr).toContain("sha256 mismatch");
        await expect(fs.stat(destPath)).rejects.toThrow();
        await expect(fs.stat(destPath + ".partial")).rejects.toThrow();
        expect(destroyFake.calledOnce).toBe(true); // no leaked RPC connection on failure
    });

    it("Fails when the export record reports an error (e.g. private key export not allowed)", async () => {
        failExportWith = { code: "ERR_PRIVATE_KEY_EXPORT_NOT_ALLOWED", message: "The RPC server does not allow private key exports" };
        const destPath = path.join(tmpDir, "not-allowed.sqlite");

        const { result, stderr } = await runCliCommand(
            `community export ${COMMUNITY_ADDRESS} --includePrivateKey --quiet -o ${destPath}`
        );

        expect(result.error).toBeDefined();
        expect(stderr).toContain("ERR_PRIVATE_KEY_EXPORT_NOT_ALLOWED");
        await expect(fs.stat(destPath)).rejects.toThrow();
        expect(destroyFake.calledOnce).toBe(true); // no leaked RPC connection on failure
    });

    it("Refuses to download when the export record's URL is not on the RPC server's origin", async () => {
        downloadUrl = `http://evil.example.com/exports/${EXPORT_ID}`;
        const destPath = path.join(tmpDir, "wrong-origin.sqlite");

        const { result, stderr } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeDefined();
        expect(stderr).toContain("Refusing to download");
        expect(serverRequestPaths).toEqual([]); // nothing was fetched
        await expect(fs.stat(destPath)).rejects.toThrow();
        expect(destroyFake.calledOnce).toBe(true); // no leaked RPC connection on failure
    });

    it("Rejects instead of hanging when the export is aborted and no terminal record arrives", async () => {
        // Simulates Ctrl+C with a dead daemon: cancelExport never produces a terminal record.
        // Calls the private _runExport directly since the command's SIGINT handler can't be
        // triggered safely inside the test runner (vitest has its own SIGINT listeners).
        const emitter = new EventEmitter();
        const silentCommunity = {
            address: COMMUNITY_ADDRESS,
            on: emitter.on.bind(emitter),
            removeListener: emitter.removeListener.bind(emitter),
            exports: [],
            export: async () => ({ exportId: EXPORT_ID }) // never emits exportschange
        };
        const ExportCommand = (await import("../../src/cli/commands/community/export.js")).default;
        const commandInstance = Object.create(ExportCommand.prototype) as { _runExport: Function };

        const abortController = new AbortController();
        const exportPromise = commandInstance._runExport(silentCommunity, false, abortController.signal, true) as Promise<unknown>;
        setTimeout(() => abortController.abort(), 10);

        await expect(exportPromise).rejects.toThrow("Export cancelled");
        expect(emitter.listenerCount("exportschange")).toBe(0); // listener cleaned up
    });

    it("Errors when the community is not local to the RPC server", async () => {
        // Remote communities returned by createCommunity have no export() method
        const remoteOnlyCreateFake = sandbox.fake(async () => ({ address: COMMUNITY_ADDRESS }));
        setPkcRpcConnectOverride(sandbox.fake.resolves({ createCommunity: remoteOnlyCreateFake, destroy: destroyFake }));

        const destPath = path.join(tmpDir, "remote.sqlite");
        const { result, stderr } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeDefined();
        expect(stderr).toContain("not local");
        expect(destroyFake.calledOnce).toBe(true); // no leaked RPC connection on failure

        // Restore the default override for any following test
        setPkcRpcConnectOverride(sandbox.fake.resolves({ createCommunity: createCommunityFake, destroy: destroyFake }));
    });

    it("Fails and leaves no file behind when the download returns a non-200 response", async () => {
        serverStatusCode = 500;
        const destPath = path.join(tmpDir, "http-error.sqlite");

        const { result, stderr } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeDefined();
        expect(stderr).toContain("HTTP 500");
        expect(serverRequestPaths).toEqual([`/exports/${EXPORT_ID}`]);
        await expect(fs.stat(destPath)).rejects.toThrow();
        await expect(fs.stat(destPath + ".partial")).rejects.toThrow();
        expect(destroyFake.calledOnce).toBe(true);
    });

    it("Fails and cleans up the .partial file when the connection drops mid-download", async () => {
        destroyMidResponse = true;
        const destPath = path.join(tmpDir, "dropped.sqlite");

        const { result } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeDefined();
        await expect(fs.stat(destPath)).rejects.toThrow();
        await expect(fs.stat(destPath + ".partial")).rejects.toThrow();
        expect(destroyFake.calledOnce).toBe(true);
    });

    it("Errors when the finished export record has no download URL", async () => {
        omitUrl = true;
        const destPath = path.join(tmpDir, "no-url.sqlite");

        const { result, stderr } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeDefined();
        expect(stderr).toContain("did not provide a download URL");
        expect(serverRequestPaths).toEqual([]); // nothing was fetched
        await expect(fs.stat(destPath)).rejects.toThrow();
    });

    it("Refuses to download when the URL is on the RPC server's origin but outside /exports/", async () => {
        downloadUrl = `http://127.0.0.1:${serverPort}/secrets/${EXPORT_ID}`;
        const destPath = path.join(tmpDir, "wrong-path.sqlite");

        const { result, stderr } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeDefined();
        expect(stderr).toContain("Refusing to download");
        expect(serverRequestPaths).toEqual([]); // nothing was fetched
        await expect(fs.stat(destPath)).rejects.toThrow();
    });

    it("Expects an https:// download origin when the RPC URL is wss://", async () => {
        // The connect override never dials, so a wss:// RPC URL works without a TLS server.
        // The record's http:// URL must be refused because the expected origin is https://
        const destPath = path.join(tmpDir, "wss-origin.sqlite");

        const { result, stderr } = await runCliCommand(
            `community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} --pkcRpcUrl wss://127.0.0.1:${serverPort}`
        );

        expect(result.error).toBeDefined();
        expect(stderr).toContain("Refusing to download");
        expect(stderr).toContain(`https://127.0.0.1:${serverPort}`);
        expect(serverRequestPaths).toEqual([]); // nothing was fetched
    });

    it("Skips sha256 verification when the export record has none (current behavior)", async () => {
        // Pins the `if (record.sha256 && ...)` branch: a record without a checksum downloads
        // without verification instead of failing. Tighten deliberately if this should error.
        omitSha256 = true;
        const destPath = path.join(tmpDir, "no-sha.sqlite");

        const { result } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeUndefined();
        const downloaded = await fs.readFile(destPath);
        expect(downloaded.equals(snapshotContent)).toBe(true);
    });

    it("Defaults the destination to <dataPath>/exports/<address>_<datetime>.sqlite when -o is not given", async () => {
        const { result, stdout } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet ${rpcUrlFlag}`);

        expect(result.error).toBeUndefined();
        const printedPath = stdout.trim();
        // Same computation as dist's defaults.PKC_DATA_PATH — both read XDG_DATA_HOME set in beforeAll
        const expectedDir = path.join(envPaths("bitsocial", { suffix: "" }).data, "exports");
        expect(path.dirname(printedPath)).toBe(expectedDir);
        // <address>_<ISO 8601 datetime with ':' → '-'>.sqlite, like the daemon log filenames
        expect(path.basename(printedPath)).toMatch(
            new RegExp(`^${COMMUNITY_ADDRESS.replaceAll(".", "\\.")}_\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z\\.sqlite$`)
        );
        const downloaded = await fs.readFile(printedPath);
        expect(downloaded.equals(snapshotContent)).toBe(true);
        // Don't leave snapshots behind in the (possibly real, if XDG_DATA_HOME is ignored) data path
        await fs.rm(printedPath, { force: true });
    });

    it("Creates intermediate directories for the destination path", async () => {
        const destPath = path.join(tmpDir, "nested", "deeper", "out.sqlite");

        const { result, stdout } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeUndefined();
        expect(stdout.trim()).toBe(destPath);
        const downloaded = await fs.readFile(destPath);
        expect(downloaded.equals(snapshotContent)).toBe(true);
    });

    it("Fails without leaving a .partial behind when the destination is a directory (even with --force)", async () => {
        const destPath = path.join(tmpDir, "dest-is-dir");
        await fs.mkdir(destPath);

        const { result } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet --force -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeDefined();
        expect((await fs.stat(destPath)).isDirectory()).toBe(true); // directory untouched
        await expect(fs.stat(destPath + ".partial")).rejects.toThrow();
    });

    it("Combines the address argument with --name into a single lookup", async () => {
        const destPath = path.join(tmpDir, "combined.sqlite");

        const { result } = await runCliCommand(
            `community export ${COMMUNITY_ADDRESS} --name my-community --quiet -o ${destPath} ${rpcUrlFlag}`
        );

        expect(result.error).toBeUndefined();
        expect(createCommunityFake.calledOnceWith({ address: COMMUNITY_ADDRESS, name: "my-community" })).toBe(true);
    });

    it("Prints progress to stderr and only the destination path to stdout without --quiet", async () => {
        const destPath = path.join(tmpDir, "progress.sqlite");

        const { result, stdout } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} -o ${destPath} ${rpcUrlFlag}`);

        expect(result.error).toBeUndefined();
        // stdout stays scriptable: only the destination path
        expect(stdout.trim()).toBe(destPath);
        // progress goes to stderr
        expect(result.stderr).toContain(`Exporting ${COMMUNITY_ADDRESS}`);
        expect(result.stderr).toContain("100%");
        expect(result.stderr).toContain("Downloading snapshot from");
        expect(result.stderr).toContain("Verified sha256");
    });
});

describe("community export _runExport", () => {
    const makeBareExportCommand = async () => {
        const ExportCommand = (await import("../../src/cli/commands/community/export.js")).default;
        return Object.create(ExportCommand.prototype) as { _runExport: Function };
    };

    const TERMINAL_RECORD = {
        exportId: EXPORT_ID,
        publicKey: "12D3KooWTest",
        includePrivateKey: false,
        progress: 1,
        size: snapshotContent.length,
        sha256: snapshotSha256,
        url: `http://127.0.0.1:1/exports/${EXPORT_ID}`
    };

    it("Resolves when the terminal record is already present before the listener is attached", async () => {
        // Covers the race where the exportschange notification fired before _runExport subscribed:
        // the record is read from community.exports, no event is ever emitted
        const emitter = new EventEmitter();
        const community = {
            address: COMMUNITY_ADDRESS,
            on: emitter.on.bind(emitter),
            removeListener: emitter.removeListener.bind(emitter),
            exports: [TERMINAL_RECORD],
            export: async () => ({ exportId: EXPORT_ID }) // never emits exportschange
        };
        const commandInstance = await makeBareExportCommand();

        const record = await commandInstance._runExport(community, false, new AbortController().signal, true);

        expect(record).toEqual(TERMINAL_RECORD);
        expect(emitter.listenerCount("exportschange")).toBe(0); // listener cleaned up
    });

    it("Rejects when an error record is already present before the listener is attached", async () => {
        const emitter = new EventEmitter();
        const community = {
            address: COMMUNITY_ADDRESS,
            on: emitter.on.bind(emitter),
            removeListener: emitter.removeListener.bind(emitter),
            exports: [
                {
                    ...TERMINAL_RECORD,
                    progress: 0.5,
                    error: { code: "ERR_EXPORT_FAILED", message: "boom" }
                }
            ],
            export: async () => ({ exportId: EXPORT_ID }) // never emits exportschange
        };
        const commandInstance = await makeBareExportCommand();

        await expect(commandInstance._runExport(community, false, new AbortController().signal, true)).rejects.toThrow(
            "ERR_EXPORT_FAILED"
        );
        expect(emitter.listenerCount("exportschange")).toBe(0);
    });

    it("Rejects immediately when the signal is already aborted", async () => {
        const emitter = new EventEmitter();
        const community = {
            address: COMMUNITY_ADDRESS,
            on: emitter.on.bind(emitter),
            removeListener: emitter.removeListener.bind(emitter),
            exports: [],
            export: async () => ({ exportId: EXPORT_ID })
        };
        const commandInstance = await makeBareExportCommand();
        const abortController = new AbortController();
        abortController.abort(); // aborted before _runExport attaches its listeners

        await expect(commandInstance._runExport(community, false, abortController.signal, true)).rejects.toThrow("Export cancelled");
        expect(emitter.listenerCount("exportschange")).toBe(0);
    });

    it("Ignores records of other exports (including errored ones)", async () => {
        const staleErrorRecord = {
            ...TERMINAL_RECORD,
            exportId: "99999999-8888-7777-6666-555555555555",
            progress: 0.5,
            error: { code: "ERR_EXPORT_CANCELLED", message: "previous export was cancelled" }
        };
        const emitter = new EventEmitter();
        const community = {
            address: COMMUNITY_ADDRESS,
            on: emitter.on.bind(emitter),
            removeListener: emitter.removeListener.bind(emitter),
            exports: [staleErrorRecord],
            export: async () => {
                setTimeout(() => {
                    // First notification holds only the stale record — must be ignored, not rejected
                    emitter.emit("exportschange", [staleErrorRecord]);
                    emitter.emit("exportschange", [staleErrorRecord, TERMINAL_RECORD]);
                }, 10);
                return { exportId: EXPORT_ID };
            }
        };
        const commandInstance = await makeBareExportCommand();

        const record = await commandInstance._runExport(community, false, new AbortController().signal, true);

        expect(record).toEqual(TERMINAL_RECORD);
        expect(emitter.listenerCount("exportschange")).toBe(0);
    });
});

describe("bitsocial daemon --allowPrivateKeyExport flag", () => {
    it("Is defined as a negatable boolean defaulting to true", () => {
        const flag = Daemon.flags.allowPrivateKeyExport;
        expect(flag).toBeDefined();
        expect(flag.type).toBe("boolean");
        expect(flag.allowNo).toBe(true);
        expect(flag.default).toBe(true);
    });
});
