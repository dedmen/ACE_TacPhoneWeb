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
        formats: ['es'], // UMD format works best for global injection
    },
    rollupOptions: {

        // See ACE_TacPhoneMain/src/main.tsx, it declares what is publicly available
        external: ['react', 'react-dom', 'react-dom/client', 'react/compiler-runtime', 'react/jsx-runtime'],
        output: {

            // Map the externalized React imports to the framework's window globals
            //globals: {
            //'react': 'React',
            //'react-dom': 'ReactDOM',
            //'react/jsx-runtime': 'ReactJSXRuntime'
            //},

            // These can be used to map names the library has in import, to the names of the ACE_TacPhone_Main's index.html import map.
            // In this case we don't care though, as we just make them be equal
            paths: {
                //react: 'react',
                //'react-dom': 'ReactDOM',
                //'react/jsx-runtime': 'ReactJSXRuntime'
            },
        }
    }
  },

})
