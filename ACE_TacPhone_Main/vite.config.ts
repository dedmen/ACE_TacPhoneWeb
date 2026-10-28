import { defineConfig, normalizePath, type Plugin, type UserConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { viteSingleFile } from "vite-plugin-singlefile"
import dts from 'vite-plugin-dts'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { discoverDevApps } from './dev-apps.js'

// These are added to global window, see main.tsx
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as ReactJSXRuntime from 'react/jsx-runtime';
import * as ReactCompilerRuntime from 'react/compiler-runtime';
import { SHARED_MODULES } from './shared-modules.js';

// TypeScript checks that this map covers every specifier in SHARED_MODULES.
const sharedModuleNamespaces: Record<(typeof SHARED_MODULES)[number]['specifier'], object> = {
    'react': React,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOMClient,
    'react/jsx-runtime': ReactJSXRuntime,
    'react/compiler-runtime': ReactCompilerRuntime,
};

// Vite dedupes by package name, not by subpath. Derive the package roots from
// the shared module list so every host-provided package is deduped, including
// future additions such as `some-lib` or `@scope/some-lib/subpath`.
const sharedPackageNames = [...new Set(SHARED_MODULES.map(({ specifier }) => {
    const segments = specifier.split('/');
    return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}))];


type DevApp = Awaited<ReturnType<typeof discoverDevApps>>['apps'][number];

// App folders may live outside this Vite root. Import the app through the
// stable /devapps/<Name>/ URL and translate it to Vite's /@fs/ URL here, so the
// app code does not need to know where its folder is on disk.
function devAppsPlugin(devApps: DevApp[], warnings: string[]): Plugin {
    const appsByName = new Map(devApps.map(app => [app.name, app]));

    return {
        name: 'tacphone-dev-apps',
        apply: 'serve',

        configResolved(config) {
            for (const warning of warnings)
                config.logger.warn(warning);
        },

        configureServer(server) {
            for (const app of devApps) {
                // Vite watches imported files automatically; watching the whole
                // folder also picks up new files and non-imported assets.
                server.watcher.add(app.dir);
                server.config.logger.info(
                    `  TacPhone app ${app.name} -> ${relative(server.config.root, app.dir) || app.dir}`,
                );
            }

            server.middlewares.use((req, res, next) => {
                const requestUrl = req.url;
                if (!requestUrl?.startsWith('/devapps/')) return next();

                const url = new URL(requestUrl, 'http://localhost');
                const rest = url.pathname.slice('/devapps/'.length);
                const slashIndex = rest.indexOf('/');

                let name: string;
                let requestedPath: string;
                try {
                    name = decodeURIComponent(slashIndex === -1 ? rest : rest.slice(0, slashIndex));
                    requestedPath = slashIndex === -1
                        ? ''
                        : decodeURIComponent(rest.slice(slashIndex + 1));
                } catch {
                    return next();
                }

                const app = appsByName.get(name);
                if (!app) {
                    res.statusCode = 404;
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.end(
                        `TacPhone development app "${name}" is not registered.\n`
                        + 'Add its folder to dev-apps.local.json, TACPHONE_DEV_APPS, '
                        + 'devapps/, or give its package.json a "tacphone.app" field.\n',
                    );
                    return;
                }

                // Keep requests inside the app folder. A "../" path must not escape.
                const filePath = resolve(app.dir, requestedPath);
                const pathWithinApp = relative(app.dir, filePath);
                if (pathWithinApp === '..'
                    || pathWithinApp.startsWith(`..${sep}`)
                    || isAbsolute(pathWithinApp)) {
                    res.statusCode = 403;
                    res.end('TacPhone dev app path escapes the app folder.\n');
                    return;
                }

                req.url = `/@fs/${encodeURI(filePath.replaceAll('\\', '/'))}${url.search}`;
                next();
            });
        },
    };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }): Promise<UserConfig> => {
    // `vite build` (production) and `npm run build` (release) ship optimized code.
    // Use `npm run build:debug` when you need unminified code and source maps.
    const isRelease = mode !== 'debug';
    const { apps: devApps, warnings } = await discoverDevApps(import.meta.dirname);

    // The dependency optimizer stores resolved paths. Moving an app or adding
    // one to the discovery list would leave stale paths in the old cache, so
    // keep one cache per app layout instead.
    const devAppsCacheKey = createHash('sha256')
        .update(devApps.map(app => `${app.name}:${app.dir}`).sort().join('\n'))
        .digest('hex')
        .slice(0, 12);

    return {
        cacheDir: `node_modules/.vite/tacphone-${devAppsCacheKey}`,

        plugins: [
            react(),
            // Emit per-file declarations; scripts/bundle-api-types.mjs rolls the
            // public API entry (src/TacPhoneMain.ts) into dist/TacPhoneMain.d.ts.
            dts({
                include: ['src'],
                entryRoot: 'src',
                tsconfigPath: './tsconfig.app.json',
            }),
            babel({ presets: [reactCompilerPreset()] }),
            viteSingleFile(),
            devAppsPlugin(devApps, warnings),

            {
                name: 'dynamic-importmap-injector',
                // This hook modifies the index.html file right before it is served to the browser
                transformIndexHtml(html) {
                    // 1. Gather all the keys from your local node_modules installation of React
                    const skippedKeys = new Set(['__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED', '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE', '__COMPILER_RUNTIME', 'default', 'module.exports']);

                    const generateExports = (x: any, locName: string) => {
                        return `export default ${locName}; `
                        +
                        Object.keys(x || {})
                        .filter(key => !skippedKeys.has(key))
                        .map(key => `export const ${key} = ${locName}.${key};`)
                        .join(' ');
                    }

                    // 2. Build the import map from the shared module list.
                    // The same list drives the app build externals, so the two cannot drift apart.
                    const imports: Record<string, string> = {};
                    for (const { specifier, global } of SHARED_MODULES) {
                        const namespace = sharedModuleNamespaces[specifier];
                        imports[specifier] = `data:text/javascript,${generateExports(namespace, `window.${global}`)}`;
                    }

                    const importMap = { imports };

                    const importMapHtml = `<script type="importmap">${JSON.stringify(importMap)}</script>`;

                    // 3. Inject it cleanly at the very top of the <head> tag
                    return html.replace('<head>', `<head>\n    ${importMapHtml}`);
                }
            }

        ],

        optimizeDeps: {
            // The loader imports apps through a computed URL, so Vite's default
            // HTML crawl cannot see their dependencies. Scan app sources too;
            // otherwise the first import of an app can hit "Outdated Optimize Dep"
            // while Vite discovers dependencies such as `ol`.
            entries: [
                'index.html',
                ...devApps.map(app => `${normalizePath(app.dir)}/src/**/*.{ts,tsx,js,jsx}`),
            ],
        },

        resolve: {
            // Apps have their own node_modules. Force every host-provided
            // package to the host copy so hooks, context, and any future shared
            // module stay on one instance in development.
            dedupe: sharedPackageNames,
        },

        server: {
            fs: {
                // Setting this replaces Vite's default allow list, so keep the
                // host root and explicitly allow every discovered app folder.
                allow: [import.meta.dirname, ...devApps.map(app => app.dir)],
            },
        },

        build: {
            minify: isRelease ? 'oxc' : false,
            sourcemap: isRelease ? false : 'inline',
            rollupOptions: isRelease ? {
                treeshake: {
                    // Keep console.warn/error for in-game diagnostics, drop noisy logging.
                    manualPureFunctions: ['console.log', 'console.debug', 'console.info'],
                },
                output: {
                    minify: {
                        compress: true,
                        mangle: true,
                        codegen: true,
                    },
                },
            } : undefined,
        },
    };
})

//#TODO https://github.com/originjs/vite-plugin-federation plugins so mods can provide components?
// https://github.com/originjs/vite-plugin-federation#runtime-add-remotes-with-virtual__federation__ ?

// https://vite.dev/guide/build#library-mode ????? Seems best?
// https://andrewwalpole.com/blog/use-vite-for-javascript-libraries/ ?


// https://github.com/jpkleemans/vite-svg-loader embedding SVG?
// https://github.com/richardtallent/vite-plugin-singlefile single-file pack for Arma?


// Plugins?
// https://stackoverflow.com/questions/43340819/how-to-load-react-component-from-an-external-service-inside-a-react-app-via-ajax
// https://github.com/jamiebuilds/react-loadable
// https://github.com/faceyspacey/react-universal-component
// https://samarjit-samanta.medium.com/react-dynamic-plugins-loading-e45905aa00a7

// Assets https://vite.dev/guide/features#static-assets base64 url?

// https://github.com/caplin/FlexLayout?

// https://vite.dev/config/build-options#build-modulepreload
