import { spawn } from "child_process";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { file as tempFile } from "tempy";
import fsPromises from "fs/promises";
import dns from "node:dns";
import WebSocket from "ws";
import {
    type ManagedChildProcess,
    stopPkcDaemon,
    startPkcDaemonWithDynamicPorts,
    waitForCondition,
    waitForWebSocketOpen,
    waitForPortFree
} from "../helpers/daemon-helpers.js";
dns.setDefaultResultOrder("ipv4first");

// Ports/URLs are allocated dynamically per run and assigned in beforeAll (issue #87).
let RPC_PORT: number;
let KUBO_API_PORT: number;
let GATEWAY_PORT: number;
let rpcWsUrl: string;

const runBitsocialCommand = (
    args: string[],
    timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> => {
    return new Promise((resolve, reject) => {
        const proc = spawn("node", ["./bin/run", ...args], {
            stdio: ["pipe", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (data: Buffer) => {
            stdout += data.toString();
        });
        proc.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
        });
        const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            reject(new Error(`Command timed out after ${timeoutMs}ms: bitsocial ${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`));
        }, timeoutMs);
        proc.on("close", (exitCode) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode });
        });
    });
};

const getCommunityJson = async (address: string): Promise<Record<string, any>> => {
    const result = await runBitsocialCommand(["community", "get", address, "--pkcRpcUrl", rpcWsUrl]);
    expect(result.exitCode, `community get failed: ${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout);
};

// `community edit` resolves when the daemon accepts the edit, but a `community get` from a fresh
// RPC connection can briefly observe the pre-edit state (pkc-js >= 0.0.46 applies settings changes
// asynchronously enough that slow Windows CI runners hit the window — issue #91). Poll until the
// predicate sees the post-edit state, then return the LAST read so callers assert the real final
// value and a timeout still produces an informative diff.
const getCommunityJsonUntil = async (address: string, predicate: (community: Record<string, any>) => boolean): Promise<Record<string, any>> => {
    let community: Record<string, any> = {};
    await waitForCondition(async () => {
        community = await getCommunityJson(address);
        return predicate(community);
    }, 15000, 500);
    return community;
};

// Use public key addresses — pkc-js rejects unresolvable .bso/.eth names
const ROLE_ADDR_A = "12D3KooWNMYPSuPu8AiY6wRq5TJfx3r5pGoTNfRp6kHkgeUE2vpa";
const ROLE_ADDR_B = "12D3KooWQbMbKTraSdLHvBJjiUGVwF2pPTt5J4Rv5cU4gMvJxFzr";
const ROLE_ADDR_C = "12D3KooWRMT4vT7oEDN4Wdt5k87g3c6dXwVvGC2qhLNm6gNKVDHQ";
const ROLE_ADDR_D = "12D3KooWSr2HDqABjBbE3CH37YXZ3F6XDwGPDZgSwE8cQkLNB5rR";

describe("community edit null removal (real pkc instance)", () => {
    let daemonProcess: ManagedChildProcess;
    let communityAddress: string;

    beforeAll(async () => {
        const daemon = await startPkcDaemonWithDynamicPorts((e) => ["--pkcRpcUrl", e.rpcWsUrl]);
        daemonProcess = daemon.daemonProcess;
        ({ rpcPort: RPC_PORT, kuboPort: KUBO_API_PORT, gatewayPort: GATEWAY_PORT, rpcWsUrl } = daemon);

        await waitForCondition(async () => {
            try {
                const ws = new WebSocket(rpcWsUrl);
                await waitForWebSocketOpen(ws, 2000);
                ws.close();
                return true;
            } catch {
                return false;
            }
        }, 15000, 500);

        // Create a community for all tests to share
        const result = await runBitsocialCommand([
            "community", "create", "--description", "null removal test", "--pkcRpcUrl", rpcWsUrl
        ]);
        expect(result.exitCode, `create failed: ${result.stderr}`).toBe(0);
        communityAddress = result.stdout.trim();
    }, 120_000);

    afterAll(async () => {
        await stopPkcDaemon(daemonProcess);
        await Promise.all([
            waitForPortFree(RPC_PORT),
            waitForPortFree(KUBO_API_PORT),
            waitForPortFree(GATEWAY_PORT)
        ]);
    }, 60_000);

    it("Setting a role to null via CLI removes it", { timeout: 60_000 }, async () => {
        // Add a role
        const addResult = await runBitsocialCommand([
            "community", "edit", communityAddress,
            `--roles["${ROLE_ADDR_A}"].role`, "admin",
            "--pkcRpcUrl", rpcWsUrl
        ]);
        expect(addResult.exitCode, `edit add failed: ${addResult.stderr}`).toBe(0);

        // Verify role was added
        let community = await getCommunityJsonUntil(communityAddress, (c) => !!c.roles?.[ROLE_ADDR_A]);
        let roles = community.roles || {};
        expect(roles[ROLE_ADDR_A]).toEqual({ role: "admin" });

        // Remove via null
        const removeResult = await runBitsocialCommand([
            "community", "edit", communityAddress,
            `--roles["${ROLE_ADDR_A}"]`, "null",
            "--pkcRpcUrl", rpcWsUrl
        ]);
        expect(removeResult.exitCode, `edit remove failed: ${removeResult.stderr}`).toBe(0);

        // Verify role was removed
        community = await getCommunityJsonUntil(communityAddress, (c) => c.roles?.[ROLE_ADDR_A] === undefined);
        roles = community.roles || {};
        expect(roles[ROLE_ADDR_A]).toBeUndefined();
    });

    it("Setting a role to null via JSON file removes it", { timeout: 60_000 }, async () => {
        // Add a role first
        const addResult = await runBitsocialCommand([
            "community", "edit", communityAddress,
            `--roles["${ROLE_ADDR_B}"].role`, "moderator",
            "--pkcRpcUrl", rpcWsUrl
        ]);
        expect(addResult.exitCode, `edit add failed: ${addResult.stderr}`).toBe(0);

        let community = await getCommunityJsonUntil(communityAddress, (c) => !!c.roles?.[ROLE_ADDR_B]);
        let roles = community.roles || {};
        expect(roles[ROLE_ADDR_B]).toEqual({ role: "moderator" });

        // Remove via JSON file with null
        const jsonPath = tempFile({ extension: "json" });
        await fsPromises.writeFile(jsonPath, JSON.stringify({ roles: { [ROLE_ADDR_B]: null } }));

        const removeResult = await runBitsocialCommand([
            "community", "edit", communityAddress,
            "--jsonFile", jsonPath,
            "--pkcRpcUrl", rpcWsUrl
        ]);
        expect(removeResult.exitCode, `edit remove via json failed: ${removeResult.stderr}`).toBe(0);

        community = await getCommunityJsonUntil(communityAddress, (c) => c.roles?.[ROLE_ADDR_B] === undefined);
        roles = community.roles || {};
        expect(roles[ROLE_ADDR_B]).toBeUndefined();
    });

    it("Setting a top-level field to null via CLI removes it", { timeout: 60_000 }, async () => {
        // Set a description first
        const setResult = await runBitsocialCommand([
            "community", "edit", communityAddress,
            "--description", "test description",
            "--pkcRpcUrl", rpcWsUrl
        ]);
        expect(setResult.exitCode, `edit set failed: ${setResult.stderr}`).toBe(0);

        let community = await getCommunityJsonUntil(communityAddress, (c) => c.description === "test description");
        expect(community.description).toBe("test description");

        // Remove via null
        const removeResult = await runBitsocialCommand([
            "community", "edit", communityAddress,
            "--description", "null",
            "--pkcRpcUrl", rpcWsUrl
        ]);
        expect(removeResult.exitCode, `edit remove failed: ${removeResult.stderr}`).toBe(0);

        community = await getCommunityJsonUntil(communityAddress, (c) => c.description === undefined);
        expect(community.description).toBeUndefined();
    });

    it("Setting a nested object to null via CLI removes it", { timeout: 60_000 }, async () => {
        // Set suggested fields first
        const setResult = await runBitsocialCommand([
            "community", "edit", communityAddress,
            "--suggested.primaryColor", "blue",
            "--suggested.language", "en",
            "--pkcRpcUrl", rpcWsUrl
        ]);
        expect(setResult.exitCode, `edit set failed: ${setResult.stderr}`).toBe(0);

        let community = await getCommunityJsonUntil(communityAddress, (c) => c.suggested?.primaryColor === "blue");
        expect(community.suggested?.primaryColor).toBe("blue");

        // Remove via null
        const removeResult = await runBitsocialCommand([
            "community", "edit", communityAddress,
            "--suggested", "null",
            "--pkcRpcUrl", rpcWsUrl
        ]);
        expect(removeResult.exitCode, `edit remove failed: ${removeResult.stderr}`).toBe(0);

        community = await getCommunityJsonUntil(communityAddress, (c) => c.suggested === undefined);
        expect(community.suggested).toBeUndefined();
    });

    it("Mixed null and non-null roles: remove one, add another", { timeout: 60_000 }, async () => {
        // Add a role to remove later
        const addResult = await runBitsocialCommand([
            "community", "edit", communityAddress,
            `--roles["${ROLE_ADDR_C}"].role`, "admin",
            "--pkcRpcUrl", rpcWsUrl
        ]);
        expect(addResult.exitCode, `edit add failed: ${addResult.stderr}`).toBe(0);

        let community = await getCommunityJsonUntil(communityAddress, (c) => !!c.roles?.[ROLE_ADDR_C]);
        let roles = community.roles || {};
        expect(roles[ROLE_ADDR_C]).toEqual({ role: "admin" });

        // Simultaneously remove ROLE_ADDR_C and add ROLE_ADDR_D
        const editResult = await runBitsocialCommand([
            "community", "edit", communityAddress,
            `--roles["${ROLE_ADDR_D}"].role`, "moderator",
            `--roles["${ROLE_ADDR_C}"]`, "null",
            "--pkcRpcUrl", rpcWsUrl
        ]);
        expect(editResult.exitCode, `edit mixed failed: ${editResult.stderr}`).toBe(0);

        community = await getCommunityJsonUntil(
            communityAddress,
            (c) => !!c.roles?.[ROLE_ADDR_D] && c.roles?.[ROLE_ADDR_C] === undefined
        );
        roles = community.roles || {};
        expect(roles[ROLE_ADDR_D]).toEqual({ role: "moderator" });
        expect(roles[ROLE_ADDR_C]).toBeUndefined();
    });
});
