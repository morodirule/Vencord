/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";

export interface McpToolSchema {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface McpToolRequest {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

export interface McpToolResult {
    ok: boolean;
    data?: unknown;
    error?: string;
}

interface PendingCall {
    resolve: (result: McpToolResult) => void;
    reject: (err: Error) => void;
}

const SERVER_INFO = { name: "discord-client-mcp", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";
const TOOL_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_ITEMS = 32;

let server: Server | null = null;
let boundPort = 0;
let authToken = "";
let toolSchemas: McpToolSchema[] = [];
let callSeq = 0;

const toolQueue: McpToolRequest[] = [];
const pendingCalls = new Map<string, PendingCall>();
let pollWaiter: ((req: McpToolRequest | null) => void) | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function serverUrl() {
    return `http://127.0.0.1:${boundPort}/mcp`;
}

function corsHeaders(): Record<string, string> {
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
    };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
    const headers = corsHeaders();
    if (status === 204 || status === 202) {
        res.writeHead(status, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
        });
        res.end();
        return;
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage) {
    if (!authToken) return true;
    return req.headers.authorization === `Bearer ${authToken}`;
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("Request body too large."));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", () => reject(new Error("Failed to read request body.")));
    });
}

function rpcOk(id: string | number | null, result: unknown) {
    return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
    return { jsonrpc: "2.0", id, error: { code, message } };
}

function flushPollWaiter() {
    const waiter = pollWaiter;
    pollWaiter = null;
    if (!waiter) return;
    const next = toolQueue.shift();
    waiter(next ?? null);
}

function callRenderer(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    callSeq += 1;
    const id = `mcp-${callSeq}-${Date.now()}`;
    return new Promise<McpToolResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingCalls.delete(id);
            reject(new Error("Timed out waiting for the Discord client."));
        }, TOOL_TIMEOUT_MS);
        pendingCalls.set(id, {
            resolve: result => {
                clearTimeout(timer);
                resolve(result);
            },
            reject: err => {
                clearTimeout(timer);
                reject(err);
            },
        });
        toolQueue.push({ id, name, args });
        flushPollWaiter();
    });
}

async function dispatchRpc(msg: unknown): Promise<Record<string, unknown> | null> {
    if (!isRecord(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
        return rpcError(null, -32600, "Malformed JSON-RPC request.");
    const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
    const { params } = msg;

    switch (msg.method) {
        case "initialize":
            return rpcOk(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: SERVER_INFO,
            });
        case "notifications/initialized":
            return null;
        case "ping":
            return rpcOk(id, {});
        case "tools/list":
            return rpcOk(id, { tools: toolSchemas });
        case "tools/call": {
            if (!isRecord(params) || typeof params.name !== "string")
                return rpcError(id, -32602, "tools/call needs a tool name.");
            const args = isRecord(params.arguments) ? params.arguments : {};
            try {
                const result = await callRenderer(params.name, args);
                if (result.ok) {
                    return rpcOk(id, {
                        content: [{ type: "text", text: JSON.stringify(result.data ?? null) }],
                    });
                }
                return rpcOk(id, {
                    content: [{ type: "text", text: result.error ?? "Tool failed." }],
                    isError: true,
                });
            } catch (e) {
                return rpcOk(id, {
                    content: [{ type: "text", text: e instanceof Error ? e.message : "Tool failed." }],
                    isError: true,
                });
            }
        }
        default:
            return rpcError(id, -32601, `Unknown method: ${msg.method}.`);
    }
}

async function handleMcpPost(res: ServerResponse, body: string) {
    let msg: unknown;
    try {
        msg = JSON.parse(body);
    } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return;
    }
    try {
        if (Array.isArray(msg)) {
            const out: unknown[] = [];
            for (const item of msg.slice(0, MAX_BATCH_ITEMS)) {
                const r = await dispatchRpc(item);
                if (r) out.push(r);
            }
            sendJson(res, 200, out);
            return;
        }
        if (isRecord(msg) && (msg.id === undefined || msg.id === null)) {
            await dispatchRpc(msg);
            sendJson(res, 202, null);
            return;
        }
        sendJson(res, 200, await dispatchRpc(msg));
    } catch {
        try {
            sendJson(res, 500, rpcError(null, -32603, "Internal server error."));
        } catch { /* response already gone */ }
    }
}

function onRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "OPTIONS") {
        sendJson(res, 204, null);
        return;
    }
    let path = "/";
    try {
        path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch { /* keep default path */ }

    if (req.method === "GET" && (path === "/" || path === "/health" || path === "/mcp")) {
        sendJson(res, 200, {
            name: SERVER_INFO.name,
            version: SERVER_INFO.version,
            status: "ok",
            url: serverUrl(),
            tools: toolSchemas.length,
        });
        return;
    }

    if (req.method === "POST" && path === "/mcp") {
        if (!isAuthorized(req)) {
            sendJson(res, 401, { error: "Unauthorized." });
            return;
        }
        readBody(req).then(
            body => handleMcpPost(res, body),
            () => sendJson(res, 413, { error: "Request body too large." })
        );
        return;
    }

    sendJson(res, 404, { error: "Not found." });
}

function stopServerInternal(): Promise<void> {
    for (const [, pending] of pendingCalls) {
        pending.reject(new Error("Server stopped."));
    }
    pendingCalls.clear();
    toolQueue.length = 0;
    flushPollWaiter();

    return new Promise(resolve => {
        if (!server) {
            boundPort = 0;
            resolve();
            return;
        }
        const closing = server;
        server = null;
        boundPort = 0;
        closing.close(() => resolve());
        setTimeout(resolve, 2000).unref?.();
    });
}

export function setToolSchemas(_: IpcMainInvokeEvent, schemas: unknown): boolean {
    if (!Array.isArray(schemas)) return false;
    const clean: McpToolSchema[] = [];
    for (const s of schemas.slice(0, 200)) {
        if (!isRecord(s)) continue;
        if (typeof s.name !== "string" || typeof s.description !== "string") continue;
        if (!isRecord(s.inputSchema)) continue;
        clean.push({ name: s.name, description: s.description, inputSchema: s.inputSchema });
    }
    toolSchemas = clean;
    return true;
}

export async function startServer(_: IpcMainInvokeEvent, port: unknown, token: unknown): Promise<{ success: boolean; url?: string; error?: string; }> {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
        return { success: false, error: "Port must be a whole number between 1 and 65535." };
    const cleanToken = typeof token === "string" ? token.slice(0, 256) : "";

    if (server && boundPort === port && authToken === cleanToken)
        return { success: true, url: serverUrl() };

    await stopServerInternal();

    try {
        await new Promise<void>((resolve, reject) => {
            const next = createServer(onRequest);
            next.once("error", reject);
            next.listen(port, "127.0.0.1", () => {
                next.removeListener("error", reject);
                server = next;
                resolve();
            });
        });
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Could not start the server." };
    }

    boundPort = port;
    authToken = cleanToken;
    return { success: true, url: serverUrl() };
}

export async function stopServer(_: IpcMainInvokeEvent): Promise<{ success: boolean; }> {
    await stopServerInternal();
    return { success: true };
}

export function getStatus(_: IpcMainInvokeEvent) {
    return {
        running: server !== null,
        port: boundPort,
        url: server ? serverUrl() : "",
        queuedCalls: toolQueue.length,
        pendingCalls: pendingCalls.size,
        tools: toolSchemas.length,
    };
}

export function pollToolCall(_: IpcMainInvokeEvent): Promise<McpToolRequest | null> {
    const next = toolQueue.shift();
    if (next) return Promise.resolve(next);
    return new Promise<McpToolRequest | null>(resolve => {
        const timer = setTimeout(() => {
            if (pollWaiter === done) pollWaiter = null;
            resolve(null);
        }, POLL_TIMEOUT_MS);
        const done = (req: McpToolRequest | null) => {
            clearTimeout(timer);
            resolve(req);
        };
        pollWaiter = done;
    });
}

export function resolveToolCall(_: IpcMainInvokeEvent, id: unknown, result: unknown): boolean {
    if (typeof id !== "string" || !isRecord(result)) return false;
    const pending = pendingCalls.get(id);
    if (!pending) return false;
    pendingCalls.delete(id);
    const ok = result.ok === true;
    const { data } = result;
    const error = typeof result.error === "string" ? result.error : "Tool failed.";
    pending.resolve(ok ? { ok: true, data } : { ok: false, error });
    return true;
}
