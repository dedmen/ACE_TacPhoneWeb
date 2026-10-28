import { type UserConfig, type PluginOption } from "vite"
import type { OutputChunk, OutputAsset } from "rollup"
import micromatch from "micromatch"

// This is a modified variant of https://www.npmjs.com/package/vite-plugin-singlefile
// Instead of merging into a .html, we merge into a .js
// The javascript should already bundle all the scripts, but we need to resolve css imports, by converting them into a data URL

export type Config = {
	// Modifies the Vite build config to make this plugin work well. See `_useRecommendedBuildConfig`
	// in the plugin implementation for more details on how this works.

	//
	// @default true
	useRecommendedBuildConfig?: boolean
	// Optionally, only inline assets that match one or more glob patterns.
	//
	// @default []
	inlinePattern?: string[]
	// Optionally, delete inlined assets preventing them from being output.
	//
	// @default true
	deleteInlinedFiles?: boolean
	// Fail the build when an asset cannot be inlined. The production loader can
	// only load the single entry file, so a side asset is unusable in game.
	//
	// @default false
	failOnNotInlined?: boolean
	// If you need to override anything specific in the recommended build config, pass a sparse
	// object here. For example, use `{ base: "/" }` to override the default "./" base path for
	// non-inlined public files.
	overrideConfig?: Partial<UserConfig>
}

const defaultConfig = { useRecommendedBuildConfig: true, deleteInlinedFiles: true, failOnNotInlined: false }

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function replaceCss(jsContent: string, cssFilename: string, cssCode: string): string {

    // https://web.dev/articles/css-module-scripts#dynamically_imported_stylesheets
    // We cannot use import from file, because in Arma we are not running in a browser, so, we convert to a dynamic import, and use the core file loading API to fetch it
    //#TODO we can also choose to embed a data URL?

    // We turn `import './main.css'` into an inline stylesheet, regardless of the quoting and whitespace a minifier chose.

    var cssUrl = 'data:text/css;charset=UTF-8,' + encodeURIComponent(cssCode);

    // Doesn't work, mimetype missmatch
    //var repTarget = `import '${cssUrl}' with { type: "css" };`;

    // Convert it into a stylesheet link we'll insert into head. JSON.stringify
    // quotes and escapes the URL; encodeURIComponent leaves ' alone, which would
    // terminate the single-quoted JS string and break the whole bundle.
    var repTarget = `(()=> {const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = ${JSON.stringify(cssUrl)}; document.head.appendChild(link);})();`;

    // Match both static imports and dynamic imports, with single or double quotes and arbitrary whitespace.
    const importPattern = new RegExp(
        `import\\s*(?:\\(\\s*)?(['"])(?:[^'"]*[/\\\\])?${escapeRegExp(cssFilename)}\\1\\s*\\)?`,
        "g"
    );

    let replacementCount = 0;
    const inlined = jsContent.replace(importPattern, () => {
        replacementCount++;
        return repTarget;
    });

    if (replacementCount === 0) {
        // When CSS code splitting is disabled, no JS import for the stylesheet may be emitted. Add it ourselves.
        return `${inlined}\n${repTarget}`;
    }

	return inlined
}

const isJsFile = /\.[mc]?js$/
const isCssFile = /\.css$/
//const isHtmlFile = /\.html?$/

export function viteSingleFile({
	useRecommendedBuildConfig = true,
	inlinePattern = [],
	deleteInlinedFiles = true,
	failOnNotInlined = false,
	overrideConfig = {},
}: Config = defaultConfig): PluginOption {
	// Modifies the Vite build config to make this plugin work well.
	const _useRecommendedBuildConfig = (config: UserConfig) => {
		if (!config.build) config.build = {}
		// Ensures that even very large assets are inlined in your JavaScript.
		config.build.assetsInlineLimit = () => true
		// Avoid warnings about large chunks.
		config.build.chunkSizeWarningLimit = 100000000
		// Emit all CSS as a single file, which `vite-plugin-singlefile` can then inline.
		config.build.cssCodeSplit = false
		// We need relative path to support any static files in public folder,
		// which are copied to ${build.outDir} by vite.
		config.base = "./"
		// Make generated files in ${build.outDir}'s root, instead of default ${build.outDir}/assets.
		// Then the embedded resources can be loaded by relative path.
		config.build.assetsDir = ""

		Object.assign(config, overrideConfig)
	}

	return {
		name: "vite:singlefile",
		config: useRecommendedBuildConfig ? _useRecommendedBuildConfig : undefined,
		enforce: "post",

        //async configResolved(config) {
        //    const resolvedNames = config.plugins.map(p => p.name)
        //    console.log(resolvedNames);
        //},


		generateBundle(_options: unknown, bundle: Record<string, unknown>) {
			const warnNotInlined = (filename: string) => {
				if (failOnNotInlined) {
					this.error(`asset not inlined: ${filename}. The in-game loader can only load the single entry file.`)
				} else {
					this.warn(`NOTE: asset not inlined: ${filename}`)
				}
			}

			const files = {
				html: [] as string[],
				css: [] as string[],
				js: [] as string[],
				other: [] as string[],
			}

			for (const i of Object.keys(bundle)) {
				if (isCssFile.test(i)) {
					files.css.push(i)
				} else if (isJsFile.test(i)) {
					files.js.push(i)
				} else {
					files.other.push(i)
				}
			}

			if (files.js.length > 1) {
				this.error(`vite:singlefile expects a single JavaScript chunk, but ${files.js.length} were emitted: ${files.js.join(", ")}`)
			}

			const bundlesToDelete = [] as string[]
			for (const name of files.js) {
				const htmlChunk = bundle[name] as OutputChunk
				let replacedHtml = htmlChunk.code as string
				//for (const filename of files.js) {
				//	if (inlinePattern.length && !micromatch.isMatch(filename, inlinePattern)) {
				//		warnNotInlined(filename)
				//		continue
				//	}
				//	const jsChunk = bundle[filename] as OutputChunk
				//	if (jsChunk.code != null) {
				//		this.info(`Inlining: ${filename}`)
				//		bundlesToDelete.push(filename)
				//		replacedHtml = replaceScript(replacedHtml, jsChunk.fileName, jsChunk.code)
				//	}
				//}
				for (const filename of files.css) {
					if (inlinePattern.length && !micromatch.isMatch(filename, inlinePattern)) {
						warnNotInlined(filename)
						continue
					}
					const cssChunk = bundle[filename] as OutputAsset
					this.info(`Inlining: ${filename}`)
					bundlesToDelete.push(filename)
					replacedHtml = replaceCss(replacedHtml, cssChunk.fileName, cssChunk.source as string)
				}
				htmlChunk.code = replacedHtml
			}
			if (deleteInlinedFiles) {
				for (const name of bundlesToDelete) {
					delete bundle[name]
				}
			}
			for (const name of files.other) {
				warnNotInlined(name)
			}
		},
	}
}