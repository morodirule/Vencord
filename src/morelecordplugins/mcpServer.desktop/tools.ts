/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled, plugins, startPlugin, stopPlugin } from "@api/PluginManager";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { filters, findAll, findModuleId } from "@webpack";
import {
    ChannelActions,
    ChannelRouter,
    ChannelStore,
    Constants,
    FluxDispatcher,
    GuildChannelStore,
    GuildMemberCountStore,
    GuildMemberStore,
    GuildReadStateStore,
    GuildStore,
    MediaEngineStore,
    MessageActions,
    MessageStore,
    NavigationRouter,
    openUserProfileModal,
    PresenceStore,
    ReadStateStore,
    RelationshipStore,
    RestAPI,
    SelectedChannelStore,
    SelectedGuildStore,
    showToast,
    UserStore,
    UserUtils,
    VoiceActions,
    VoiceStateStore,
    WindowStore,
} from "@webpack/common";

export interface McpToolDef {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export interface ToolOptions {
    allowUserActions: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function field(obj: unknown, key: string): unknown {
    return isRecord(obj) ? obj[key] : undefined;
}

function asText(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function strField(obj: unknown, key: string): string | undefined {
    return asText(field(obj, key));
}

function entriesOf(value: unknown): Array<[string, unknown]> {
    return isRecord(value) ? Object.entries(value) : [];
}

function listOf(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function safeStr(run: () => unknown): string | null {
    try {
        const v = run();
        return typeof v === "string" ? v : null;
    } catch {
        return null;
    }
}

function safeNum(run: () => unknown): number | null {
    try {
        const v = run();
        return typeof v === "number" && Number.isFinite(v) ? v : null;
    } catch {
        return null;
    }
}

function safeBool(run: () => unknown): boolean | null {
    try {
        const v = run();
        return typeof v === "boolean" ? v : null;
    } catch {
        return null;
    }
}

function reqString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== "string" || v.length === 0) throw new Error(`Missing required text argument: ${key}.`);
    return v;
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw new Error(`Argument ${key} must be text.`);
    return v;
}

function optInt(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
    const v = args[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`Argument ${key} must be a whole number.`);
    return Math.min(max, Math.max(min, v));
}

function optBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const v = args[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "boolean") throw new Error(`Argument ${key} must be true or false.`);
    return v;
}

function requireUserActions(opts: ToolOptions) {
    if (!opts.allowUserActions) throw new Error("User actions are disabled. Enable them in plugin settings to use this tool.");
}

function toJsonable(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return value.length > 5000 ? `${value.slice(0, 5000)}[truncated]` : value;
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") return "[function]";
    if (value instanceof Date) return value.toISOString();
    if (depth > 4) return "[nested]";
    if (Array.isArray(value)) return value.slice(0, 100).map(v => toJsonable(v, depth + 1));
    if (isRecord(value)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value).slice(0, 100)) {
            try {
                out[k] = toJsonable(v, depth + 1);
            } catch {
                out[k] = "[unreadable]";
            }
        }
        return out;
    }
    return String(value);
}

function serializeUser(user: unknown) {
    return {
        id: strField(user, "id"),
        username: strField(user, "username"),
        global_name: strField(user, "globalName") ?? strField(user, "global_name"),
        discriminator: strField(user, "discriminator"),
        avatar: strField(user, "avatar"),
        banner: strField(user, "banner"),
        bot: field(user, "bot") === true,
        system: field(user, "system") === true,
    };
}

function serializeChannel(channel: unknown) {
    return {
        id: strField(channel, "id"),
        name: strField(channel, "name"),
        type: asNumber(field(channel, "type")),
        topic: strField(channel, "topic"),
        parent_id: strField(channel, "parent_id"),
        position: asNumber(field(channel, "position")),
        nsfw: asBool(field(channel, "nsfw")),
        guild_id: strField(channel, "guild_id"),
        last_message_id: strField(channel, "lastMessageId") ?? strField(channel, "last_message_id"),
    };
}

