/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

interface SelectionState {
    guildId: string | null;
    channelId: string | null;
    userIds: Set<string>;
}

const state: SelectionState = {
    guildId: null,
    channelId: null,
    userIds: new Set()
};

const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

export function subscribeSelection(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

export function getSelection(): { guildId: string | null; channelId: string | null; userIds: string[]; } {
    return { guildId: state.guildId, channelId: state.channelId, userIds: [...state.userIds] };
}

export function getSelectionSize(): number {
    return state.userIds.size;
}

export function isSelected(userId: string): boolean {
    return state.userIds.has(userId);
}

/**
 * Toggle a user in the selection. If the guild/channel scope changes,
 * the previous selection is replaced (bulk actions only make sense
 * within one guild / source channel).
 */
export function toggleSelect(guildId: string, channelId: string | null, userId: string): boolean {
    if (state.guildId !== guildId || state.channelId !== channelId) {
        state.guildId = guildId;
        state.channelId = channelId;
        state.userIds.clear();
    }
    if (state.userIds.has(userId)) {
        state.userIds.delete(userId);
        if (state.userIds.size === 0) {
            state.guildId = null;
            state.channelId = null;
        }
        emit();
        return false;
    }
    state.userIds.add(userId);
    emit();
    return true;
}

export function addMany(guildId: string, channelId: string | null, userIds: string[]) {
    if (state.guildId !== guildId || state.channelId !== channelId) {
        state.guildId = guildId;
        state.channelId = channelId;
        state.userIds.clear();
    }
    for (const id of userIds) state.userIds.add(id);
    emit();
}

export function removeSelect(userId: string) {
    state.userIds.delete(userId);
    if (state.userIds.size === 0) {
        state.guildId = null;
        state.channelId = null;
    }
    emit();
}

export function clearSelection() {
    state.guildId = null;
    state.channelId = null;
    state.userIds.clear();
    emit();
}
