import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import dts from 'vite-plugin-dts'
import { libInjectCss } from 'vite-plugin-lib-inject-css'
//import { viteSingleFile } from "vite-plugin-singlefile"
import { viteSingleFile } from "./build/singlefile.ts"
import Inspect from 'vite-plugin-inspect'
import { SHARED_MODULE_SPECIFIERS } from '../../shared-modules.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // `vite build` (production) and `npm run build` (release) ship optimized code.
  // Use `npm run build:debug` when you need unminified code and source maps.
  const isRelease = mode !== 'debug';

  return {
    devtools: false,
    plugins: [
      react(),
      dts({ include: ['src'], bundleTypes: true, }),
      libInjectCss(),
      babel({ presets: [reactCompilerPreset()] }),
      viteSingleFile(),
      Inspect()
    ],

    experimental: {
      renderBuiltUrl(filename) {
          return { runtime: `window.__toCdnUrl(${JSON.stringify(filename)})` }
      },
    },


    build: {
      minify: isRelease ? 'oxc' : false,
      sourcemap: isRelease ? false : 'inline',
      lib: {
          entry: resolve(import.meta.dirname, 'src/main.tsx'),
          name: 'ace_tacphone_map',
          fileName: () => `ace_tacphone_map.js`,
          formats: ['es'], // The production loader imports this file as an ES module from a blob URL
      },
      rollupOptions: {

          // Only the exact bare specifiers provided by ACE_TacPhone_Main's import map may stay external.
          // The shared list also generates that import map, so the two cannot drift apart.
          // Everything else has to be bundled into the single output file.
          external: [...SHARED_MODULE_SPECIFIERS],
          ...(isRelease ? {
              treeshake: {
                  // Keep console.warn/error for in-game diagnostics, drop noisy logging.
                  manualPureFunctions: ['console.log', 'console.debug', 'console.info'],
              },
          } : {}),
          output: {
              // The production loader can only fetch one file. Never emit separate chunks.
              codeSplitting: false,
              ...(isRelease ? {
                  minify: {
                      compress: true,
                      mangle: true,
                      codegen: true,
                  },
              } : {}),
          }
      }
    },
  };
})
