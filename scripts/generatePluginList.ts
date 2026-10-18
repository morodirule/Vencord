/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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

import { existsSync, readdirSync, writeFileSync } from "fs";
import { getEntryPoint, isPluginFile, parseDevs, parseEquicordDevs, parseFile, parseMoreleCordDevs, PluginData } from "./utils";

(async () => {
    parseDevs();
    parseEquicordDevs();
    parseMoreleCordDevs();

    const args = process.argv.slice(2);

    const equicordFlag = args.includes("--equicord");
    const vencordFlag = args.includes("--vencord");
    const morelecordFlag = args.includes("--morelecord");

    let dirs: string[];

    if (equicordFlag) {
        dirs = ["src/equicordplugins/_core", "src/equicordplugins"];
    } else if (vencordFlag) {
        dirs = ["src/plugins", "src/plugins/_core"];
    } else if (morelecordFlag) {
        dirs = ["src/morelecordplugins/_core", "src/morelecordplugins"];
    } else {
        dirs = ["src/plugins", "src/plugins/_core", "src/equicordplugins/_core", "src/equicordplugins", "src/morelecordplugins/_core", "src/morelecordplugins"];
    }

    const outputPath = args.find(a => !a.startsWith("--")) ?? null;

    const plugins = [] as PluginData[];

    await Promise.all(
        dirs.filter(dir => existsSync(dir)).flatMap(dir =>
            readdirSync(dir, { withFileTypes: true })
                .filter(isPluginFile)
                .map(async dirent => {
                    const [data] = await parseFile(await getEntryPoint(dir, dirent));
                    plugins.sort().push(data);
                })
        )
    );

    const data = JSON.stringify(plugins);

    if (outputPath) {
        writeFileSync(outputPath, data);
    } else {
        console.log(data);
    }
})();
