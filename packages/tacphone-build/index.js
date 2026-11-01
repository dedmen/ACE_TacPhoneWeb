// Public JS exports of @ace-tacphone/build.
export { SHARED_MODULES, SHARED_MODULE_SPECIFIERS } from './shared-modules.js';
export {
    STRINGTABLE_MODULE_ID,
    encodeStringtable,
    parseStringtable,
    readStringtable,
    tacphoneStringtable,
} from './stringtable.mjs';
export {
    runTranslate,
} from './translate.mjs';
export {
    STRINGTABLE_LANGUAGES,
} from './languages.mjs';
export {
    APP_BUNDLE_MARKER,
    APP_BUNDLE_VERSION,
    APP_BUNDLE_CODEC_GZIP,
    formatAppBundleHeader,
    parseAppBundleHeader,
} from './bundle-format.js';
