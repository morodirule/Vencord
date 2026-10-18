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
    actionDelayMs: {
        type: OptionType.SLIDER,
        description: "Delay between individual member updates (ms, avoids rate limits)",
        markers: [0, 100, 150, 250, 500],
        default: 150,
        stickToMarkers: false
    }
});
