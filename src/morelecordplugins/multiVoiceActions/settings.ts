/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    confirmBeforeDisconnect: {
        type: OptionType.BOOLEAN,
        description: "Ask for confirmation before disconnecting users",
        default: true
    },
    clearAfterAction: {
        type: OptionType.BOOLEAN,
        description: "Clear selection after a move/disconnect action",
        default: true
    },
    highlightSelection: {
        type: OptionType.BOOLEAN,
        description: "Highlight selected users in the voice channel list",
        default: true
    },
    fanOutContextMenu: {
        type: OptionType.BOOLEAN,
        description: "Apply right-click menu actions (mute, move, disconnect, …) to every selected user",
        default: true
    },
    multiDrag: {
        type: OptionType.BOOLEAN,
        description: "Dragging a selected user moves the whole selection",
        default: true
    },
    actionDelayMs: {
        type: OptionType.SLIDER,
        description: "Delay between individual member updates (ms, avoids rate limits)",
        markers: [0, 100, 150, 250, 500],
        default: 150,
        stickToMarkers: false
    }
});
