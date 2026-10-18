/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { Channel, User } from "@vencord/discord-types";
import {
    ChannelStore,
    MediaEngineStore,
    Menu,
    PermissionsBits,
    PermissionStore,
    React,
    SelectedGuildStore,
    showToast,
    SoundboardStore,
    UserStore,
    VoiceStateStore
} from "@webpack/common";
import type { ComponentType, ReactNode } from "react";

import { bulkDeafen, bulkDisconnect, bulkLocalMute, bulkLocalSoundboardMute, bulkLocalVideo, bulkMove, bulkMute } from "./actions";
import { getVoiceDestinationChannels, openBulkActionModal } from "./BulkActionModal";
import { addMany, clearSelection, getSelection, getSelectionSize, isSelected, removeSelect, subscribeSelection, toggleSelect } from "./selectionStore";
import { settings } from "./settings";

const ID_RE = /\b(\d{17,20})\b/;

function resolveVoiceTargetFromEvent(e: MouseEvent): { guildId: string; channelId: string; userId: string; } | null {
    const el = e.target as HTMLElement | null;
    if (!el || !(el instanceof HTMLElement)) return null;

    // 1) Explicit data attributes set by Discord on some rows.
    const dataEl = el.closest?.("[data-vc-mva-user],[data-user-id],[data-author-id],[data-list-item-id]") as HTMLElement | null;
    let userId: string | null = dataEl?.dataset?.vcMvaUser ?? dataEl?.dataset?.userId ?? dataEl?.dataset?.authorId ?? null;
    const listItemId = dataEl?.dataset?.listItemId;
    if (!userId && listItemId) {
        const m = ID_RE.exec(listItemId);
        if (m) userId = m[1];
    }

    // 2) Profile / user links (/users/<id>).
    if (!userId) {
        const link = el.closest?.('a[href*="/users/"]') as HTMLAnchorElement | null;
        const href = link?.href ?? link?.getAttribute?.("href") ?? "";
        const m = /\/users\/(\d{17,20})/.exec(href);
        if (m) userId = m[1];
    }

    if (!userId) return null;

    let voiceState: { channelId?: string | null; guildId?: string; } | undefined;
    try {
        voiceState = VoiceStateStore.getVoiceStateForUser(userId) as unknown as typeof voiceState;
    } catch {
        return null;
    }
    if (!voiceState?.channelId) return null;

    const guildId = (voiceState.guildId as string | undefined)
        ?? SelectedGuildStore?.getGuildId?.()
        ?? null;
    if (!guildId) return null;

    return { guildId, channelId: voiceState.channelId, userId };
}

function applyHighlights() {
    const enabled = settings.store.highlightSelection;
    for (const row of document.querySelectorAll<HTMLElement>("[data-vc-mva-user]")) {
        const id = row.getAttribute("data-vc-mva-user");
        row.classList.toggle("vc-mva-selected", enabled && !!id && isSelected(id));
    }
}

function clearHighlights() {
    for (const row of document.querySelectorAll<HTMLElement>(".vc-mva-selected")) {
        row.classList.remove("vc-mva-selected");
    }
}

function pruneSelection() {
    const sel = getSelection();
    if (!sel.channelId || sel.userIds.length === 0) return;
    for (const id of sel.userIds) {
        const vs = VoiceStateStore.getVoiceStateForUser(id);
        if (!vs?.channelId || vs.channelId !== sel.channelId) removeSelect(id);
    }
}

function onCtrlClick(e: MouseEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.button !== 0) return;

    const target = resolveVoiceTargetFromEvent(e);
    if (!target) return;

    e.preventDefault();
    e.stopPropagation();

    const added = toggleSelect(target.guildId, target.channelId, target.userId);
    const user = UserStore.getUser(target.userId) as User | undefined;
    const name = user?.globalName ?? user?.username ?? target.userId;
    showToast(added ? `Added ${name} to voice selection (${getSelectionSize()})` : `Removed ${name} from voice selection (${getSelectionSize()})`);
}

let pendingMultiDrag: { guildId: string; sourceChannelId: string; userIds: string[]; draggedUserId: string; } | null = null;
let dragEndTimer: number | undefined;

