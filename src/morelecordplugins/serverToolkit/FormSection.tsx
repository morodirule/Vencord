/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Heading } from "@components/Heading";
import { React } from "@webpack/common";

export function FormSection({ title, children }: { title: React.ReactNode; children: React.ReactNode; }) {
    return (
        <section className="gt-section">
            {title != null && <Heading tag="h3" className="gt-section-title">{title}</Heading>}
            {children}
        </section>
    );
}
