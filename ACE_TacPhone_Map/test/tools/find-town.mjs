#!/usr/bin/env node
/**
 * Finds a town/village name in the terrain `townNames` layer and prints its
 * world coordinates. Used to describe routing fixtures around named places
 * (for example Neochori or Katalaki) without guessing coordinates from a map.
 *
 * Usage (from `websource`; needs the game and host page):
 *
 *   node ACE_TacPhone_Map/test/tools/find-town.mjs --name Neochori
 *   node ACE_TacPhone_Map/test/tools/find-town.mjs --name kata --json
 *   node ACE_TacPhone_Map/test/tools/find-town.mjs --name Neochori --page-url http://localhost:5173/
 *
 * It is a diagnostic tool, not a test, and does not touch the GPS panel.
 */

import { launchHostPage } from '../../../ACE_TacPhone_Main/test/lib/host-page.mjs';

function usage() {
    return [
        'Find a town/village name in the terrain townNames layer.',
        '',
        'Options:',
        '  --name <text>       Name or partial name (case-insensitive; required)',
        '  --page-url <url>    Host page URL (default http://localhost:5173/)',
        '  --json              Print JSON instead of text',
        '  --headed            Show the browser',
        '  --help              Show this text',
    ].join('\n');
}

function parseArgs(argv) {
    const options = {
        name: '',
        pageUrl: 'http://localhost:5173/',
        json: false,
        headed: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error(`Missing value after ${arg}`);
            return argv[index];
        };

        switch (arg) {
            case '--name': options.name = next(); break;
            case '--page-url': options.pageUrl = next(); break;
            case '--json': options.json = true; break;
            case '--headed': options.headed = true; break;
            case '--help':
            case '-h': options.help = true; break;
            default: throw new Error(`Unknown option ${arg}\n\n${usage()}`);
        }
    }

    if (!options.help && options.name.trim() === '') {
        throw new Error(`--name is required\n\n${usage()}`);
    }
    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }

    const { browser, page } = await launchHostPage({
        pageUrl: options.pageUrl,
        headed: options.headed,
    });

    try {
        const matches = await page.evaluate(async (query) => {
            const terrain = await window.TacPhone.networking.LoadGameTerrain({
                drawTreeObjects: false,
                layerMountains: true,
                simpleRoads: true,
            });
            const layer = terrain.layers.find((entry) => /townnames|town|village/i.test(entry.name));
            if (!layer) {
                return { error: 'The terrain has no townNames layer.' };
            }

            const document = new DOMParser().parseFromString(layer.svg, 'image/svg+xml');
            if (document.getElementsByTagName('parsererror').length > 0) {
                return { error: 'The townNames SVG could not be parsed.' };
            }

            const height = terrain.height;
            const needle = query.toLowerCase();
            const found = [];

            const coordinate = (element) => {
                let x = Number(element.getAttribute('x'));
                let y = Number(element.getAttribute('y'));
                if (!Number.isFinite(x) || !Number.isFinite(y)) {
                    const transform = element.getAttribute('transform') ?? '';
                    const translate = /translate\(\s*([-0-9.]+)[ ,]+([-0-9.]+)/.exec(transform);
                    if (translate) {
                        x = Number(translate[1]);
                        y = Number(translate[2]);
                    }
                }
                return Number.isFinite(x) && Number.isFinite(y)
                    ? [x, height - y]
                    : null;
            };

            for (const element of Array.from(document.querySelectorAll('text, tspan'))) {
                const name = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
                if (!name || !name.toLowerCase().includes(needle)) continue;

                let point = coordinate(element);
                let parent = element.parentElement;
                while (!point && parent) {
                    point = coordinate(parent);
                    parent = parent.parentElement;
                }
                if (point) {
                    found.push({ name, x: point[0], y: point[1] });
                }
            }

            return { layer: layer.name, matches: found };
        }, options.name);
        if (matches.error) {
            console.error(matches.error);
            process.exitCode = 1;
            return;
        }
        if (matches.matches.length === 0) {
            console.error(`No town name containing "${options.name}" in ${matches.layer}.`);
            process.exitCode = 1;
            return;
        }

        if (options.json) {
            console.log(JSON.stringify(matches.matches, null, 2));
            return;
        }
        console.log(`Matches for "${options.name}" in ${matches.layer}:`);
        for (const match of matches.matches) {
            console.log(`  ${match.name.padEnd(28)} ${match.x.toFixed(1)}, ${match.y.toFixed(1)}`);
        }
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