function serializeMessage(msg: unknown) {
    const author = field(msg, "author");
    const embeds = listOf(field(msg, "embeds")).slice(0, 10).map(e => ({
        title: strField(e, "title"),
        description: strField(e, "description")?.slice(0, 2000),
        url: strField(e, "url"),
        type: strField(e, "type"),
    }));
    const attachments = listOf(field(msg, "attachments")).slice(0, 10).map(a => ({
        id: strField(a, "id"),
        filename: strField(a, "filename"),
        url: strField(a, "url"),
        content_type: strField(a, "content_type"),
        size: asNumber(field(a, "size")),
    }));
    const reactions = listOf(field(msg, "reactions")).slice(0, 25).map(r => {
        const emoji = field(r, "emoji");
        return {
            name: strField(emoji, "name"),
            id: strField(emoji, "id"),
            count: asNumber(field(r, "count")),
            me: asBool(field(r, "me")),
        };
    });
    const ref = field(msg, "messageReference") ?? field(msg, "message_reference");
    return {
        id: strField(msg, "id"),
        channel_id: strField(msg, "channel_id"),
        author: author ? serializeUser(author) : null,
        content: strField(msg, "content") ?? "",
        timestamp: strField(msg, "timestamp"),
        edited_timestamp: field(msg, "edited_timestamp") ?? field(msg, "editedTimestamp") ?? null,
        tts: asBool(field(msg, "tts")),
        pinned: asBool(field(msg, "pinned")),
        embeds,
        attachments,
        reactions,
        message_reference: isRecord(ref)
            ? { message_id: strField(ref, "message_id"), channel_id: strField(ref, "channel_id") }
            : null,
    };
}

const KNOWN_STORES: Record<string, unknown> = {
    GuildStore,
    ChannelStore,
    GuildChannelStore,
    MessageStore,
    UserStore,
    GuildMemberStore,
    PresenceStore,
    RelationshipStore,
    VoiceStateStore,
    ReadStateStore,
    GuildReadStateStore,
    SelectedGuildStore,
    SelectedChannelStore,
    WindowStore,
    MediaEngineStore,
};

function callStoreMethod(store: unknown, method: string, args: unknown[]): unknown {
    if (!isRecord(store)) throw new Error("That store is not available right now.");
    const fn = store[method];
    if (typeof fn !== "function") throw new Error(`That store has no method named ${method}.`);
    return (fn as (...a: unknown[]) => unknown).apply(store, args);
}

function normalizeEmojiParam(emoji: string): string {
    const m = /^<a?:(\w+):(\d+)>$/.exec(emoji.trim());
    if (m) return `${m[1]}:${m[2]}`;
    return emoji.trim();
}

function selfVoiceFlag(names: string[]): boolean | undefined {
    for (const name of names) {
        try {
            const v = callStoreMethod(MediaEngineStore, name, []);
            if (typeof v === "boolean") return v;
        } catch { /* try the next getter name */ }
    }
    return undefined;
}

