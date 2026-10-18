/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RestAPI, showToast } from "@webpack/common";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface BulkResult {
    ok: string[];
    failed: { userId: string; error: unknown; }[];
}

async function patchMember(guildId: string, userId: string, body: Record<string, unknown>) {
    // Raw REST path — equivalent to Discord's PATCH /guilds/{guild.id}/members/{user.id}.
    // channel_id moves/disconnects (null = disconnect), mute/deaf toggle server mute/deafen.
    await RestAPI.patch({
        url: `/guilds/${guildId}/members/${userId}`,
        body
    });
}

async function runBulk(
    guildId: string,
    userIds: string[],
    makeBody: () => Record<string, unknown>,
    delayMs: number
): Promise<BulkResult> {
    const ok: string[] = [];
    const failed: BulkResult["failed"] = [];
    for (const userId of userIds) {
        try {
            await patchMember(guildId, userId, makeBody());
            ok.push(userId);
        } catch (error) {
            failed.push({ userId, error });
        }
        if (delayMs > 0) await sleep(delayMs);
    }
    return { ok, failed };
}

function report(action: string, result: BulkResult) {
    if (result.failed.length === 0) {
        showToast(`${action}: ${result.ok.length} user(s) updated`, "success");
    } else if (result.ok.length === 0) {
        showToast(`${action} failed for ${result.failed.length} user(s). Check permissions/role hierarchy.`, "failure");
    } else {
        showToast(`${action}: ${result.ok.length} ok, ${result.failed.length} failed`);
    }
}

export async function bulkMove(guildId: string, userIds: string[], destChannelId: string, delayMs: number) {
    const result = await runBulk(guildId, userIds, () => ({ channel_id: destChannelId }), delayMs);
    report("Move", result);
    return result;
}

export async function bulkDisconnect(guildId: string, userIds: string[], delayMs: number) {
    const result = await runBulk(guildId, userIds, () => ({ channel_id: null }), delayMs);
    report("Disconnect", result);
    return result;
}

export async function bulkMute(guildId: string, userIds: string[], muted: boolean, delayMs: number) {
    const result = await runBulk(guildId, userIds, () => ({ mute: muted }), delayMs);
    report(muted ? "Server mute" : "Server unmute", result);
    return result;
}

export async function bulkDeafen(guildId: string, userIds: string[], deafened: boolean, delayMs: number) {
    const result = await runBulk(guildId, userIds, () => ({ deaf: deafened }), delayMs);
    report(deafened ? "Server deafen" : "Server undeafen", result);
    return result;
}
