import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import dts from 'vite-plugin-dts'
import { libInjectCss } from 'vite-plugin-lib-inject-css'
//import { viteSingleFile } from "vite-plugin-singlefile"
import { viteSingleFile } from "./build/singlefile.ts"
import Inspect from 'vite-plugin-inspect'

// https://vite.dev/config/
export default defineConfig({
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
    minify: false,
    sourcemap: 'inline',
    lib: {
        entry: resolve(import.meta.dirname, 'src/main.tsx'),
        name: 'ace_tacphone_map',
        fileName: () => `ace_tacphone_map.js`,
        formats: ['es'], // The production loader imports this file as an ES module from a blob URL
    },
    rollupOptions: {

        // Only the exact bare specifiers provided by ACE_TacPhone_Main's import map may stay external.
        // Everything else has to be bundled into the single output file.
        external: ['react', 'react-dom', 'react/jsx-runtime', 'react/compiler-runtime'],
        output: {
            // The production loader can only fetch one file. Never emit separate chunks.
            codeSplitting: false,
        }
    }
  },

})
