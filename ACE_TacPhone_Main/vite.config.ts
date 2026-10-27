import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { viteSingleFile } from "vite-plugin-singlefile"
import dts from 'vite-plugin-dts'

// These are added to global window, see main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import * as ReactJSXRuntime from 'react/jsx-runtime';


// https://vite.dev/config/
export default defineConfig({
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

                // 2. Build the stringified import map matching your pattern
                const importMap = {
                    imports: {
                        "react": `data:text/javascript,${generateExports(React, "window.React")}`,
                        "react-dom": `data:text/javascript,${generateExports(ReactDOM, "window.ReactDOM")}`,
                        "react/jsx-runtime": `data:text/javascript,${generateExports(ReactJSXRuntime, "window.ReactJSXRuntime")}`
                    }
                };

                const importMapHtml = `<script type="importmap">${JSON.stringify(importMap)}</script>`;

                // 3. Inject it cleanly at the very top of the <head> tag
                return html.replace('<head>', `<head>\n    ${importMapHtml}`);
            }
        }

    ],
    build: {
        minify: false,
        sourcemap: 'inline',
    },
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