export const TOOLS: McpToolDef[] = [
    {
        name: "get_client_state",
        description: "Get the current user plus the selected guild, channel and voice channel.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "list_guilds",
        description: "List joined servers with member counts and unread state.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "list_channels",
        description: "List channels. Pass a guild id for server channels, or omit it for direct messages.",
        inputSchema: {
            type: "object",
            properties: {
                guild_id: { type: "string", description: "Server id. Omit to list direct messages." },
            },
        },
    },
    {
        name: "get_messages",
        description: "Read recent messages from a channel, newest last.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: { type: "string", description: "Channel id." },
                limit: { type: "integer", description: "How many messages, 1 to 100.", default: 25 },
                before: { type: "string", description: "Only messages before this message id." },
            },
            required: ["channel_id"],
        },
    },
    {
        name: "get_user_info",
        description: "Look up a user with presence, relationship and optional server membership.",
        inputSchema: {
            type: "object",
            properties: {
                user_id: { type: "string", description: "User id." },
                guild_id: { type: "string", description: "Server id for nickname and roles." },
            },
            required: ["user_id"],
        },
    },
    {
        name: "get_voice_state",
        description: "List who is in a voice channel with mute and video flags.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: { type: "string", description: "Voice channel id. Defaults to the current one." },
            },
        },
    },
    {
        name: "navigate_to",
        description: "Switch the Discord client to a channel, server or path.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: { type: "string", description: "Channel or thread id to open." },
                guild_id: { type: "string", description: "Server id to open." },
                path: { type: "string", description: "Raw app route starting with slash." },
            },
        },
    },
    {
        name: "open_user_profile",
        description: "Open a user profile modal in the client.",
        inputSchema: {
            type: "object",
            properties: {
                user_id: { type: "string", description: "User id." },
                guild_id: { type: "string", description: "Server context for the profile." },
            },
            required: ["user_id"],
        },
    },
    {
        name: "set_draft",
        description: "Put text into the message box without sending it.",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", description: "Text to place in the box." },
                channel_id: { type: "string", description: "Channel to switch to first." },
            },
            required: ["text"],
        },
    },
    {
        name: "show_toast",
        description: "Show a small popup notification inside the client.",
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string", description: "Text to show." },
                type: { type: "string", description: "One of message, success or failure.", default: "message" },
            },
            required: ["message"],
        },
    },
    {
        name: "list_plugins",
        description: "List installed client plugins with their enabled state.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "toggle_plugin",
        description: "Enable or disable a client plugin by name.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Plugin name." },
                enabled: { type: "boolean", description: "True to enable, false to disable." },
            },
            required: ["name", "enabled"],
        },
    },
    {
        name: "send_message",
        description: "Send a message to a channel, optionally as a reply.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: { type: "string", description: "Channel id." },
                content: { type: "string", description: "Message text." },
                reply_to: { type: "string", description: "Message id to reply to." },
            },
            required: ["channel_id", "content"],
        },
    },
    {
        name: "edit_message",
        description: "Edit one of your own sent messages.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: { type: "string", description: "Channel id." },
                message_id: { type: "string", description: "Message id." },
                content: { type: "string", description: "Replacement text." },
            },
            required: ["channel_id", "message_id", "content"],
        },
    },
    {
        name: "delete_message",
        description: "Delete a message you are allowed to delete.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: { type: "string", description: "Channel id." },
                message_id: { type: "string", description: "Message id." },
            },
            required: ["channel_id", "message_id"],
        },
    },
    {
        name: "add_reaction",
        description: "Add an emoji reaction to a message.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: { type: "string", description: "Channel id." },
                message_id: { type: "string", description: "Message id." },
                emoji: { type: "string", description: "Unicode emoji or custom emoji as name and id." },
            },
            required: ["channel_id", "message_id", "emoji"],
        },
    },
    {
        name: "remove_reaction",
        description: "Remove your emoji reaction from a message.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: { type: "string", description: "Channel id." },
                message_id: { type: "string", description: "Message id." },
                emoji: { type: "string", description: "Unicode emoji or custom emoji as name and id." },
            },
            required: ["channel_id", "message_id", "emoji"],
        },
    },
    {
        name: "control_voice",
        description: "Join or leave voice, or change your mute and deafen state.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", description: "One of join, leave, mute, unmute, deafen, undeafen." },
                channel_id: { type: "string", description: "Voice channel id for join." },
            },
            required: ["action"],
        },
    },
    {
        name: "search_webpack",
        description: "Search loaded client modules by props or code, for plugin development.",
        inputSchema: {
            type: "object",
            properties: {
                mode: { type: "string", description: "One of props or code.", default: "props" },
                query: { type: "string", description: "Comma separated props, or a code snippet." },
                limit: { type: "integer", description: "Max matches to summarise.", default: 5 },
            },
            required: ["query"],
        },
    },
    {
        name: "inspect_store",
        description: "Read a client store or call one of its methods, for debugging.",
        inputSchema: {
            type: "object",
            properties: {
                store: { type: "string", description: "Store name, for example GuildStore." },
                method: { type: "string", description: "Optional method or field to read." },
                args: { type: "array", description: "Arguments for the method.", items: { type: "string" } },
            },
            required: ["store"],
        },
    },
    {
        name: "dispatch_flux",
        description: "Dispatch a Flux action inside the client.",
        inputSchema: {
            type: "object",
            properties: {
                type: { type: "string", description: "Action type." },
                payload: { type: "object", description: "Extra action fields." },
            },
            required: ["type"],
        },
    },
];