function onDragStart(e: DragEvent) {
    if (!settings.store.multiDrag) return;
    const target = resolveVoiceTargetFromEvent(e);
    if (!target) return;

    const sel = getSelection();
    if (sel.guildId === target.guildId && sel.channelId === target.channelId && sel.userIds.length > 1 && isSelected(target.userId)) {
        pendingMultiDrag = {
            guildId: target.guildId,
            sourceChannelId: target.channelId,
            userIds: [...sel.userIds],
            draggedUserId: target.userId
        };
    }
}

function onDragEnd() {
    if (dragEndTimer !== undefined) clearTimeout(dragEndTimer);
    dragEndTimer = setTimeout(() => {
        pendingMultiDrag = null;
        dragEndTimer = undefined;
    }, 3000) as unknown as number;
}

function handleVoiceStates(voiceStates: Array<{ userId: string; channelId?: string | null; }>) {
    if (pendingMultiDrag) {
        const dragged = voiceStates.find(vs => vs.userId === pendingMultiDrag!.draggedUserId);
        if (dragged && dragged.channelId !== pendingMultiDrag.sourceChannelId) {
            const { guildId, userIds, draggedUserId } = pendingMultiDrag;
            pendingMultiDrag = null;
            const rest = userIds.filter(id => id !== draggedUserId);
            if (rest.length) {
                if (dragged.channelId) bulkMove(guildId, rest, dragged.channelId, settings.store.actionDelayMs);
                else bulkDisconnect(guildId, rest, settings.store.actionDelayMs);
            }
            if (settings.store.clearAfterAction) clearSelection();
        }
    }
    pruneSelection();
    applyHighlights();
}

type BulkKind = "serverMute" | "serverDeafen" | "disconnect" | "localMute" | "localSoundboard" | "localVideo";

interface FanOutCtx {
    guildId: string;
    userId: string;
}

function isMenuElement(node: unknown): node is { type: ComponentType<any>; props: Record<string, any>; key: string | null; } {
    return !!node && typeof node === "object" && "type" in node && "props" in node;
}

function classify(id: unknown, label: unknown): BulkKind | null {
    if (id === "server-mute") return "serverMute";
    if (id === "server-deafen") return "serverDeafen";
    if (id === "disconnect") return "disconnect";
    if (id === "mute") return "localMute";
    if (id === "mute-soundboard") return "localSoundboard";
    if (id === "disable-video") return "localVideo";

    const l = (typeof label === "string" ? label : "").toLowerCase();
    if (l.includes("server mute")) return "serverMute";
    if (l.includes("server deaf")) return "serverDeafen";
    if (l.includes("soundboard")) return "localSoundboard";
    if (l.includes("video")) return "localVideo";
    if (l === "disconnect") return "disconnect";
    if (l === "mute" || l === "unmute") return "localMute";
    return null;
}

function resolveDestinationChannelId(props: Record<string, any>, guildId: string): string | null {
    if (typeof props.id === "string") {
        const channel = ChannelStore.getChannel(props.id) as Channel | undefined;
        if (channel && (channel.isGuildVoice?.() === true || channel.isGuildStageVoice?.() === true)) return props.id;
    }
    const name = typeof props.label === "string" ? props.label : null;
    if (name) {
        const match = getVoiceDestinationChannels(guildId, "").find(c => c.name === name);
        if (match) return match.id;
    }
    return null;
}

function runFanOut(kind: BulkKind, ctx: FanOutCtx, ids: string[]) {
    const delay = settings.store.actionDelayMs;
    const voiceState = VoiceStateStore.getVoiceStateForUser(ctx.userId);

    switch (kind) {
        case "serverMute":
            return bulkMute(ctx.guildId, ids, !(voiceState?.mute ?? false), delay);
        case "serverDeafen":
            return bulkDeafen(ctx.guildId, ids, !(voiceState?.deaf ?? false), delay);
        case "disconnect":
            if (settings.store.confirmBeforeDisconnect && !confirm(`Disconnect ${ids.length} user(s) from voice?`)) return;
            return bulkDisconnect(ctx.guildId, ids, delay);
        case "localMute":
            return bulkLocalMute(ids, !MediaEngineStore.isLocalMute(ctx.userId), delay);
        case "localSoundboard":
            return bulkLocalSoundboardMute(ids, !SoundboardStore.isLocalSoundboardMuted(ctx.userId), delay);
        case "localVideo":
            return bulkLocalVideo(ids, !MediaEngineStore.isLocalVideoDisabled(ctx.userId), delay);
    }
}

