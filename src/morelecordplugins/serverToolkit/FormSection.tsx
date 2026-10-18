/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Forms, React } from "@webpack/common";

export function FormSection({ title, children }: { title: React.ReactNode; children: React.ReactNode; }) {
    return (
        <section className="gt-section">
            {title != null && <Forms.FormTitle tag="h3" className="gt-section-title">{title}</Forms.FormTitle>}
            {children}
        </section>
    );
}
