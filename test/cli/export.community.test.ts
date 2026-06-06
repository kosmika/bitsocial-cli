import { describe, it, beforeAll, afterAll, afterEach, beforeEach, expect } from "vitest";
import Sinon from "sinon";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { directory as randomDirectory } from "tempy";
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
    let downloadUrl: string;
    let servedContent: Buffer; // what the http server streams for the download
    let serverRequestPaths: string[] = [];

    let exportFake: Sinon.SinonSpy;
    const destroyFake = sandbox.fake();
    let createCommunityFake: Sinon.SinonSpy;
    let failExportWith: { code: string; message: string } | undefined;
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
                    record.sha256 = snapshotSha256;
                    record.url = downloadUrl;
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
        httpServer = http.createServer((req, res) => {
            serverRequestPaths.push(req.url ?? "");
            res.statusCode = 200;
            res.end(servedContent);
        });
        await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
        const port = (httpServer.address() as import("node:net").AddressInfo).port;
        downloadUrl = `http://127.0.0.1:${port}/exports/${EXPORT_ID}`;

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
        failExportWith = undefined;
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
        const { result, stdout } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath}`);

        expect(result.error).toBeUndefined();
        expect(createCommunityFake.calledOnceWith({ address: COMMUNITY_ADDRESS })).toBe(true);
        expect(exportFake.calledOnce).toBe(true);
        expect(exportFake.args[0][0].includePrivateKey).toBe(false);
        expect(serverRequestPaths).toEqual([`/exports/${EXPORT_ID}`]);
        expect(destroyFake.calledOnce).toBe(true);

        expect(stdout.trim()).toBe(destPath);
        const downloaded = await fs.readFile(destPath);
        expect(downloaded.equals(snapshotContent)).toBe(true);
        // No leftover .partial file
        await expect(fs.stat(destPath + ".partial")).rejects.toThrow();
    });

    it("Requests the private key with --includePrivateKey", async () => {
        const destPath = path.join(tmpDir, "with-key.sqlite");
        const { result } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --includePrivateKey --quiet -o ${destPath}`);

        expect(result.error).toBeUndefined();
        expect(exportFake.calledOnce).toBe(true);
        expect(exportFake.args[0][0].includePrivateKey).toBe(true);
    });

    it("Looks up community by --name", async () => {
        const destPath = path.join(tmpDir, "by-name.sqlite");
        const { result } = await runCliCommand(`community export --name my-community --quiet -o ${destPath}`);

        expect(result.error).toBeUndefined();
        expect(createCommunityFake.calledOnceWith({ name: "my-community" })).toBe(true);
    });

    it("Looks up community by --publicKey", async () => {
        const destPath = path.join(tmpDir, "by-publickey.sqlite");
        const { result } = await runCliCommand(`community export --publicKey 12D3KooWTest --quiet -o ${destPath}`);

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

        const { result, stderr } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath}`);

        expect(result.error).toBeDefined();
        expect(stderr).toContain("already exists");
        // Existing file untouched, no export started
        expect((await fs.readFile(destPath)).toString()).toBe("previous backup");
        expect(exportFake.called).toBe(false);
    });

    it("Overwrites an existing destination file with --force", async () => {
        const destPath = path.join(tmpDir, "existing.sqlite");
        await fs.writeFile(destPath, "previous backup");

        const { result } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet --force -o ${destPath}`);

        expect(result.error).toBeUndefined();
        const downloaded = await fs.readFile(destPath);
        expect(downloaded.equals(snapshotContent)).toBe(true);
    });

    it("Fails and leaves no file behind when the downloaded sha256 does not match the export record", async () => {
        servedContent = Buffer.from("corrupted content that does not match the record's sha256");
        const destPath = path.join(tmpDir, "corrupted.sqlite");

        const { result, stderr } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath}`);

        expect(result.error).toBeDefined();
        expect(stderr).toContain("sha256 mismatch");
        await expect(fs.stat(destPath)).rejects.toThrow();
        await expect(fs.stat(destPath + ".partial")).rejects.toThrow();
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
    });

    it("Errors when the community is not local to the RPC server", async () => {
        // Remote communities returned by createCommunity have no export() method
        const remoteOnlyCreateFake = sandbox.fake(async () => ({ address: COMMUNITY_ADDRESS }));
        setPkcRpcConnectOverride(sandbox.fake.resolves({ createCommunity: remoteOnlyCreateFake, destroy: destroyFake }));

        const destPath = path.join(tmpDir, "remote.sqlite");
        const { result, stderr } = await runCliCommand(`community export ${COMMUNITY_ADDRESS} --quiet -o ${destPath}`);

        expect(result.error).toBeDefined();
        expect(stderr).toContain("not local");

        // Restore the default override for any following test
        setPkcRpcConnectOverride(sandbox.fake.resolves({ createCommunity: createCommunityFake, destroy: destroyFake }));
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
