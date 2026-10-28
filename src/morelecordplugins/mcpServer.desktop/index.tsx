/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Button, Forms } from "@webpack/common";

import { executeTool, TOOLS } from "./tools";

const logger = new Logger("McpServer");

const Native = VencordNative.pluginHelpers.McpServer as PluginNative<typeof import("./native")>;

interface ToolCallRequest {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

let pollActive = false;
let serverStarting = false;

function isObj(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isToolCall(value: unknown): value is ToolCallRequest {
    if (!isObj(value)) return false;
    return typeof value.id === "string" && typeof value.name === "string" && isObj(value.args);
}

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "Localhost port for the MCP HTTP server.",
        default: 8462,
        onChange: () => {
            if (pollActive) void startServer();
        },
    },
    authToken: {
        type: OptionType.STRING,
        description: "Optional secret token. MCP clients must send it as a bearer token when set.",
        default: "",
    },
    allowUserActions: {
        type: OptionType.BOOLEAN,
        description: "Allow MCP clients to send messages, react and join voice. Read and UI tools always stay on.",
        default: true,
    },
});

async function startServer() {
    if (typeof Native?.startServer !== "function") {
        logger.warn("Native bridge is missing, MCP server stays offline.");
        return;
    }
    if (serverStarting) return;
    serverStarting = true;
    try {
        try {
            await Native.setToolSchemas(TOOLS);
        } catch (e) {
            logger.warn("Could not publish tool schemas.", e);
        }
        const res = await Native.startServer(settings.store.port, settings.store.authToken);
        if (res?.success) logger.info(`MCP server listening at ${res.url}.`);
        else logger.error(`Could not start MCP server: ${res?.error ?? "unknown error"}.`);
    } catch (e) {
        logger.error("Could not start MCP server.", e);
    } finally {
        serverStarting = false;
    }
}

async function pollLoop() {
    while (pollActive) {
        let req: ToolCallRequest | null = null;
        try {
            const res: unknown = await Native.pollToolCall();
            req = isToolCall(res) ? res : null;
        } catch (e) {
            logger.error("Tool poll failed.", e);
            await sleep(1000);
            continue;
        }
        if (!pollActive) break;
        if (!req) continue;

        let result: { ok: boolean; data?: unknown; error?: string; };
        try {
            const data = await executeTool(req.name, req.args, { allowUserActions: settings.store.allowUserActions });
            result = { ok: true, data };
        } catch (e) {
            result = { ok: false, error: e instanceof Error ? e.message : "Tool failed." };
        }

        try {
            await Native.resolveToolCall(req.id, result);
        } catch (e) {
            logger.error("Could not return tool result.", e);
        }
    }
}

function McpServerInfo() {
    const { port } = settings.use(["port"]);
    const url = `http://127.0.0.1:${port}/mcp`;
    const config = JSON.stringify({ mcpServers: { discord: { url } } }, null, 2);

    return (
        <>
            <Forms.FormTitle tag="h3">Connection</Forms.FormTitle>
            <Forms.FormText>
                Point any MCP client at {url}. The server only listens on this computer and answers plain JSON RPC over HTTP.
            </Forms.FormText>
            <Button onClick={() => { void copyWithToast(config, "MCP config copied."); }}>
                Copy MCP Config
            </Button>
            <Forms.FormText>
                Set an auth token below when other people can reach your network. Changing the port restarts the server on its own.
            </Forms.FormText>
        </>
    );
}

export default definePlugin({
    name: "McpServer",
    description: "Exposes the Discord client to MCP apps over local HTTP for debugging and automation.",
    authors: [EquicordDevs.nobody],
    tags: ["Utility", "Developers"],
    settings,
    settingsAboutComponent: McpServerInfo,

    start() {
        if (typeof Native?.startServer !== "function") {
            logger.warn("Native bridge is missing, MCP server stays offline.");
            return;
        }
        pollActive = true;
        void startServer();
        void pollLoop();
    },

    stop() {
        pollActive = false;
        if (typeof Native?.stopServer === "function") {
            Native.stopServer().catch(e => logger.error("Could not stop MCP server.", e));
        }
    },
});