function fanOutChildren(node: unknown, ctx: FanOutCtx, ids: string[]): unknown {
    if (!Array.isArray(node)) return node;

    let changed = false;
    const out = node.map(el => {
        if (!isMenuElement(el)) return el;
        const { type, props, key } = el;

        const kind = classify(props.id, props.label);
        if (kind) {
            changed = true;
            return React.createElement(type, { ...props, key, action: () => runFanOut(kind, ctx, ids) }, props.children);
        }

        const sub = props.children;
        const isMoveTo = Array.isArray(sub)
            && (props.id === "move-to" || (typeof props.label === "string" && props.label.toLowerCase().includes("move")));

        if (isMoveTo) {
            let subChanged = false;
            const wrapped = (sub as unknown[]).map(child => {
                if (!isMenuElement(child)) return child;
                const dest = resolveDestinationChannelId(child.props, ctx.guildId);
                if (!dest) return child;
                subChanged = true;
                return React.createElement(child.type, { ...child.props, key: child.key, action: () => bulkMove(ctx.guildId, ids, dest, settings.store.actionDelayMs) }, child.props.children);
            });
            if (subChanged) {
                changed = true;
                return React.createElement(type, { ...props, key }, wrapped as ReactNode);
            }
            return el;
        }

        const processed = fanOutChildren(sub, ctx, ids);
        if (processed !== sub) {
            changed = true;
            return React.createElement(type, { ...props, key }, processed as ReactNode);
        }
        return el;
    });

    return changed ? out : node;
}

function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && getSelectionSize() > 0) clearSelection();
}

interface UserContextProps {
    user?: User;
    guildId?: string;
}

const userContextPatch: NavContextMenuPatchCallback = (children, props: UserContextProps) => {
    const user = props?.user;
    if (!user) return;

    let voiceState: { channelId?: string | null; guildId?: string; } | undefined;
    try {
        voiceState = VoiceStateStore.getVoiceStateForUser(user.id) as unknown as typeof voiceState;
    } catch {
        return;
    }
    if (!voiceState?.channelId) return;

    const guildId = (voiceState.guildId as string | undefined) ?? props.guildId ?? SelectedGuildStore?.getGuildId?.();
    if (!guildId) return;

    const { channelId } = voiceState;
    const selected = isSelected(user.id);
    const count = getSelectionSize();

    const multi = settings.store.fanOutContextMenu
        && count > 1
        && selected
        && getSelection().guildId === guildId
        && getSelection().channelId === channelId;

    if (multi) {
        const ids = getSelection().userIds;
        const fanned = fanOutChildren(children, { guildId, userId: user.id }, ids);
        if (Array.isArray(fanned) && fanned !== children) children.splice(0, children.length, ...(fanned as typeof children));

        children.unshift(
            <Menu.MenuItem
                id="vc-mva-multi-header"
                key="vc-mva-multi-header"
                label={`Applying to ${ids.length} selected users`}
                disabled
            />
        );
    }

    children.push(
        <Menu.MenuItem
            id="vc-mva-toggle-select"
            key="vc-mva-toggle-select"
            label={selected ? "Remove from voice multi-select" : "Add to voice multi-select (Ctrl+Click)"}
            action={() => {
                toggleSelect(guildId, channelId, user.id);
            }}
        >
            <Menu.MenuItem
                id="vc-mva-open-bulk"
                key="vc-mva-open-bulk"
                label={count > 0 ? `Manage selection (${count})…` : "Manage voice channel…"}
                action={() => openBulkActionModal(guildId, channelId)}
            />
            <Menu.MenuItem
                id="vc-mva-clear"
                key="vc-mva-clear"
                label="Clear selection"
                action={() => clearSelection()}
            />
        </Menu.MenuItem>
    );
};

interface ChannelContextProps {
    channel?: Channel;
    guild?: { id: string; };
}

