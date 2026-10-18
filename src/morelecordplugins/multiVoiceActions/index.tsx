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
    Menu,
    PermissionsBits,
    PermissionStore,
    SelectedGuildStore,
    showToast,
    UserStore,
    VoiceStateStore
} from "@webpack/common";

import { openBulkActionModal } from "./BulkActionModal";
import { addMany, clearSelection, getSelection, getSelectionSize, isSelected, toggleSelect } from "./selectionStore";
import { settings } from "./settings";

const ID_RE = /\b(\d{17,20})\b/;

function resolveVoiceTargetFromEvent(e: MouseEvent): { guildId: string; channelId: string; userId: string; } | null {
    const el = e.target as HTMLElement | null;
    if (!el || !(el instanceof HTMLElement)) return null;

    // 1) Explicit data attributes set by Discord on some rows.
    const dataEl = el.closest?.("[data-user-id],[data-author-id],[data-list-item-id]") as HTMLElement | null;
    let userId: string | null = dataEl?.dataset?.userId ?? dataEl?.dataset?.authorId ?? null;
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

export default definePlugin({
    name: "MultiVoiceActions",
    description: "Ctrl+Click voice users to multi-select, then move/disconnect/mute/deafen them at once. Also via user & voice-channel right-click menus.",
    tags: ["Voice", "Servers", "Utility"],
    authors: [Devs.Ven],
    settings,

    contextMenus: {
        "user-context": userContextPatch,
        "channel-context": channelContextPatch
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
    },

    stop() {
        document.removeEventListener("click", onCtrlClick, true);
        document.removeEventListener("keydown", onKeyDown, true);
        clearSelection();
    }
});
