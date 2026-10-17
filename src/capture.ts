/**
 * Runs README capture scenes: each scene drives a live Firefox (see
 * `FirefoxSession`) and writes a PNG still and/or a GIF of what it did.
 *
 *   await runCaptures({
 *     outDir: 'product-page',
 *     session: { addon: { source: 'src' }, pages: { 'mail.example': … } },
 *     scenes: {
 *       reopen: {
 *         async run(session, kit) {
 *           await session.openTab('http://mail.example/')
 *           await settle(session)
 *           const stop = await kit.record('usage-reopen')
 *           …
 *           await stop()
 *         },
 *       },
 *     },
 *   })
 *
 * A scene opens its page, calls `settle()` (one tab, no menus, pointer
 * parked), then records. Scenes with the same frame share one Firefox and run
 * in declaration order.
 * A scene with its own `frame` (say, a taller settings page) gets its own
 * Firefox sized to it. Pass scene names on the command line to run only those.
 */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { FirefoxSession, waitFor, type FirefoxSessionOptions, type Rect } from './session'

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/**
 * Firefox folds page actions into the "…" menu below ~700px wide, so the
 * default is an 800×562 window scaled down to 640×450.
 */
export const DEFAULT_FRAME = { width: 800, height: 562 }
export const DEFAULT_OUTPUT_WIDTH = 640
/** xdotool steps per pointer glide; 24 × 16ms reads as a deliberate move. */
export const GLIDE = 24

export interface CaptureKit {
	/** The captured region: the whole window. */
	readonly frame: Rect
	/** Absolute path for `name` in the output directory. */
	out(name: string): string
	/** Saves `<name>.png` of the frame, scaled to the output width. */
	still(name: string): Promise<void>
	/** Starts recording `<name>.gif`; await the returned function to stop and encode. */
	record(name: string): Promise<() => Promise<void>>
}

export interface Scene {
	run(session: FirefoxSession, kit: CaptureKit): Promise<void>
	/** Window size for this scene. Scenes with another size get their own Firefox. */
	frame?: { width: number, height: number }
	/** Output width in px (default 640). */
	outputWidth?: number
	/** Scenes that must run first in the same Firefox (e.g. one that sets up state). */
	requires?: string[]
}

export interface CaptureOptions {
	scenes: Record<string, Scene>
	/** Where PNGs and GIFs go. `OUT_DIR` in the environment overrides it. */
	outDir: string
	/** Session options shared by every scene (width/height come from the frame). */
	session?: Omit<FirefoxSessionOptions, 'width' | 'height'>
	/** Runs once per Firefox, before its scenes (seed bookmarks, containers, …). */
	setup?: (session: FirefoxSession) => Promise<void>
	/** Runs before each scene. Scenes usually call `settle()` once their page is open. */
	beforeEach?: (session: FirefoxSession) => Promise<void>
	/** Scene names to run (default: the command-line arguments, else all). */
	only?: string[]
}

export async function runCaptures(options: CaptureOptions): Promise<void> {
	const outDir = resolve(process.env.OUT_DIR ?? options.outDir)
	const names = Object.keys(options.scenes)
	const requested = options.only ?? process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
	const unknown = requested.filter((name) => !(name in options.scenes))
	if (unknown.length > 0) throw new Error(`Unknown scene(s): ${unknown.join(', ')}. Known: ${names.join(', ')}`)

	const wanted = new Set<string>()
	const want = (name: string) => {
		if (wanted.has(name)) return
		wanted.add(name)
		for (const dependency of options.scenes[name]?.requires ?? []) want(dependency)
	}
	for (const name of requested.length > 0 ? requested : names) want(name)

	// One Firefox per distinct frame, scenes in declaration order.
	const groups = new Map<string, string[]>()
	for (const name of names.filter((name) => wanted.has(name))) {
		const frame = options.scenes[name]!.frame ?? DEFAULT_FRAME
		const key = `${frame.width}x${frame.height}`
		groups.set(key, [...groups.get(key) ?? [], name])
	}

	await mkdir(outDir, { recursive: true })
	for (const [, group] of groups) {
		const frameSize = options.scenes[group[0]!]!.frame ?? DEFAULT_FRAME
		const frame: Rect = { x: 0, y: 0, ...frameSize }
		const session = await FirefoxSession.start({ ...options.session, ...frameSize })
		try {
			await options.setup?.(session)
			for (const name of group) {
				const scene = options.scenes[name]!
				console.error(`capturing ${name}…`)
				await options.beforeEach?.(session)
				await scene.run(session, captureKit(session, outDir, frame, scene.outputWidth ?? DEFAULT_OUTPUT_WIDTH))
				await session.closeOtherTabs()
			}
		} finally {
			await session.close()
		}
	}
	console.error(`wrote ${wanted.size} scene(s) to ${outDir}`)
}

function captureKit(session: FirefoxSession, outDir: string, frame: Rect, width: number): CaptureKit {
	const out = (name: string) => resolve(outDir, name)
	return {
		frame,
		out,
		still: (name) => session.screenshot(out(`${name}.png`), frame, width),
		record: (name) => session.record(out(`${name}.gif`), frame, { width }),
	}
}

/**
 * Leaves a clean window for the next scene: one tab, no open menus, no
 * Marionette "remote control" striping, pointer parked over the page.
 */
export async function settle(session: FirefoxSession, park: { x: number, y: number } = { x: 420, y: 300 }): Promise<void> {
	await session.closeOtherTabs()
	await session.chrome(`
		document.documentElement.removeAttribute('remotecontrol')
		for (const popup of document.querySelectorAll('menupopup, panel')) {
			if (popup.state === 'open') popup.hidePopup()
		}
		return true`)
	await session.pointerToPoint(park.x, park.y)
	await sleep(500)
}

/**
 * Opens the add-on's options page in about:addons (as users reach it) and
 * waits for the inline options to load.
 */
export async function openAddonPreferences(session: FirefoxSession): Promise<void> {
	if (!session.addonId) throw new Error('No add-on is installed')
	await session.chrome(`BrowserAddonUI.openAddonsMgr('addons://detail/' + encodeURIComponent(arguments[0]) + '/preferences'); return true`, [session.addonId])
	await waitFor(async () => await session.chrome(`
		const browser = gBrowser.selectedBrowser.contentDocument?.querySelector('browser.addon-inline-options')
		return browser && browser.getBoundingClientRect().height > 100 ? true : null`) ?? undefined, 10_000, 'Inline options never loaded')
	// Drop the focus ring about:addons leaves on the card's "…" button.
	await session.chrome('gBrowser.selectedBrowser.contentDocument.activeElement?.blur(); return true')
	// The inline browser grows to fit its page after the first layout.
	await sleep(600)
}
