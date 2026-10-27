import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { viteSingleFile } from "vite-plugin-singlefile"
import dts from 'vite-plugin-dts'

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


// https://vite.dev/config/
export default defineConfig(({ mode }) => {
    // `vite build` (production) and `npm run build` (release) ship optimized code.
    // Use `npm run build:debug` when you need unminified code and source maps.
    const isRelease = mode !== 'debug';

    return {
        plugins: [
            react(),
            dts({ include: ['src'], insertTypesEntry: true, tsconfigPath: "./tsconfig.app.json",  }),
            babel({ presets: [reactCompilerPreset()] }),
            viteSingleFile(),

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
