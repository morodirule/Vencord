/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import type { Channel, RenderModalProps } from "@vencord/discord-types";
import {
    Button,
    ChannelStore,
    Forms,
    GuildChannelStore,
    GuildMemberStore,
    Modal,
    openModal,
    PermissionsBits,
    PermissionStore,
    SearchableSelect,
    Text,
    useMemo,
    UserStore,
    useState,
    VoiceStateStore
} from "@webpack/common";

import { bulkDeafen, bulkDisconnect, bulkMove, bulkMute } from "./actions";
import { clearSelection, getSelection } from "./selectionStore";
import { settings } from "./settings";

interface Props {
    modalProps: RenderModalProps;
    guildId: string;
    sourceChannelId: string;
}

function getVoiceDestinationChannels(guildId: string, excludeChannelId: string): Channel[] {
    try {
        const groups = GuildChannelStore.getChannels(guildId);
        const vocal = (groups?.VOCAL ?? []).map(e => (e as { channel: Channel; }).channel ?? e as unknown as Channel);
        return vocal.filter(c => c && c.id !== excludeChannelId && (c.isGuildVoice?.() || c.isGuildStageVoice?.()));
    } catch {
        return [];
    }
}

function displayName(guildId: string, userId: string): string {
    const member = GuildMemberStore.getMember(guildId, userId);
    if (member?.nick) return member.nick;
    const user = UserStore.getUser(userId);
    return user?.globalName ?? user?.username ?? userId;
}

export function openBulkActionModal(guildId: string, sourceChannelId: string) {
    openModal(props => <BulkActionModal modalProps={props} guildId={guildId} sourceChannelId={sourceChannelId} />);
}

export default function BulkActionModal({ modalProps, guildId, sourceChannelId }: Props) {
    const liveUserIds = useMemo(() => {
        try {
            return Object.keys(VoiceStateStore.getVoiceStatesForChannel(sourceChannelId) ?? {});
        } catch {
            return [];
        }
    }, [sourceChannelId]);

    const preselected = useMemo(() => new Set(getSelection().userIds), []);
    const [checked, setChecked] = useState<Set<string>>(() =>
        new Set(liveUserIds.filter(id => preselected.size === 0 || preselected.has(id)))
    );
    const [destChannelId, setDestChannelId] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const sourceChannel = ChannelStore.getChannel(sourceChannelId);
    const destChannels = useMemo(() => getVoiceDestinationChannels(guildId, sourceChannelId), [guildId, sourceChannelId]);
    const canMove = sourceChannel ? PermissionStore.can(PermissionsBits.MOVE_MEMBERS, sourceChannel) : false;

    const toggle = (id: string) => setChecked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    const ids = [...checked];
    const delay = settings.store.actionDelayMs;

    const run = async (kind: string, fn: () => Promise<unknown>, opts?: { keepSelection?: boolean; }) => {
        if (ids.length === 0 || busy) return;
        setBusy(kind);
        try {
            await fn();
            if (settings.store.clearAfterAction && !opts?.keepSelection) {
                if (checked.size > 0 && liveUserIds.every(id => !checked.has(id) || true)) {
                    // Best effort: clear global selection only if it matches this guild/channel scope.
                    const sel = getSelection();
                    if (sel.guildId === guildId && sel.channelId === sourceChannelId) clearSelection();
                }
                setChecked(new Set());
            }
        } finally {
            setBusy(null);
        }
    };

    const destOptions = destChannels.map(c => ({ value: c.id, label: `# ${c.name}` }));

    return (
        <Modal
            {...modalProps}
            title={`Move / manage voice users (${ids.length} selected)`}
            subtitle={sourceChannel ? `From: ${sourceChannel.name}` : undefined}
            actions={[
                {
                    text: busy ?? "Close",
                    variant: "secondary",
                    disabled: busy != null,
                    onClick: () => modalProps.onClose()
                }
            ]}
        >
            <div className="vc-mva-section">
                <Forms.FormTitle tag="h3">Users in this voice channel (Ctrl+Click also works in Discord)</Forms.FormTitle>
                <div className={classes("vc-mva-userlist", Margins.bottom16)}>
                    {liveUserIds.length === 0 && <Text variant="text-sm/normal">Nobody is in this voice channel right now.</Text>}
                    {liveUserIds.map(id => (
                        <label key={id} className="vc-mva-row">
                            <input
                                type="checkbox"
                                checked={checked.has(id)}
                                onChange={() => toggle(id)}
                            />
                            <span>{displayName(guildId, id)}</span>
                        </label>
                    ))}
                </div>
                <div className="vc-mva-row-actions">
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} look={Button.Looks.LINK} onClick={() => setChecked(new Set(liveUserIds))} disabled={liveUserIds.length === 0}>Select all</Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} look={Button.Looks.LINK} onClick={() => setChecked(new Set())} disabled={checked.size === 0}>Clear</Button>
                </div>
            </div>

            <div className="vc-mva-section">
                <Forms.FormTitle tag="h3">Destination voice channel (for Move)</Forms.FormTitle>
                <SearchableSelect
                    options={destOptions}
                    value={destChannelId ?? undefined}
                    placeholder={destOptions.length ? "Select a voice channel" : "No other voice channel available"}
                    maxVisibleItems={6}
                    closeOnSelect
                    onChange={v => setDestChannelId(v as string)}
                />
                {!canMove && <Text variant="text-sm/normal" color="text-feedback-warning">You need the Move Members permission to move/disconnect users.</Text>}
            </div>

            <div className="vc-mva-actions">
                <Button
                    disabled={ids.length === 0 || !destChannelId || busy != null}
                    onClick={() => run("Moving…", () => bulkMove(guildId, ids, destChannelId!, delay))}
                >{busy === "Moving…" ? busy : `Move ${ids.length}`}</Button>
                <Button
                    color={Button.Colors.RED}
                    disabled={ids.length === 0 || busy != null}
                    onClick={() => {
                        if (settings.store.confirmBeforeDisconnect && !confirm(`Disconnect ${ids.length} user(s) from voice?`)) return;
                        run("Disconnecting…", () => bulkDisconnect(guildId, ids, delay));
                    }}
                >{busy === "Disconnecting…" ? busy : `Disconnect ${ids.length}`}</Button>
                <Button
                    color={Button.Colors.PRIMARY}
                    disabled={ids.length === 0 || busy != null}
                    onClick={() => run("Muting…", () => bulkMute(guildId, ids, true, delay), { keepSelection: true })}
                >Mute</Button>
                <Button
                    color={Button.Colors.PRIMARY}
                    disabled={ids.length === 0 || busy != null}
                    onClick={() => run("Unmuting…", () => bulkMute(guildId, ids, false, delay), { keepSelection: true })}
                >Unmute</Button>
                <Button
                    color={Button.Colors.PRIMARY}
                    disabled={ids.length === 0 || busy != null}
                    onClick={() => run("Deafening…", () => bulkDeafen(guildId, ids, true, delay), { keepSelection: true })}
                >Deafen</Button>
                <Button
                    color={Button.Colors.PRIMARY}
                    disabled={ids.length === 0 || busy != null}
                    onClick={() => run("Undeafening…", () => bulkDeafen(guildId, ids, false, delay), { keepSelection: true })}
                >Undeafen</Button>
            </div>
        </Modal>
    );
}
