// Stringtable parsing and language selection for the web UI.
//
// The table keeps the add-on key IDs (`STR_ACE_Tacphone_...`) and maps them to
// text per language. It is filled from two places:
//   - the compressed copy bundled into the host at build time, used before the
//     game is reachable (remote pairing screen, loading line, fatal error), and
//   - the add-on's `stringtable.xml`, loaded through the game's file request
//     once the connection is up.

/** `language tag -> key -> text` */
export type StringTable = Record<string, Record<string, string>>

/** `key -> text` for one language, keyed upper-case. */
export type LanguageTable = Map<string, string>

/**
 * Game language names (the value `language` returns) mapped to stringtable tags.
 *
 * Both the English class name and the native in-game name are accepted, because
 * the engine returns the in-game name while configs and documentation use the
 * class name.
 */
const GAME_LANGUAGE_TAGS: Record<string, string> = {
    english: 'English',
    czech: 'Czech',
    'čeština': 'Czech',
    cestina: 'Czech',
    french: 'French',
    'français': 'French',
    francais: 'French',
    spanish: 'Spanish',
    'español': 'Spanish',
    espanol: 'Spanish',
    italian: 'Italian',
    italiano: 'Italian',
    polish: 'Polish',
    polski: 'Polish',
    portuguese: 'Portuguese',
    'português do brasil': 'Portuguese',
    portugues: 'Portuguese',
    russian: 'Russian',
    'русский': 'Russian',
    german: 'German',
    deutsch: 'German',
    korean: 'Korean',
    '한국어': 'Korean',
    japanese: 'Japanese',
    '日本語': 'Japanese',
    chinese: 'Chinese',
    '繁體中文': 'Chinese',
    chinesesimp: 'Chinesesimp',
    '简体中文': 'Chinesesimp',
    turkish: 'Turkish',
    'türkçe': 'Turkish',
    turkce: 'Turkish',
    slovak: 'Slovak',
    'slovinčina': 'Slovak',
    ukrainian: 'Ukrainian',
    'українська': 'Ukrainian',
    latin: 'Latin',
    latina: 'Latin',
    bulgarian: 'Bulgarian',
    'български': 'Bulgarian',
    hungarian: 'Hungarian',
    magyar: 'Hungarian',
    swedish: 'Swedish',
    serbocroatian: 'SerboCroatian',
    norwegian: 'Norwegian',
    icelandic: 'Icelandic',
    greek: 'Greek',
    finnish: 'Finnish',
    dutch: 'Dutch',
}

/** Browser language subtags mapped to stringtable tags. */
const BROWSER_LANGUAGE_TAGS: Record<string, string> = {
    en: 'English',
    cs: 'Czech',
    fr: 'French',
    es: 'Spanish',
    it: 'Italian',
    pl: 'Polish',
    pt: 'Portuguese',
    ru: 'Russian',
    de: 'German',
    ko: 'Korean',
    ja: 'Japanese',
    zh: 'Chinesesimp',
    tr: 'Turkish',
    sk: 'Slovak',
    uk: 'Ukrainian',
    la: 'Latin',
    bg: 'Bulgarian',
    hu: 'Hungarian',
    sv: 'Swedish',
    hr: 'SerboCroatian',
    sr: 'SerboCroatian',
    nb: 'Norwegian',
    no: 'Norwegian',
    is: 'Icelandic',
    el: 'Greek',
    fi: 'Finnish',
    nl: 'Dutch',
}

/** Maps a game language name to a stringtable tag; unknown names yield undefined. */
export function gameLanguageTag(language: string): string | undefined {
    return GAME_LANGUAGE_TAGS[language.trim().toLowerCase()]
}

/**
 * Stringtable tag for the browser's preferred language, falling back to English.
 * Traditional Chinese locales (`zh-TW`, `zh-HK`, `zh-Hant`) map to `Chinese`,
 * everything else `zh-*` to `Chinesesimp`.
 */
export function browserLanguageTag(languages: readonly string[] = navigator.languages ?? [navigator.language]): string {
    for (const language of languages) {
        const parts = language.toLowerCase().split('-')
        const base = parts[0]

        if (base === 'zh') {
            if (parts.includes('hant') || parts.includes('tw') || parts.includes('hk') || parts.includes('mo'))
                return 'Chinese'

            return 'Chinesesimp'
        }

        const tag = BROWSER_LANGUAGE_TAGS[base]
        if (tag)
            return tag
    }

    return 'English'
}

/**
 * Parses a stringtable into `{ language: { key: text } }` in the browser.
 *
 * Throws when the text is not XML or contains no `<Key>` entries, so a broken
 * file is reported instead of silently emptying the table.
 */
export function parseStringtable(xmlText: string): StringTable {
    const document = new DOMParser().parseFromString(xmlText, 'application/xml')

    if (document.querySelector('parsererror'))
        throw new Error('the file is not valid XML')

    const table: StringTable = {}
    const keys = document.getElementsByTagName('Key')

    for (const keyElement of Array.from(keys)) {
        const id = keyElement.getAttribute('ID')?.trim()
        if (!id)
            continue

        for (const entry of Array.from(keyElement.children)) {
            const text = entry.textContent?.trim() ?? ''
            const languageTable = table[entry.tagName] ??= {}
            languageTable[id] = text
        }
    }

    if (Object.keys(table).length === 0)
        throw new Error('the file contains no translations')

    return table
}

/** One language of a parsed table, upper-cased for case-insensitive lookups. */
export function pickLanguage(table: StringTable, tag: string): LanguageTable {
    const result: LanguageTable = new Map()

    // English is the base: a partial translation keeps English text for keys it
    // does not cover, and an empty translation entry falls back instead of
    // blanking the label.
    const sources = [table.English ?? {}, table[tag] ?? {}]

    if (sources[1] === sources[0])
        sources.pop()

    for (const source of sources) {
        for (const [key, text] of Object.entries(source)) {
            if (text.trim().length === 0)
                continue

            result.set(key.toUpperCase(), text)
        }
    }

    if (result.size === 0) {
        for (const [key, text] of Object.entries(Object.values(table)[0] ?? {})) {
            if (text.trim().length > 0)
                result.set(key.toUpperCase(), text)
        }
    }

    return result
}
