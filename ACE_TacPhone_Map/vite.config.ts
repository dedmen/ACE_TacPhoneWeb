import { resolve } from 'node:path'
import { defineConfig, type PluginOption } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { libInjectCss } from 'vite-plugin-lib-inject-css'
import { viteSingleFile } from '@ace-tacphone/build/singlefile'
import Inspect from 'vite-plugin-inspect'
import { SHARED_MODULE_SPECIFIERS } from '@ace-tacphone/build/shared-modules'

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  // `vite build` (production) and `npm run build` (release) ship optimized code.
  // Use `npm run build:debug` when you need unminified code and source maps.
  const isRelease = mode !== 'debug';

  const plugins: PluginOption[] = [
    react(),
    libInjectCss(),
    babel({ presets: [reactCompilerPreset()] }),
    viteSingleFile({ failOnNotInlined: isRelease }),
  ];

  // Debugging aid for the dev server only; it must not run for builds.
  if (command === 'serve') {
    plugins.push(Inspect());
  }

  return {
    devtools: false,
    plugins,

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
