import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { viteSingleFile } from "vite-plugin-singlefile"
import dts from 'vite-plugin-dts'

// https://vite.dev/config/
export default defineConfig({
    plugins: [
        react(),
        dts({ include: ['src'], insertTypesEntry: true, tsconfigPath: "./tsconfig.app.json",  }),
        babel({ presets: [reactCompilerPreset()] }),
        viteSingleFile()
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