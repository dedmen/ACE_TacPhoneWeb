/// <reference types="vite/client" />

/**
 * Compressed default string table: `base64(gzip(JSON))` of
 * `{ [language]: { [key]: text } }`, parsed from the add-on stringtable at
 * build time by the `tacphoneStringtable` plugin.
 */
declare module 'virtual:tacphone-stringtable' {
    const data: string
    export default data
}