const channelContextPatch: NavContextMenuPatchCallback = (children, props: ChannelContextProps) => {
    const channel = props?.channel;
    if (!channel) return;
    let isVoice = false;
    try {
        isVoice = channel.isGuildVoice?.() === true || channel.isGuildStageVoice?.() === true;
    } catch {
        return;
    }
    if (!isVoice) return;

    const guildId = channel.guild_id ?? props?.guild?.id;
    if (!guildId) return;

    let inChannel = 0;
    try {
        inChannel = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channel.id) ?? {}).length;
    } catch {
        inChannel = 0;
    }

    const sel = getSelection();
    const selCount = sel.userIds.length;
    const selHere = sel.guildId === guildId && sel.channelId === channel.id ? selCount : 0;

    const canMove = (() => {
        try {
            return PermissionStore.can(PermissionsBits.MOVE_MEMBERS, channel);
        } catch {
            return false;
        }
    })();
    if (!canMove && inChannel === 0) return;

    children.push(
        <Menu.MenuItem
            id="vc-mva-channel"
            key="vc-mva-channel"
            label={selHere > 0 ? `Voice multi-select (${selHere})` : "Voice multi-select"}
            action={() => openBulkActionModal(guildId, channel.id)}
        >
            <Menu.MenuItem
                id="vc-mva-channel-manage"
                key="vc-mva-channel-manage"
                label={`Select & manage (${inChannel} in channel)…`}
                action={() => openBulkActionModal(guildId, channel.id)}
            />
            <Menu.MenuItem
                id="vc-mva-channel-select-all"
                key="vc-mva-channel-select-all"
                label="Select all in this channel"
                action={() => {
                    try {
                        const ids = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channel.id) ?? {});
                        addMany(guildId, channel.id, ids);
                        showToast(`Selected ${ids.length} user(s). Ctrl+Click toggles individuals.`);
                    } catch {
                        showToast("Could not read voice states", "failure");
                    }
                }}
            />
            <Menu.MenuItem
                id="vc-mva-channel-clear"
                key="vc-mva-channel-clear"
                label="Clear selection"
                action={() => clearSelection()}
            />
        </Menu.MenuItem>
    );
};

let unsubscribeSelection: (() => void) | undefined;

export default definePlugin({
    name: "MultiVoiceActions",
    description: "Ctrl+Click voice users to multi-select, then move/disconnect/mute/deafen them at once. Also via user & voice-channel right-click menus.",
    tags: ["Voice", "Servers", "Utility"],
    authors: [Devs.Ven],
    settings,

    patches: [
        {
            find: ".VOICE_USER],shouldShow:",
            replacement: {
                match: /(?<=GuildChannelUserContextMenu.{0,300})"data-dnd-name":\i/,
                replace: "\"data-vc-mva-user\":arguments[0]?.user?.id,$&"
            }
        }
    ],

    contextMenus: {
        "user-context": userContextPatch,
        "channel-context": channelContextPatch
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId: string; channelId?: string | null; }>; }) {
            handleVoiceStates(voiceStates);
        },
        CHANNEL_SELECT() {
            applyHighlights();
        }
    },

    toolboxActions: {
        "Manage voice multi-select…": () => {
            const sel = getSelection();
            if (sel.guildId && sel.channelId) {
                openBulkActionModal(sel.guildId, sel.channelId);
                return;
            }
            showToast("Ctrl+Click voice users (or right-click a voice channel) to start a selection");
        },
        "Clear voice multi-select": () => clearSelection()
    },

    start() {
        document.addEventListener("click", onCtrlClick, true);
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("dragstart", onDragStart, true);
        document.addEventListener("dragend", onDragEnd, true);
        unsubscribeSelection = subscribeSelection(applyHighlights);
        applyHighlights();
    },

    stop() {
        document.removeEventListener("click", onCtrlClick, true);
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("dragstart", onDragStart, true);
        document.removeEventListener("dragend", onDragEnd, true);
        unsubscribeSelection?.();
        unsubscribeSelection = undefined;
        if (dragEndTimer !== undefined) {
            clearTimeout(dragEndTimer);
            dragEndTimer = undefined;
        }
        pendingMultiDrag = null;
        clearSelection();
        clearHighlights();
    }
});
