import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import dts from 'vite-plugin-dts'
import { libInjectCss } from 'vite-plugin-lib-inject-css'
//import { viteSingleFile } from "vite-plugin-singlefile"
//import { viteSingleFile } from "./build/singlefile.ts"
import Inspect from 'vite-plugin-inspect'

// https://vite.dev/config/
export default defineConfig({
  //devtools: true,
  plugins: [
    react(),
    dts({ include: ['src'], insertTypesEntry: true, tsconfigPath: "./tsconfig.app.json", bundleTypes: true }),
    libInjectCss(),
    babel({ presets: [reactCompilerPreset()] }),
    //viteSingleFile(),
    Inspect()
  ],

  experimental: {
    renderBuiltUrl(filename) {
        return { runtime: `window.__toCdnUrl(${JSON.stringify(filename)})` }
    },
  },

  
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/main.tsx'),
      name: 'ace_tacphone_map',
      fileName: 'ace_tacphone_map', //(format) => `ace_tacphone_maps.${format}.js`
    formats: ['es'],
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', 'react/compiler-runtime'],
      output: {
          sourcemap: true,
          sourcemapBaseUrl: 'YOUR SOURCEMAP BASE URL', // https://www.my-source-maps.com
      }
    },
    rolldownOptions: {
      // make sure to externalize deps that shouldn't be bundled
      // into your library
      external: ['react', 'react/jsx-runtime', 'react/compiler-runtime'],
      output: {
        // Provide global variables to use in the UMD build
        // for externalized deps
        globals: {
          react: 'react',
        },
      },
    },
  },

})