async function getClientState() {
    const me: unknown = UserStore.getCurrentUser();
    const guildId: unknown = SelectedGuildStore.getGuildId();
    const channelId: unknown = SelectedChannelStore.getChannelId();
    const voiceId: unknown = SelectedChannelStore.getVoiceChannelId();
    return {
        user: me ? serializeUser(me) : null,
        guild_id: typeof guildId === "string" ? guildId : null,
        channel_id: typeof channelId === "string" ? channelId : null,
        voice_channel_id: typeof voiceId === "string" ? voiceId : null,
        focused: safeBool(() => WindowStore.isFocused()),
    };
}

async function listGuilds() {
    const raw: unknown = GuildStore.getGuilds();
    const out = entriesOf(raw).map(([id, g]) => ({
        id,
        name: strField(g, "name"),
        icon: strField(g, "icon"),
        description: strField(g, "description"),
        member_count: safeNum(() => GuildMemberCountStore.getMemberCount(id)),
        unread: safeBool(() => GuildReadStateStore.hasUnread(id)),
    }));
    out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    return { count: out.length, guilds: out };
}

async function listChannels(args: Record<string, unknown>) {
    const guildId = optString(args, "guild_id");
    if (guildId) {
        const raw: unknown = GuildChannelStore.getChannels(guildId);
        const list = listOf(field(raw, "channels")).length > 0 ? listOf(field(raw, "channels")) : listOf(raw);
        const channels = (Array.isArray(raw) ? raw : list).map(c => {
            const id = strField(c, "id") ?? "";
            return {
                ...serializeChannel(c),
                unread: safeBool(() => ReadStateStore.hasUnread(id)),
            };
        });
        channels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        return { guild_id: guildId, count: channels.length, channels };
    }
    const raw: unknown = ChannelStore.getSortedPrivateChannels();
    const channels = listOf(raw).map(c => {
        const id = strField(c, "id") ?? "";
        return {
            ...serializeChannel(c),
            unread: safeBool(() => ReadStateStore.hasUnread(id)),
        };
    });
    return { guild_id: null, count: channels.length, channels };
}

async function getMessages(args: Record<string, unknown>) {
    const channelId = reqString(args, "channel_id");
    const limit = optInt(args, "limit", 25, 1, 100);
    const before = optString(args, "before");
    const query: Record<string, number | string> = { limit };
    if (before) query.before = before;

    try {
        const res: unknown = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query,
        });
        const messages = listOf(res).slice(0, limit).map(serializeMessage);
        return { channel_id: channelId, count: messages.length, source: "api", messages };
    } catch {
        const cached: unknown = MessageStore.getMessages(channelId);
        const messages = listOf(field(cached, "_array")).slice(-limit).map(serializeMessage);
        return { channel_id: channelId, count: messages.length, source: "cache", messages };
    }
}

async function getUserInfo(args: Record<string, unknown>) {
    const userId = reqString(args, "user_id");
    const guildId = optString(args, "guild_id");

    let user: unknown = null;
    try {
        user = UserStore.getUser(userId);
    } catch { user = null; }
    if (!user) {
        try {
            const fetched: unknown = await UserUtils.getUser(userId);
            user = fetched;
        } catch { user = null; }
    }
    if (!user) throw new Error("No user found with that id.");

    const status = safeStr(() => PresenceStore.getStatus(userId));
    let activities: unknown = null;
    try {
        const raw: unknown = PresenceStore.getActivities(userId);
        activities = listOf(raw).map(a => ({
            name: strField(a, "name"),
            type: asNumber(field(a, "type")),
            state: strField(a, "state"),
            details: strField(a, "details"),
        }));
    } catch { activities = null; }

    const relationship = safeNum(() => RelationshipStore.getRelationshipType(userId));

    let member: unknown = null;
    if (guildId) {
        try {
            const raw: unknown = GuildMemberStore.getMember(guildId, userId);
            if (raw) {
                member = {
                    nick: strField(raw, "nick"),
                    roles: listOf(field(raw, "roles")).filter(r => typeof r === "string"),
                    joined_at: strField(raw, "joinedAt") ?? strField(raw, "joined_at"),
                    deaf: asBool(field(raw, "deaf")),
                    mute: asBool(field(raw, "mute")),
                };
            }
        } catch { member = null; }
    }

    return { user: serializeUser(user), presence: { status, activities }, relationship, member };
}

