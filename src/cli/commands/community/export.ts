import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { PKCLogger } from "../../../util.js";

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Minimal shape of the export records emitted by pkc-js over RPC (CommunityExportRecord).
// Kept local so we don't deep-import from pkc-js dist paths (see daemon.ts's @ts-expect-error imports).
type ExportRecord = {
    exportId: string;
    name?: string;
    publicKey: string;
    includePrivateKey: boolean;
    progress: number;
    size?: number;
    sha256?: string;
    url?: string;
    error?: { code: string; message: string };
};

type ExportableCommunity = {
    address: string;
    exports: ExportRecord[];
    export: (options?: { includePrivateKey?: boolean; signal?: AbortSignal }) => Promise<{ exportId: string }>;
    on: (event: string, listener: (records: ExportRecord[]) => void) => void;
    removeListener: (event: string, listener: (records: ExportRecord[]) => void) => void;
};

export default class Export extends BaseCommand {
    static override description =
        "Export a local community to a SQLite snapshot file. The export runs on the RPC server (daemon); once finished the snapshot is downloaded and its sha256 checksum is verified. Pass --includePrivateKey to produce a restorable backup that keeps the community's address.";

    static override examples = [
        "bitsocial community export plebmusic.bso",
        "bitsocial community export plebmusic.bso --includePrivateKey -o ./backups/plebmusic.sqlite",
        "bitsocial community export --name my-community",
        "bitsocial community export --publicKey 12D3KooWG3XbzoVyAE6Y9vHZKF64Yuuu4TjdgQKedk14iYmTEPWu"
    ];

    static override args = {
        address: Args.string({
            name: "address",
            required: false,
            description: "Address of the community to export"
        })
    };

    static override flags = {
        name: Flags.string({
            description: "Name of the community to export"
        }),
        publicKey: Flags.string({
            description: "Public key of the community to export"
        }),
        path: Flags.string({
            char: "o",
            description: "Destination file for the downloaded snapshot (default: ./<address>.sqlite)"
        }),
        includePrivateKey: Flags.boolean({
            default: false,
            description:
                "Ask the RPC server to include the community signer's private key in the export. Required for a restorable backup that keeps the same community address. The daemon may refuse (see `bitsocial daemon --no-allowPrivateKeyExport`)"
        }),
        force: Flags.boolean({
            default: false,
            description: "Overwrite the destination file if it already exists"
        }),
        quiet: Flags.boolean({
            char: "q",
            default: false,
            description: "Suppress progress output; only print the path of the downloaded snapshot"
        })
    };

    private _printProgress(quiet: boolean, message: string) {
        if (!quiet) process.stderr.write(message);
    }

    async run(): Promise<void> {
        const { args, flags } = await this.parse(Export);

        const log = PKCLogger("bitsocial-cli:commands:community:export");
        log(`args: `, args);
        log(`flags: `, flags);

        const lookupParam: Record<string, string> = {};
        if (args.address) lookupParam.address = args.address;
        if (flags.name) lookupParam.name = flags.name;
        if (flags.publicKey) lookupParam.publicKey = flags.publicKey;

        if (Object.keys(lookupParam).length === 0) {
            this.error("At least one of address argument, --name, or --publicKey must be provided");
        }

        const pkc = await this._connectToPkcRpc(flags.pkcRpcUrl.toString());

        // Cancel the in-flight export server-side on Ctrl+C. A second Ctrl+C force-exits
        // (the handler is registered with `once`, so the default SIGINT behavior is restored).
        const abortController = new AbortController();
        const onSigint = () => {
            this._printProgress(flags.quiet, "\nCancelling export... (Ctrl+C again to force exit)\n");
            abortController.abort();
        };
        process.once("SIGINT", onSigint);

        try {
            const community = (await pkc.createCommunity(lookupParam)) as unknown as Partial<ExportableCommunity>;
            if (typeof community.export !== "function") {
                this.error(
                    `Community is not local to the RPC server at ${flags.pkcRpcUrl}. Only communities created on this daemon can be exported`
                );
            }
            const exportableCommunity = community as ExportableCommunity;

            const destPath = path.resolve(flags.path ?? `${exportableCommunity.address}.sqlite`);
            const destExists = await fs
                .stat(destPath)
                .then(() => true)
                .catch(() => false);
            if (destExists && !flags.force) {
                this.error(`Destination file already exists: ${destPath}. Use --force to overwrite it`);
            }

            const finishedRecord = await this._runExport(exportableCommunity, flags.includePrivateKey, abortController.signal, flags.quiet);
            log("Export finished on the RPC server", finishedRecord);

            if (!finishedRecord.url) {
                this.error(`Export ${finishedRecord.exportId} finished but the RPC server did not provide a download URL`);
            }

            await this._downloadAndVerify(finishedRecord, destPath, abortController.signal, flags.quiet);

            this.log(destPath);
        } catch (e) {
            console.error(e);
            await pkc.destroy();
            this.exit(1);
        } finally {
            process.removeListener("SIGINT", onSigint);
        }
        await pkc.destroy();
    }

