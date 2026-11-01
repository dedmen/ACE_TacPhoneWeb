#!/usr/bin/env node
/**
 * One-shot TacPhone build and install.
 *
 * Checks what actually changed, then builds only the affected web apps, the
 * native web-host DLL when its source is newer, and the game PBO when its data
 * or SQF/config sources changed. Successful steps are quiet; only errors and
 * skipped installs are reported.
 *
 * Usage (from `websource`):
 *
 *   npm run build:all
 *   npm run build:all -- --check
 *   npm run build:all -- --build-only
 *   npm run build:all -- --force
 *
 * `--build-only` builds without copying the PBO or native DLL into the game.
 * `--check` only prints what would be built/copied.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACE3 = path.resolve(ROOT, '..', '..', '..');
const BUILD_STATE = path.join(ROOT, 'node_modules', '.cache', 'tacphone-build.json');
const MOD_PBO_SUFFIX = ['@acedev', 'addons', 'ace_tacphone.pbo'];
const PBO = path.join(ACE3, '.hemttout', 'build', 'addons', 'ace_tacphone.pbo');

const PACKAGES = [
    path.join(ROOT, 'packages', 'tacphone-api'),
    path.join(ROOT, 'packages', 'tacphone-build'),
    path.join(ROOT, 'package.json'),
];

const WEB_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.css', '.scss', '.sass', '.html', '.json',
    '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.wasm',
]);

const APPS = [
    {
        name: 'host',
        workspace: 'ace-tacphone-main',
        dir: path.join(ROOT, 'ACE_TacPhone_Main'),
        dist: [path.join(ROOT, 'ACE_TacPhone_Main', 'dist', 'index.html')],
        data: [[
            path.join(ROOT, 'ACE_TacPhone_Main', 'dist', 'index.html'),
            path.join(ACE3, 'addons', 'tacphone', 'data', 'index.html'),
        ]],
    },
    {
        name: 'map',
        workspace: 'ace-tacphone-map',
        dir: path.join(ROOT, 'ACE_TacPhone_Map'),
        dist: [
            path.join(ROOT, 'ACE_TacPhone_Map', 'dist', 'ace_tacphone_map.js'),
            path.join(ROOT, 'ACE_TacPhone_Map', 'dist', 'ace_tacphone_ol.js'),
        ],
        data: [
            [
                path.join(ROOT, 'ACE_TacPhone_Map', 'dist', 'ace_tacphone_map.js'),
                path.join(ACE3, 'addons', 'tacphone', 'apps', 'map', 'data', 'ace_tacphone_map.js'),
            ],
            [
                path.join(ROOT, 'ACE_TacPhone_Map', 'dist', 'ace_tacphone_ol.js'),
                path.join(ACE3, 'addons', 'tacphone', 'apps', 'map', 'data', 'ace_tacphone_ol.js'),
            ],
        ],
    },
    {
        name: 'messaging',
        workspace: 'ace-tacphone-messaging',
        dir: path.join(ROOT, 'MessagingApp'),
        dist: [path.join(ROOT, 'MessagingApp', 'dist', 'ace_tacphone_messaging.js')],
        data: [[
            path.join(ROOT, 'MessagingApp', 'dist', 'ace_tacphone_messaging.js'),
            path.join(ACE3, 'addons', 'tacphone', 'apps', 'messaging', 'data', 'ace_tacphone_messaging.js'),
        ]],
    },
    {
        name: 'sample',
        workspace: 'ace-tacphone-sampleapp',
        dir: path.join(ROOT, 'SampleApp'),
        dist: [path.join(ROOT, 'SampleApp', 'dist', 'ace_tacphone_sampleapp.js')],
        data: [[
            path.join(ROOT, 'SampleApp', 'dist', 'ace_tacphone_sampleapp.js'),
            path.join(ACE3, 'addons', 'tacphone', 'apps', 'SampleApp', 'data', 'ace_tacphone_sampleapp.js'),
        ]],
    },
];

const WEB_SOURCE_EXCLUDES = new Set([
    'node_modules', 'dist', 'data', 'test', 'tests', 'coverage', '.vite', '.git',
]);
const WEBHOST_SOURCE_EXCLUDES = new Set(['bin', 'obj', '.git']);
const GAME_SOURCE_EXCLUDES = new Set(['websource', 'node_modules', '.git']);

const WEBHOST_DIR = path.join(ROOT, 'WebServerExtension');
const WEBHOST_OBJ = path.join(WEBHOST_DIR, 'obj');
const WEBHOST_PUBLISH = path.join(
    WEBHOST_DIR,
    'bin', 'x64', 'Release', 'net10.0', 'win-x64', 'publish', 'arma_webhost_x64.dll',
);
const BOM_FILE_EXTENSIONS = new Set(['.rsp', '.txt', '.json', '.xml', '.def', '.props', '.targets', '.cs']);

function parseArgs(argv) {
    const options = {
        check: false,
        buildOnly: false,
        force: false,
        release: false,
        verbose: false,
        help: false,
        armaPath: undefined,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '--check' || argument === '--dry-run') options.check = true;
        else if (argument === '--build-only') options.buildOnly = true;
        else if (argument === '--force') options.force = true;
        else if (argument === '--release') options.release = true;
        else if (argument === '--verbose') options.verbose = true;
        else if (argument === '--help' || argument === '-h') options.help = true;
        else if (argument === '--arma-path') {
            index += 1;
            if (index >= argv.length) throw new Error('Missing value after --arma-path');
            options.armaPath = argv[index];
        } else if (argument.startsWith('--arma-path=')) {
            options.armaPath = argument.slice('--arma-path='.length);
        } else throw new Error(`Unknown argument: ${argument}`);
    }

    return options;
}

function printHelp() {
    console.log(`TacPhone build and install

Usage:
  node scripts/build-all.mjs [options]

Options:
  --check        Show what would be built/copied, change nothing
  --build-only   Build without copying the PBO or native DLL into the game
  --force        Rebuild everything and copy it
  --release      Release web/PBO build (default: debug)
  --arma-path <path>  Arma 3 root (default: ARMA3_PATH, then the registry)
  --verbose      Print decisions and step details
  --help         Show this help

Environment:
  ARMA3_PATH     Arma 3 root; overrides the registry lookup

Debug (default) uses the unminified web bundles and a non-binarized HEMTT build.
Release uses the minified bundles and a binarized HEMTT build. The native
web-host is always published in Release.
`);
}

function registryValue(key, value) {
    if (process.platform !== 'win32') {
        return null;
    }

    const result = spawnSync('reg', ['query', key, '/v', value], {
        encoding: 'utf8',
        windowsHide: true,
    });

    if (result.status !== 0 || typeof result.stdout !== 'string') {
        return null;
    }

    const pattern = new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_\\w+\\s+(.+)$`, 'im');
    const match = pattern.exec(result.stdout);
    return match ? match[1].trim().replace(/^"|"$/g, '') : null;
}

function findArmaPath(options) {
    const candidates = [];

    if (options.armaPath) {
        candidates.push(options.armaPath);
    }

    if (process.env.ARMA3_PATH) {
        candidates.push(process.env.ARMA3_PATH);
    }

    if (process.platform === 'win32') {
        // The installer writes the game root to `main` under the version key.
        // Accept the user-supplied `...\arma 3\main` shape too, where the
        // directory itself may contain a path-valued `main`.
        const keys = [
            'HKLM\\SOFTWARE\\WOW6432Node\\bohemia interactive\\arma 3',
            'HKLM\\SOFTWARE\\bohemia interactive\\arma 3',
            'HKLM\\SOFTWARE\\WOW6432Node\\bohemia interactive\\arma 3\\main',
            'HKLM\\SOFTWARE\\bohemia interactive\\arma 3\\main',
        ];
        const values = ['main', 'path'];

        for (const key of keys) {
            for (const value of values) {
                const found = registryValue(key, value);
                if (found && !found.startsWith('%')) {
                    candidates.push(found);
                }
            }
        }
    }

    for (const candidate of candidates) {
        const resolved = path.resolve(candidate.trim());
        if (existsSync(resolved)) {
            return resolved;
        }
    }

    return null;
}

function readBuildState() {
    try {
        return JSON.parse(readFileSync(BUILD_STATE, 'utf8'));
    } catch {
        return {};
    }
}

function writeBuildState(mode) {
    try {
        mkdirSync(path.dirname(BUILD_STATE), { recursive: true });
        writeFileSync(BUILD_STATE, JSON.stringify({ mode, at: new Date().toISOString() }));
    } catch {
        // The state file only avoids unnecessary rebuilds; never fail the build.
    }
}

function isArmaRunning() {
    if (process.platform !== 'win32') {
        return false;
    }

    const result = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
    });

    if (result.status !== 0 || typeof result.stdout !== 'string') {
        return false;
    }

    return result.stdout.split(/\r?\n/).some((line) => /^"arma3/i.test(line));
}

function newestMtime(paths, options = {}) {
    const { excludeDirs = new Set(), extensions = null } = options;
    let newest = 0;

    const visit = (target) => {
        let stats;

        try {
            stats = statSync(target);
        } catch {
            return;
        }

        if (stats.isDirectory()) {
            if (excludeDirs.has(path.basename(target))) {
                return;
            }

            for (const entry of readdirSync(target, { withFileTypes: true })) {
                visit(path.join(target, entry.name));
            }
            return;
        }

        if (!stats.isFile()) {
            return;
        }

        if (extensions && !extensions.has(path.extname(target).toLowerCase())) {
            return;
        }

        newest = Math.max(newest, stats.mtimeMs);
    };

    for (const target of paths) {
        visit(target);
    }

    return newest;
}

function mtime(file) {
    try {
        return statSync(file).mtimeMs;
    } catch {
        return 0;
    }
}

/**
 * HEMTT refuses text files with a UTF-8 BOM. The NativeAOT linker writes one
 * into obj/.../native/link.rsp; strip generated BOMs before the PBO build.
 */