async function getVoiceState(args: Record<string, unknown>) {
    const current: unknown = SelectedChannelStore.getVoiceChannelId();
    const channelId = optString(args, "channel_id") ?? (typeof current === "string" ? current : undefined);
    if (!channelId) throw new Error("Join a voice channel first or pass a channel id.");
    const raw: unknown = VoiceStateStore.getVoiceStatesForChannel(channelId);
    const list = Array.isArray(raw) ? raw : entriesOf(raw).map(([, v]) => v);
    const states = list.map(s => ({
        user_id: strField(s, "userId") ?? strField(s, "user_id"),
        nick: strField(s, "nick"),
        mute: asBool(field(s, "mute")),
        deaf: asBool(field(s, "deaf")),
        self_mute: asBool(field(s, "selfMute")),
        self_deaf: asBool(field(s, "selfDeaf")),
        self_video: asBool(field(s, "selfVideo")),
        self_stream: asBool(field(s, "selfStream")),
        suppress: asBool(field(s, "suppress")),
    }));
    return { channel_id: channelId, count: states.length, states };
}

async function navigateTo(args: Record<string, unknown>) {
    const channelId = optString(args, "channel_id");
    const guildId = optString(args, "guild_id");
    const path = optString(args, "path");
    if (channelId) {
        await ChannelRouter.transitionToChannel(channelId);
        return { navigated: true, channel_id: channelId };
    }
    if (guildId) {
        await NavigationRouter.transitionToGuild(guildId);
        return { navigated: true, guild_id: guildId };
    }
    if (path) {
        if (!path.startsWith("/")) throw new Error("Path must start with a slash.");
        await NavigationRouter.transitionTo(path);
        return { navigated: true, path };
    }
    throw new Error("Pass a channel id, guild id or path.");
}

async function openUserProfile(args: Record<string, unknown>) {
    const userId = reqString(args, "user_id");
    const guildId = optString(args, "guild_id");
    await openUserProfileModal({ userId, guildId });
    return { opened: true, user_id: userId };
}

async function setDraft(args: Record<string, unknown>) {
    const text = reqString(args, "text");
    if (text.length > 4000) throw new Error("Text must be 4000 characters or fewer.");
    const channelId = optString(args, "channel_id");
    if (channelId) await ChannelRouter.transitionToChannel(channelId);
    insertTextIntoChatInputBox(text);
    const current: unknown = SelectedChannelStore.getChannelId();
    return { inserted: true, channel_id: typeof current === "string" ? current : null };
}

async function showToastTool(args: Record<string, unknown>) {
    const message = reqString(args, "message").slice(0, 500);
    const kind = args.type;
    const type = kind === "success" || kind === "failure" ? kind : "message";
    showToast(message, type);
    return { shown: true };
}

async function listPlugins() {
    const list = Object.values(plugins).map(p => ({
        name: p.name,
        description: p.description,
        authors: p.authors.map(a => a.name),
        enabled: isPluginEnabled(p.name),
        required: p.required ?? false,
    }));
    list.sort((a, b) => a.name.localeCompare(b.name));
    return { count: list.length, plugins: list };
}

