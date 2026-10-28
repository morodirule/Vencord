/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { fetchBuffer, fetchJson } from "@main/utils/http";
import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import { writeFileSync } from "original-fs";
import { join } from "path";

import gitHash from "~git-hash";

import { Updater } from ".";

const REPO = "morodirule/Vencord";
const API_BASE = `https://api.github.com/repos/${REPO}`;

// Release asset name -> local file name in __dirname.
// Discord Desktop injects loose files from dist/ (patcher.js etc).
// Equibop standalone runs from dist/equibop/ (main.js etc) but the
// release publishes them prefixed (equibopMain.js -> main.js).
// See .github/workflows/build.yml "Collect files to be released".
const FILES_TO_UPDATE: Array<[assetName: string, localName: string]> = IS_DISCORD_DESKTOP
    ? [
        ["patcher.js", "patcher.js"],
        ["preload.js", "preload.js"],
        ["renderer.js", "renderer.js"],
        ["renderer.css", "renderer.css"]
    ]
    : [
        ["equibopMain.js", "main.js"],
        ["equibopPreload.js", "preload.js"],
        ["equibopRenderer.js", "renderer.js"],
        ["equibopRenderer.css", "renderer.css"]
    ];

let PendingUpdates: Array<{ asset: string; local: string; url: string }> = [];
let PendingUpdateHash: string | null = null;

async function githubGet<T = any>(endpoint: string) {
    return fetchJson<T>(API_BASE + endpoint, {
        headers: {
            Accept: "application/vnd.github+json",
            // "All API requests MUST include a valid User-Agent header.
            // Requests with no User-Agent header will be rejected."
            "User-Agent": VENCORD_USER_AGENT
        }
    });
}

async function listUpdates() {
    const isOutdated = await fetchUpdate();
    if (!isOutdated) return [];

    let data;
    try {
        data = await githubGet(`/compare/${gitHash}...HEAD`);
    } catch {
        // local commit is not in the remote history (e.g. rewritten or upstream merges)
        return [{ hash: PendingUpdateHash ?? "", author: "GitHub", message: "New release available" }];
    }

    return data.commits.map((c: any) => ({
        hash: c.sha,
        author: c.author?.login ?? c.commit?.author?.name ?? "Unknown Author",
        message: c.commit.message.split("\n")[0]
    }));
}

async function fetchUpdate() {
    const data = await githubGet("/releases/latest");

    const hash = data.name.slice(data.name.lastIndexOf(" ") + 1);
    if (hash === gitHash)
        return false;

    const assetsByName = new Map<string, string>((data.assets ?? []).map((a: any) => [a.name, a.browser_download_url]));

    const missing = FILES_TO_UPDATE.filter(([asset]) => !assetsByName.has(asset)).map(([asset]) => asset);
    if (missing.length) throw new Error(`Latest release is missing ${missing.join(", ")}`);

    PendingUpdates = FILES_TO_UPDATE.map(([asset, local]) => ({ asset, local, url: assetsByName.get(asset)! }));
    PendingUpdateHash = hash;

    return true;
}

async function applyUpdate() {
    if (!PendingUpdates.length) return true;

    // Download everything first so a failed download doesn't leave a half-updated install
    const files = await Promise.all(
        PendingUpdates.map(async ({ local, url }) => ({ local, data: await fetchBuffer(url) }))
    );

    for (const { local, data } of files) {
        // join with __dirname (a directory). Never pass __dirname itself to
        // writeFileSync or Node throws EISDIR.
        writeFileSync(join(__dirname, local), data, { flush: true });
    }

    PendingUpdates = [];

    return true;
}

const HttpUpdater: Updater = {
    getRepo: async () => `https://github.com/${REPO}`,
    listUpdates,
    fetchUpdate,
    applyUpdate
};

export default HttpUpdater;