function stripGeneratedBoms(root) {
    if (!existsSync(root)) {
        return;
    }

    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const target = path.join(root, entry.name);

        if (entry.isDirectory()) {
            stripGeneratedBoms(target);
            continue;
        }

        if (!entry.isFile() || !BOM_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            continue;
        }

        const content = readFileSync(target);
        if (content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
            writeFileSync(target, content.subarray(3));
        }
    }
}

function size(file) {
    try {
        return statSync(file).size;
    } catch {
        return -1;
    }
}

function copyNeeded(source, target) {
    return mtime(source) > mtime(target) + 1000 || size(source) !== size(target);
}

function copyIfNeeded(source, target, label, force) {
    if (!source || !target) {
        return false;
    }

    if (!existsSync(source)) {
        throw new Error(`built file does not exist: ${source}`);
    }

    if (!existsSync(path.dirname(target))) {
        console.log(`SKIP ${label}: target folder does not exist`);
        return false;
    }

    if (!force && !copyNeeded(source, target)) {
        return false;
    }

    copyFileSync(source, target);
    console.log(`copied ${label}`);
    return true;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        windowsHide: true,
        shell: options.shell === true,
        maxBuffer: 64 * 1024 * 1024,
    });

    if (result.status === 0) {
        return result;
    }

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '');
    const detail = lines.slice(-60).join('\n');
    throw new Error(
        `${command} ${args.join(' ')} failed with exit ${result.status}` +
            (detail ? `\n${detail}` : ''),
    );
}