async function togglePlugin(args: Record<string, unknown>, opts: ToolOptions) {
    requireUserActions(opts);
    const name = reqString(args, "name");
    const { enabled } = args;
    if (typeof enabled !== "boolean") throw new Error("Argument enabled must be true or false.");
    const plugin = plugins[name];
    if (!plugin) throw new Error(`Unknown plugin: ${name}.`);
    if (plugin.required) throw new Error("That plugin is required and cannot be toggled.");
    if (enabled) await startPlugin(plugin);
    else await stopPlugin(plugin);
    return { name, enabled: isPluginEnabled(name) };
}

async function sendMessageTool(args: Record<string, unknown>, opts: ToolOptions) {
    requireUserActions(opts);
    const channelId = reqString(args, "channel_id");
    const content = reqString(args, "content");
    if (content.length > 4000) throw new Error("Content must be 4000 characters or fewer.");
    const replyTo = optString(args, "reply_to");

    const channel: unknown = ChannelStore.getChannel(channelId);
    const guildId = strField(channel, "guild_id");

    await sendMessage(
        channelId,
        { content },
        true,
        replyTo
            ? { messageReference: { message_id: replyTo, channel_id: channelId, guild_id: guildId } }
            : {}
    );
    return { sent: true, channel_id: channelId };
}

async function editMessageTool(args: Record<string, unknown>, opts: ToolOptions) {
    requireUserActions(opts);
    const channelId = reqString(args, "channel_id");
    const messageId = reqString(args, "message_id");
    const content = reqString(args, "content");
    await MessageActions.editMessage(channelId, messageId, { content });
    return { edited: true, channel_id: channelId, message_id: messageId };
}

async function deleteMessageTool(args: Record<string, unknown>, opts: ToolOptions) {
    requireUserActions(opts);
    const channelId = reqString(args, "channel_id");
    const messageId = reqString(args, "message_id");
    await MessageActions.deleteMessage(channelId, messageId);
    return { deleted: true, channel_id: channelId, message_id: messageId };
}

async function reactionTool(args: Record<string, unknown>, opts: ToolOptions, add: boolean) {
    requireUserActions(opts);
    const channelId = reqString(args, "channel_id");
    const messageId = reqString(args, "message_id");
    const emoji = normalizeEmojiParam(reqString(args, "emoji"));
    if (!emoji) throw new Error("Pass an emoji.");
    const url = Constants.Endpoints.REACTION(channelId, messageId, encodeURIComponent(emoji), "@me");
    if (add) await RestAPI.put({ url });
    else await RestAPI.del({ url });
    return add
        ? { reacted: true, channel_id: channelId, message_id: messageId, emoji }
        : { unreacted: true, channel_id: channelId, message_id: messageId, emoji };
}

async function controlVoice(args: Record<string, unknown>, opts: ToolOptions) {
    requireUserActions(opts);
    const action = reqString(args, "action");
    if (action === "join") {
        const channelId = reqString(args, "channel_id");
        await ChannelActions.selectVoiceChannel(channelId);
        return { action, channel_id: channelId };
    }
    if (action === "leave") {
        await ChannelActions.selectVoiceChannel(null);
        return { action, channel_id: null };
    }
    if (action === "mute" || action === "unmute") {
        const muted = selfVoiceFlag(["isSelfMute", "isSelfMuted", "isMuted"]);
        const wantMuted = action === "mute";
        if (muted !== wantMuted) await VoiceActions.toggleSelfMute();
        return { action, muted: selfVoiceFlag(["isSelfMute", "isSelfMuted", "isMuted"]) ?? wantMuted };
    }
    if (action === "deafen" || action === "undeafen") {
        const deafened = selfVoiceFlag(["isSelfDeaf", "isSelfDeafened", "isDeafened"]);
        const wantDeafened = action === "deafen";
        if (deafened !== wantDeafened) await VoiceActions.toggleSelfDeaf();
        return { action, deafened: selfVoiceFlag(["isSelfDeaf", "isSelfDeafened", "isDeafened"]) ?? wantDeafened };
    }
    throw new Error("Action must be join, leave, mute, unmute, deafen or undeafen.");
}

