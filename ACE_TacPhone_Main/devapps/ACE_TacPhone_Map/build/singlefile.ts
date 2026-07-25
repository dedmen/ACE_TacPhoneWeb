import { type UserConfig, type PluginOption, version as viteVersion } from "vite"
import type { OutputChunk, OutputAsset, OutputOptions } from "rollup"
import micromatch from "micromatch"

export type Config = {
	// Modifies the Vite build config to make this plugin work well. See `_useRecommendedBuildConfig`
	// in the plugin implementation for more details on how this works.

	//
	// @default true
	useRecommendedBuildConfig?: boolean
	// Remove the unused Vite module loader. Safe to do since all JS is inlined by this plugin.
	//
	// @default false
	removeViteModuleLoader?: boolean
	// Optionally, only inline assets that match one or more glob patterns.
	//
	// @default []
	inlinePattern?: string[]
	// Optionally, delete inlined assets preventing them from being output.
	//
	// @default true
	deleteInlinedFiles?: boolean
	// If you need to override anything specific in the recommended build config, pass a sparse
	// object here. For example, use `{ base: "/" }` to override the default "./" base path for
	// non-inlined public files.
	overrideConfig?: Partial<UserConfig>
}

const defaultConfig = { useRecommendedBuildConfig: true, removeViteModuleLoader: false, deleteInlinedFiles: true }

export function replaceCss(jsContent: string, scriptFilename: string, scriptCode: string): string {

    // https://web.dev/articles/css-module-scripts#dynamically_imported_stylesheets
    // We cannot use import from file, because in Arma we are not running in a browser, so, we convert to a dynamic import, and use the core file loading API to fetch it
    //#TODO we can also choose to embed a data URL?




                debugger;

	const f = scriptFilename.replaceAll(".", "\\.")
	const reStyle = new RegExp(`<link([^>]*?) href="(?:[^"]*?/)?${f}"([^>]*)>`)
	const newCode = scriptCode.replace(`@charset "UTF-8";`, "")
	const inlined = jsContent.replace(reStyle, (_, beforeSrc, afterSrc) => `<style${beforeSrc}${afterSrc}>${newCode.trim()}</style>`)
	return inlined
}

const isJsFile = /\.[mc]?js$/
const isCssFile = /\.css$/
//const isHtmlFile = /\.html?$/

export function viteSingleFile({
	useRecommendedBuildConfig = true,
	inlinePattern = [],
	deleteInlinedFiles = true,
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

		if (!config.build.rollupOptions) config.build.rollupOptions = {}
		if (!config.build.rollupOptions.output) config.build.rollupOptions.output = {}

		const viteMajor = parseInt(viteVersion.split(".")[0], 10)
		const updateOutputOptions = (out: OutputOptions) => {
			// Ensure that as many resources as possible are inlined.
			// Vite 8+ (Rolldown) uses codeSplitting:false; earlier versions use inlineDynamicImports:true
			if (viteMajor >= 8) {
				;(out as OutputOptions & { codeSplitting: boolean }).codeSplitting = false
			} else {
				out.inlineDynamicImports = true
			}
		}

		if (Array.isArray(config.build.rollupOptions.output)) {
			for (const o of config.build.rollupOptions.output) updateOutputOptions(o as OutputOptions)
		} else {
			updateOutputOptions(config.build.rollupOptions.output as OutputOptions)
		}

		Object.assign(config, overrideConfig)
	}

	return {
		name: "vite:singlefile",
		config: useRecommendedBuildConfig ? _useRecommendedBuildConfig : undefined,
		enforce: "post",
		generateBundle(_options: unknown, bundle: Record<string, unknown>) {
			const warnNotInlined = (filename: string) => this.info(`NOTE: asset not inlined: ${filename}`)
			this.info("\n")
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

            //#TODO there should only be one .js file, if we have multiple we need to convert all their imports into dynamic...

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
				//		replacedHtml = replaceScript(replacedHtml, jsChunk.fileName, jsChunk.code, removeViteModuleLoader)
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