    /** Start the export on the RPC server and resolve with the terminal record (progress === 1). */
    private async _runExport(
        community: ExportableCommunity,
        includePrivateKey: boolean,
        signal: AbortSignal,
        quiet: boolean
    ): Promise<ExportRecord> {
        const { exportId } = await community.export({ includePrivateKey, signal });

        return new Promise<ExportRecord>((resolve, reject) => {
            let lastPrintedPercent = -1;
            const checkRecords = (records: ExportRecord[]) => {
                const record = records.find((rec) => rec.exportId === exportId);
                if (!record) return;
                if (record.error) {
                    community.removeListener("exportschange", checkRecords);
                    reject(new Error(`Export failed (${record.error.code}): ${record.error.message}`));
                } else if (record.progress === 1) {
                    community.removeListener("exportschange", checkRecords);
                    this._printProgress(quiet, `\rExporting ${community.address}: 100%\n`);
                    resolve(record);
                } else {
                    const percent = Math.floor(record.progress * 100);
                    if (percent !== lastPrintedPercent) {
                        lastPrintedPercent = percent;
                        this._printProgress(quiet, `\rExporting ${community.address}: ${percent}%`);
                    }
                }
            };
            community.on("exportschange", checkRecords);
            // The terminal notification may have arrived before the listener was attached
            checkRecords(community.exports);
        });
    }

    /** Download the finished snapshot to destPath, verifying its sha256 against the export record. */
    private async _downloadAndVerify(record: ExportRecord, destPath: string, signal: AbortSignal, quiet: boolean) {
        this._printProgress(quiet, `Downloading snapshot from ${record.url}\n`);
        const response = await fetch(record.url!, { signal });
        if (!response.ok || !response.body) {
            this.error(`Failed to download export from ${record.url}: HTTP ${response.status}`);
        }

        await fs.mkdir(path.dirname(destPath), { recursive: true });
        // Download to a .partial file so an interrupted/corrupted download never clobbers destPath
        const partialPath = destPath + ".partial";
        const hash = createHash("sha256");
        try {
            await pipeline(
                Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
                async function* (source) {
                    for await (const chunk of source) {
                        hash.update(chunk as Buffer);
                        yield chunk;
                    }
                },
                createWriteStream(partialPath)
            );
            const downloadedSha256 = hash.digest("hex");
            if (record.sha256 && downloadedSha256 !== record.sha256) {
                throw new Error(
                    `sha256 mismatch for downloaded export: expected ${record.sha256} but downloaded file hashes to ${downloadedSha256}`
                );
            }
            await fs.rename(partialPath, destPath);
        } catch (e) {
            await fs.rm(partialPath, { force: true }).catch(() => {});
            throw e;
        }
        this._printProgress(quiet, `Verified sha256 (${record.sha256}) and saved snapshot${record.size ? ` (${record.size} bytes)` : ""}\n`);
    }
}