async function searchWebpack(args: Record<string, unknown>) {
    const mode = optString(args, "mode") ?? "props";
    const query = reqString(args, "query");
    const limit = optInt(args, "limit", 5, 1, 20);

    if (mode === "code") {
        const matches = findAll(filters.byCode(query)).slice(0, limit);
        let firstModuleId: number | null = null;
        try {
            const id: unknown = findModuleId(query);
            firstModuleId = typeof id === "number" ? id : null;
        } catch { firstModuleId = null; }
        return {
            mode,
            query,
            matchCount: matches.length,
            firstModuleId,
            sampleKeys: matches.slice(0, 3).map(m => (isRecord(m) ? Object.keys(m).slice(0, 30) : [])),
        };
    }
    if (mode !== "props") throw new Error("Mode must be props or code.");
    const props = query.split(",").map(p => p.trim()).filter(p => p.length > 0).slice(0, 8);
    if (props.length === 0) throw new Error("Pass at least one prop name.");
    const matches = findAll(filters.byProps(...props)).slice(0, limit);
    return {
        mode,
        query,
        matchCount: matches.length,
        sampleKeys: matches.slice(0, 3).map(m => (isRecord(m) ? Object.keys(m).slice(0, 30) : [])),
    };
}

async function inspectStore(args: Record<string, unknown>) {
    const name = reqString(args, "store");
    const store = KNOWN_STORES[name];
    if (store === undefined) {
        const names = Object.keys(KNOWN_STORES).sort();
        throw new Error(`Unknown store. Available stores: ${names.join(", ")}.`);
    }
    const method = optString(args, "method");
    if (!method) {
        if (!isRecord(store)) throw new Error("That store is not available right now.");
        return { store: name, keys: Object.keys(store).slice(0, 200) };
    }
    const rawArgs = args.args;
    const callArgs = rawArgs === undefined || rawArgs === null ? [] : rawArgs;
    if (!Array.isArray(callArgs) || callArgs.length > 5) throw new Error("Args must be a list of at most 5 items.");
    for (const a of callArgs) {
        if (a !== null && typeof a !== "string" && typeof a !== "number" && typeof a !== "boolean")
            throw new Error("Args must be text, numbers, booleans or null.");
    }
    const result = callStoreMethod(store, method, callArgs);
    const text = JSON.stringify(toJsonable(result) ?? null);
    const truncated = text.length > 20000;
    return { store: name, method, result: truncated ? `${text.slice(0, 20000)}[truncated]` : JSON.parse(text) };
}

async function dispatchFlux(args: Record<string, unknown>) {
    const type = reqString(args, "type");
    const { payload } = args;
    const extra = isRecord(payload) ? payload : {};
    FluxDispatcher.dispatch({ type, ...extra });
    return { dispatched: true, type };
}

export function executeTool(name: string, args: Record<string, unknown>, opts: ToolOptions): Promise<unknown> {
    switch (name) {
        case "get_client_state": return getClientState();
        case "list_guilds": return listGuilds();
        case "list_channels": return listChannels(args);
        case "get_messages": return getMessages(args);
        case "get_user_info": return getUserInfo(args);
        case "get_voice_state": return getVoiceState(args);
        case "navigate_to": return navigateTo(args);
        case "open_user_profile": return openUserProfile(args);
        case "set_draft": return setDraft(args);
        case "show_toast": return showToastTool(args);
        case "list_plugins": return listPlugins();
        case "toggle_plugin": return togglePlugin(args, opts);
        case "send_message": return sendMessageTool(args, opts);
        case "edit_message": return editMessageTool(args, opts);
        case "delete_message": return deleteMessageTool(args, opts);
        case "add_reaction": return reactionTool(args, opts, true);
        case "remove_reaction": return reactionTool(args, opts, false);
        case "control_voice": return controlVoice(args, opts);
        case "search_webpack": return searchWebpack(args);
        case "inspect_store": return inspectStore(args);
        case "dispatch_flux": return dispatchFlux(args);
        default: throw new Error(`Unknown tool: ${name}.`);
    }
}
