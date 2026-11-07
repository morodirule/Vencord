/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./Ping.css";

import { BaseText, type BaseTextProps } from "@components/BaseText";
import { FluxEvent } from "@vencord/discord-types";
import { FluxDispatcher, useEffect, useState } from "@webpack/common";

import { RTCConnectionStore } from "../stores";

export function PingElement({ variant, parenthesis = true, color }: { variant: string; parenthesis?: boolean; color?: string; }) {
    const [ping, setPing] = useState(() => RTCConnectionStore.getLastPing());

    const formatPing = (ping: number | undefined) => {
        if (ping === undefined) return "N/A";
        return parenthesis ? `(${ping} ms)` : `${ping} ms`;
    };

    useEffect(() => {
        const updatePing = (_: FluxEvent) => {
            setPing(RTCConnectionStore.getLastPing());
        };
        FluxDispatcher.subscribe("RTC_CONNECTION_PING", updatePing);
        return () => {
            FluxDispatcher.unsubscribe("RTC_CONNECTION_PING", updatePing);
        };
    }, []);

    const [size, weight] = variant.replace("text-", "").split("/") as [BaseTextProps["size"], BaseTextProps["weight"]];
    return (<BaseText size={size} weight={weight} className="pingDisplay" style={{ color: color ?? "inherit" }}>{formatPing(ping)}</BaseText>);
}