function runNpm(args, cwd) {
    const npmExec = process.env.npm_execpath;

    if (npmExec && /\.(?:c?js|mjs)$/i.test(npmExec)) {
        return run(process.execPath, [npmExec, ...args], { cwd });
    }

    return run('npm', args, { cwd, shell: process.platform === 'win32' });
}

/**
 * The npm build scripts run `tsc -b`; running one per changed workspace is
 * enough because every app rebuilds its own dependency graph.
 */
function buildWebApps(apps, mode, log) {
    const script = mode === 'release' ? 'build' : 'build:debug';

    for (const app of apps) {
        log?.(`building ${app.name} (${app.workspace}, ${mode})`);
        runNpm(['run', script, '-w', app.workspace], ROOT);
    }
}

function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        printHelp();
        return;
    }

    const log = options.verbose ? (message) => console.log(`  . ${message}`) : undefined;
    const mode = options.release ? 'release' : 'debug';
    const armaPath = findArmaPath(options);
    const modPbo = armaPath ? path.join(armaPath, ...MOD_PBO_SUFFIX) : null;
    const webhostTarget = armaPath ? path.join(armaPath, 'arma_webhost_x64.dll') : null;
    const modeChanged = readBuildState().mode !== mode;
    const gameRunning = isArmaRunning();

    if (!armaPath && !options.buildOnly && !options.check) {
        console.error('Could not find the Arma 3 installation. Set ARMA3_PATH or pass --arma-path.');
        process.exitCode = 2;
        return;
    }

    if (gameRunning && !options.buildOnly && !options.check) {
        console.error('Arma is running. Close it before installing, or use --build-only.');
        process.exitCode = 2;
        return;
    }

    const force = options.force;
    const packageTime = newestMtime(PACKAGES, {
        excludeDirs: WEB_SOURCE_EXCLUDES,
        extensions: WEB_EXTENSIONS,
    });

    const web = APPS.map((app) => {
        const sourceTime = Math.max(
            packageTime,
            newestMtime([app.dir], {
                excludeDirs: WEB_SOURCE_EXCLUDES,
                extensions: WEB_EXTENSIONS,
            }),
        );
        const distTime = Math.min(...app.dist.map((file) => mtime(file)));
        const build = force || modeChanged || distTime === 0 || sourceTime > distTime + 1000;
        const copy = build || app.data.some(([from, to]) => copyNeeded(from, to));

        return { ...app, build, copy };
    });

    const appsToBuild = web.filter((app) => app.build);
    const webCopyNeeded = web.some((app) => app.copy);
    const gameSourceTime = newestMtime(
        [path.join(ACE3, 'addons', 'tacphone')],
        { excludeDirs: GAME_SOURCE_EXCLUDES },
    );
    const pboTime = mtime(PBO);
    const pboBuild = force || modeChanged || pboTime === 0 || webCopyNeeded || gameSourceTime > pboTime + 1000;
    const pboCopy = force || pboBuild || (modPbo !== null && copyNeeded(PBO, modPbo));

    const webhostSourceTime = newestMtime([WEBHOST_DIR, path.join(ROOT, 'WebHostExtension_FeatureFlagsExport')], {
        excludeDirs: WEBHOST_SOURCE_EXCLUDES,
    });
    const webhostPublishTime = mtime(WEBHOST_PUBLISH);
    const webhostBuild = force || webhostPublishTime === 0 || webhostSourceTime > webhostPublishTime + 1000;
    const webhostCopy = force || webhostBuild
        || (webhostTarget !== null && copyNeeded(WEBHOST_PUBLISH, webhostTarget));

    if (options.check) {
        console.log(`Mode: ${mode}`);
        console.log(`Arma: ${armaPath ?? 'not found (set ARMA3_PATH or --arma-path)'}`);
        if (gameRunning) console.log('Arma is running; installs would be skipped');
        console.log(`Web: ${appsToBuild.length > 0 ? `build ${appsToBuild.map((app) => app.name).join(', ')}` : 'up to date'}`);
        if (webCopyNeeded) console.log('Web: data copies needed');
        console.log(`PBO: ${pboBuild ? 'build' : 'up to date'}${pboCopy ? ', copy to @acedev' : ''}`);
        console.log(`Webhost: ${webhostBuild ? 'publish' : 'up to date'}${webhostCopy ? ', copy to game' : ''}`);
        return;
    }

    if (appsToBuild.length === 0 && !webCopyNeeded && !pboBuild && !pboCopy
        && !webhostBuild && !webhostCopy) {
        writeBuildState(mode);
        console.log('Everything is up to date.');
        return;
    }

    if (appsToBuild.length > 0) {
        buildWebApps(appsToBuild, mode, log);
    }

    if (webCopyNeeded) {
        if (options.buildOnly) {
            log?.('data copy is still needed for the PBO build');
        }

        for (const app of web) {
            for (const [from, to] of app.data) {
                copyIfNeeded(from, to, path.relative(ROOT, to), force);
            }
        }
    }

    if (pboBuild) {
        log?.(`building ace_tacphone PBO (${mode})`);
        stripGeneratedBoms(WEBHOST_OBJ);
        const pboArgs = mode === 'release'
            ? ['build', '--just', 'tacphone']
            : ['build', '--no-bin', '--just', 'tacphone'];
        const result = spawnSync('hemtt', pboArgs, {
            cwd: ACE3,
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 64 * 1024 * 1024,
            shell: false,
        });

        if (result.status !== 0) {
            const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
            const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '');
            throw new Error(`hemtt build failed with exit ${result.status}\n${lines.slice(-60).join('\n')}`);
        }

        log?.('PBO built');
    }

    if (webhostBuild) {
        log?.('publishing native web host');
        run('dotnet', ['publish', 'ArmaServerSide.csproj', '-c', 'Release', '-p:Platform=x64'], {
            cwd: WEBHOST_DIR,
        });
        log?.('native web host published');
    }

    writeBuildState(mode);

    if (options.buildOnly) {
        console.log('Build complete; PBO and native DLL were not installed (--build-only).');
        return;
    }

    if (pboCopy && modPbo !== null) {
        copyIfNeeded(PBO, modPbo, '@acedev/addons/ace_tacphone.pbo', force);
    }

    if (webhostCopy && webhostTarget !== null) {
        copyIfNeeded(WEBHOST_PUBLISH, webhostTarget, 'arma_webhost_x64.dll', force);
    }

    console.log(`TacPhone ${mode} build and install complete.`);
}

try {
    main();
} catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
}
