/**
 * A disposable vanilla Firefox driven over Marionette, with your add-on loaded
 * as a temporary add-on.
 *
 * - Runs headed on a private Xvfb display (or `--headless` when `display: false`),
 *   so native panels, real X pointer input (xdotool), screenshots and
 *   recordings all work without touching the user's desktop.
 * - Every `http://` request is answered by a local fixture server acting as the
 *   HTTP proxy, so pages can use realistic hostnames (`http://mail.example/`).
 * - The profile lives in a temp directory and is deleted on `close()`.
 *
 * Needs the flake's dev shell (Firefox, Xvfb, ImageMagick, ffmpeg, xdotool), or set
 * FIREFOX_BINARY and put those tools on PATH.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { MarionetteClient, type ElementReference } from './marionette'

const execFileAsync = promisify(execFile)
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/** Blank page added to the temporary copy of the add-on, for `asExtension()`. */
const PROBE_PAGE = '__firefox-addon-live-probe.html'

export interface AddonOptions {
	/** Unpacked add-on directory (the one with manifest.json). Build it first. */
	source: string
	/** Expected add-on id; `start()` fails if the manifest gives another. */
	id?: string
	/**
	 * Move the add-on's toolbar button out of the extensions (puzzle-piece)
	 * panel onto the toolbar, as a user who pinned it would have (default true).
	 */
	pinToToolbar?: boolean
}

export interface FixturePage {
	title: string
	/** Body HTML. Defaults to a heading with the title. */
	body?: string
}

export interface FirefoxSessionOptions {
	/** Run headed on a private Xvfb display (default). `false` uses `--headless`. */
	display?: boolean
	width?: number
	height?: number
	/** Dark UI (compact dark theme; default true). */
	dark?: boolean
	/** Show the bookmarks toolbar (default true). */
	bookmarksToolbar?: boolean
	/** Pages served for `http://<host><path>`, keyed by `host` or `host/path`. */
	pages?: Record<string, FixturePage>
	/**
	 * Hosts whose requests go to a real local server instead of a fixture page,
	 * e.g. `{ 'docs.example': 'http://127.0.0.1:8923' }`. Method, path, headers
	 * (including Host) and body are forwarded as-is.
	 */
	upstreams?: Record<string, string>
	/** Extra prefs written to user.js. */
	prefs?: Record<string, string | number | boolean>
	/** The add-on under test. Omit to run a plain Firefox. */
	addon?: AddonOptions
	/** Extra add-ons (unpacked directories or .xpi files) installed after `addon`. */
	extraAddons?: string[]
}

export interface Rect { x: number, y: number, width: number, height: number }

/**
 * An element on screen:
 * - a chrome element id, or a CSS selector when it starts with a symbol;
 * - `{ find }`: a function body run in the browser window that returns the element;
 * - `{ content }`: a CSS selector in the selected tab's page;
 * - `{ inlineOptions }`: a CSS selector in the add-on's options page, as shown
 *   inline in the selected about:addons tab.
 */
export type Target = string | { find: string, args?: unknown[] } | { content: string } | { inlineOptions: string }

export class FirefoxSession {
	readonly client: MarionetteClient
	/** X display (":N") when headed, undefined when headless. */
	readonly display: string | undefined
	/** Id of the add-on under test, when installed. */
	addonId: string | undefined
	/** `moz-extension://<uuid>` origin of the add-on under test, when installed. */
	extensionOrigin: string | undefined

	private constructor(
		client: MarionetteClient,
		display: string | undefined,
		private readonly cleanup: () => Promise<void>,
	) {
		this.client = client
		this.display = display
	}

	static async start(options: FirefoxSessionOptions = {}): Promise<FirefoxSession> {
		const binary = process.env.FIREFOX_BINARY ?? 'firefox'
		const width = options.width ?? 1100
		const height = options.height ?? 800
		const disposers: Array<() => Promise<void> | void> = []
		const cleanup = async () => {
			for (const dispose of disposers.reverse()) await Promise.resolve(dispose()).catch(() => undefined)
		}

		try {
			const proxy = await startFixtureProxy(options.pages ?? {}, options.upstreams ?? {})
			disposers.push(() => new Promise<void>((done) => proxy.server.close(() => done())))

			let display: string | undefined
			if (options.display !== false) {
				// Screen == window, so menus flip/clamp to stay inside captures like a maximized window.
				display = await startXvfb(disposers, width, height)
			}

			const profile = await mkdtemp(join(tmpdir(), 'firefox-addon-live-'))
			disposers.push(() => rm(profile, { recursive: true, force: true }))
			await writeFile(join(profile, 'user.js'), userJs({
				...defaultPrefs(options, proxy.port),
				...options.prefs,
			}))

			const args = ['--no-remote', '--profile', profile, '--marionette', '--remote-allow-system-access']
			if (!display) args.push('--headless')
			args.push('about:blank')
			const env = { ...process.env, MOZ_ENABLE_WAYLAND: '0', GDK_BACKEND: 'x11', ...(display ? { DISPLAY: display } : {}) }
			const firefox: ChildProcess = spawn(binary, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
			let exited: string | undefined
			firefox.once('exit', (code, signal) => { exited = `Firefox exited (${signal ?? code}) before Marionette was ready` })
			firefox.once('error', (error) => { exited = `Could not start ${binary}: ${error.message}` })
			disposers.push(() => new Promise<void>((done) => {
				if (firefox.exitCode !== null || firefox.signalCode !== null) return done()
				firefox.once('exit', () => done())
				firefox.kill('SIGTERM')
				setTimeout(() => { firefox.kill('SIGKILL'); done() }, 5_000).unref()
			}))

			const port = await waitFor(async () => {
				if (exited) throw new Error(exited)
				const text = await readFile(join(profile, 'MarionetteActivePort'), 'utf8').catch(() => '')
				return Number(text.trim()) || undefined
			}, 40_000, 'Marionette never wrote MarionetteActivePort')

			const client = await MarionetteClient.connect({ port, timeoutMs: 30_000 })
			disposers.push(() => client.close())
			await client.createSession()

			const session = new FirefoxSession(client, display, cleanup)
			await client.setContext('chrome')
			await client.setWindowRect({ x: 0, y: 0, width, height })
			await session.chrome(`
				// Wait for the first window to finish restoring so later UI pokes are stable.
				return true`)
			if (options.addon) await session.installTestedAddon(options.addon, disposers)
			for (const extra of options.extraAddons ?? []) await client.installAddon(resolve(extra), true)
			return session
		} catch (error) {
			await cleanup()
			throw error
		}
	}

	/**
	 * Loads a copy of `addon.source` (plus a blank probe page for `asExtension()`)
	 * as a temporary add-on and records its moz-extension origin.
	 */
	private async installTestedAddon(addon: AddonOptions, disposers: Array<() => Promise<void> | void>): Promise<void> {
		const copy = await mkdtemp(join(tmpdir(), 'firefox-addon-live-src-'))
		disposers.push(() => rm(copy, { recursive: true, force: true }))
		await cp(resolve(addon.source), copy, { recursive: true, dereference: true })
		await writeFile(join(copy, PROBE_PAGE), '<!doctype html><meta charset="utf-8"><title>probe</title>\n')
		const id = await this.client.installAddon(copy, true)
		if (addon.id && id !== addon.id) throw new Error(`Installed unexpected add-on id ${id} (expected ${addon.id})`)
		const host = await waitFor(async () => await this.chrome(
			'return WebExtensionPolicy.getByID(arguments[0])?.mozExtensionHostname ?? null', [id],
		) as string | null ?? undefined, 10_000, `${id} never registered`)
		this.addonId = id
		this.extensionOrigin = `moz-extension://${host}`
		// Give the background script time to run its startup work.
		await sleep(1_000)
		if (addon.pinToToolbar !== false) await this.pinToToolbar(id)
	}

	/** Moves an add-on's browser-action button onto the toolbar, if it has one. */
	async pinToToolbar(addonId: string): Promise<void> {
		await this.chrome(`
			const widget = arguments[0].toLowerCase().replace(/[^a-z0-9_-]/g, '_') + '-browser-action'
			if (!CustomizableUI.getPlacementOfWidget(widget)) return false
			CustomizableUI.addWidgetToArea(widget, CustomizableUI.AREA_NAVBAR)
			return true`, [addonId])
	}

	/** Runs `script` in the browser (chrome) context. `arguments[n]` are `args`. */
	async chrome(script: string, args: unknown[] = []): Promise<unknown> {
		await this.client.setContext('chrome')
		return await this.client.executeScript(script, args)
	}

	/** Runs `body` as an async function in the chrome context, so it can `await` (e.g. PlacesUtils). */
	async chromeAsync(body: string, args: unknown[] = []): Promise<unknown> {
		await this.client.setContext('chrome')
		const result = await this.client.executeAsyncScript(`
			const done = arguments[arguments.length - 1]
			const args = [...arguments].slice(0, -1)
			;(async () => { ${body} })().then(
				(value) => done({ ok: true, value }),
				(error) => done({ ok: false, error: String(error?.message ?? error) }),
			)`, args) as { ok: boolean, value?: unknown, error?: string }
		if (!result.ok) throw new Error(result.error)
		return result.value
	}

	/** Runs `script` in the selected tab's page. */
	async content(script: string, args: unknown[] = []): Promise<unknown> {
		await this.attachToSelectedTab()
		return await this.client.executeScript(script, args)
	}

	/**
	 * Runs `body` (an async function body) with the add-on's own privileges:
	 * inside a blank page of the add-on, where `browser` is the WebExtension API
	 * and `args` holds `args`. Useful for seeding storage or probing what the
	 * add-on can and can't do.
	 */
	async asExtension(body: string, args: unknown[] = []): Promise<unknown> {
		if (!this.extensionOrigin) throw new Error('No add-on is installed (pass `addon` to start())')
		// A hidden background tab: nothing changes on screen, so this is safe mid-recording.
		const probeUrl = `${this.extensionOrigin}/${PROBE_PAGE}`
		const handle = await this.chrome(`
			const tab = gBrowser.addTab(arguments[0], {
				triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
				inBackground: true,
			})
			tab.setAttribute('data-firefox-addon-live-probe', 'true')
			gBrowser.hideTab(tab)
			const { NavigableManager } = ChromeUtils.importESModule('chrome://remote/content/shared/NavigableManager.sys.mjs')
			return NavigableManager.getIdForBrowser(tab.linkedBrowser)`, [probeUrl]) as string
		try {
			await this.client.switchToWindow(handle, false)
			await this.client.setContext('content')
			// The tab starts on about:blank, which is already "complete"; wait for the add-on's page.
			await waitFor(async () => await this.client.executeScript(
				'return document.readyState === "complete" && location.href === arguments[0] ? true : null', [probeUrl],
			).catch(() => null) as true | null ?? undefined, 10_000, 'Extension page never loaded')
			// The page's own `browser` global is behind an Xray; waive it and await in page scope.
			return await this.client.executeAsyncScript(`
				const done = arguments[arguments.length - 1]
				const page = window.wrappedJSObject
				const run = new page.Function('args', ${JSON.stringify(`return (async () => { ${body} })()`)})
				run(Cu.cloneInto(arguments[0], page)).then(
					(value) => done({ ok: true, value: JSON.parse(JSON.stringify(value ?? null)) }),
					(error) => done({ ok: false, error: String(error?.message ?? error) }),
				)`, [args], 'system').then((result) => {
				const { ok, value, error } = result as { ok: boolean, value?: unknown, error?: string }
				if (!ok) throw new Error(error)
				return value
			})
		} finally {
			await this.chrome(`
				for (const tab of [...gBrowser.tabs]) {
					if (tab.hasAttribute('data-firefox-addon-live-probe')) gBrowser.removeTab(tab, { animate: false })
				}
				return true`)
		}
	}

	/** Marionette's content context follows its own "current window", not the selected tab. */
	private async attachToSelectedTab(): Promise<void> {
		const handle = await this.chrome(`
			const { NavigableManager } = ChromeUtils.importESModule('chrome://remote/content/shared/NavigableManager.sys.mjs')
			return NavigableManager.getIdForBrowser(gBrowser.selectedBrowser)`) as string
		await this.client.switchToWindow(handle)
		await this.client.setContext('content')
	}

	/**
	 * Opens `url` in a new selected tab, optionally inside a container
	 * (`userContextId`), and waits for it to load.
	 */
	async openTab(url: string, userContextId = 0): Promise<void> {
		await this.chrome(`
			const tab = gBrowser.addTab(arguments[0], {
				userContextId: arguments[1],
				triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
			})
			gBrowser.selectedTab = tab
			return true`, [url, userContextId])
		await waitFor(async () => await this.chrome(`
			const browser = gBrowser.selectedBrowser
			return !browser.webProgress?.isLoadingDocument && browser.currentURI.spec === arguments[0] ? true : null
		`, [url]) as boolean | null ?? undefined, 15_000, `${url} never loaded`)
		await sleep(300)
	}

	/** Closes every tab but the selected one. */
	async closeOtherTabs(): Promise<void> {
		await this.chrome('gBrowser.removeAllTabsBut(gBrowser.selectedTab, { skipWarnAndClose: true, animate: false }); return true')
	}

	/** Creates (or finds) a container by name, returning its userContextId. */
	async ensureContainer(name: string, color = 'blue', icon = 'fingerprint'): Promise<number> {
		return await this.chrome(`
			// The module moved to moz-src:/// in Firefox 154; older builds only have resource://.
			const load = (url) => { try { return ChromeUtils.importESModule(url).ContextualIdentityService } catch { return undefined } }
			const ContextualIdentityService = load('moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs')
				?? load('resource://gre/modules/ContextualIdentityService.sys.mjs')
			// Built-in containers carry an l10nId instead of a name; compare display labels.
			const existing = ContextualIdentityService.getPublicIdentities()
				.find((identity) => ContextualIdentityService.getUserContextLabel(identity.userContextId) === arguments[0])
			return (existing ?? ContextualIdentityService.create(arguments[0], arguments[2], arguments[1])).userContextId
		`, [name, color, icon]) as number
	}

	/** Returns a chrome element by id (or CSS selector, when it starts with a symbol). */
	async chromeElement(selector: string): Promise<ElementReference> {
		const element = await this.chrome(`
			const selector = arguments[0]
			return /^[a-z_]/i.test(selector) ? document.getElementById(selector) : document.querySelector(selector)
		`, [selector])
		if (!element) throw new Error(`No chrome element matches ${selector}`)
		return element as ElementReference
	}

	/**
	 * Screen rectangle of a chrome element in device pixels (for xdotool and
	 * cropping). Handles elements inside open popups and in-window dialogs.
	 */
	async screenRect(target: Target): Promise<Rect> {
		if (typeof target === 'object' && 'content' in target) return await this.contentScreenRect(target.content)
		if (typeof target === 'object' && 'inlineOptions' in target) return await this.inlineOptionsScreenRect(target.inlineOptions)
		// browser.xhtml's CSP forbids eval, so a `find` body is spliced into the script.
		const [selector, find, args] = typeof target === 'string' ? [target, 'return null', []] : [null, target.find, target.args ?? []]
		const rect = await this.chrome(`
			const [selector, args] = arguments
			const element = selector === null
				? ((args) => { ${find} })(args)
				: /^[a-z_]/i.test(selector) ? document.getElementById(selector) : document.querySelector(selector)
			if (!element) return null
			const scale = window.devicePixelRatio
			const box = element.getBoundingClientRect()
			const popup = element.closest?.('menupopup, panel')
			let x, y
			if (element.getOuterScreenRect) {
				const own = element.getOuterScreenRect()
				;[x, y] = [own.x - box.x, own.y - box.y]
			} else if (popup?.getOuterScreenRect) {
				// Items in a popup lay out in its widget; map through the popup's own offset.
				const outer = popup.getOuterScreenRect()
				const inner = popup.getBoundingClientRect()
				;[x, y] = [outer.x - inner.x, outer.y - inner.y]
			} else {
				const view = element.ownerDocument?.defaultView ?? window
				;[x, y] = [view.mozInnerScreenX, view.mozInnerScreenY]
			}
			return { x: (x + box.x) * scale, y: (y + box.y) * scale, width: box.width * scale, height: box.height * scale }
		`, [selector, args]) as Rect | null
		if (!rect) throw new Error(`No chrome element matches ${JSON.stringify(target)}`)
		return rect
	}

	/** Screen rectangle (device px) of an element in the selected tab's page, scrolled into view. */
	private async contentScreenRect(selector: string): Promise<Rect> {
		const box = await this.content(`
			const element = document.querySelector(arguments[0])
			if (!element) return null
			element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
			const { x, y, width, height } = element.getBoundingClientRect()
			return { x, y, width, height }`, [selector]) as Rect | null
		if (!box) throw new Error(`No page element matches ${selector}`)
		return await this.chrome(`
			const [box] = arguments
			const browser = gBrowser.selectedBrowser
			const frame = browser.getBoundingClientRect()
			const zoom = browser.fullZoom ?? 1
			const scale = window.devicePixelRatio
			return {
				x: (window.mozInnerScreenX + frame.x + box.x * zoom) * scale,
				y: (window.mozInnerScreenY + frame.y + box.y * zoom) * scale,
				width: box.width * zoom * scale,
				height: box.height * zoom * scale,
			}`, [box]) as Rect
	}

	/**
	 * Screen rectangle (device px) of an element in the add-on's options page
	 * embedded in about:addons. That page runs in the extension process, out of
	 * chrome's reach, so the element is measured from a sibling extension page.
	 */
	private async inlineOptionsScreenRect(selector: string): Promise<Rect> {
		const box = await this.asExtension(`
			const page = new URL(browser.runtime.getManifest().options_ui?.page ?? '', location.href).pathname
			const inline = browser.extension.getViews().find((view) => view !== window && view.location.pathname === page)
			const element = inline?.document.querySelector(args[0])
			if (!element) return null
			const { x, y, width, height } = element.getBoundingClientRect()
			return { x, y, width, height }`, [selector]) as Rect | null
		if (!box) throw new Error(`No inline options element matches ${selector} (is about:addons showing the add-on's preferences?)`)
		return await this.chrome(`
			const [box] = arguments
			const about = gBrowser.selectedBrowser.contentWindow
			const frame = about.document.querySelector('browser.addon-inline-options').getBoundingClientRect()
			const scale = window.devicePixelRatio
			return { x: (about.mozInnerScreenX + frame.x + box.x) * scale, y: (about.mozInnerScreenY + frame.y + box.y) * scale,
				width: box.width * scale, height: box.height * scale }`, [box]) as Rect
	}

	/** Waits until `target` exists and has a size (hidden elements measure 0×0). */
	async waitForTarget(target: Target, timeoutMs = 5_000): Promise<void> {
		await waitFor(async () => await this.screenRect(target).then(
			(rect) => rect.width > 0 && rect.height > 0 || undefined,
			() => undefined,
		), timeoutMs, `Timed out waiting for ${JSON.stringify(target)}`)
	}

	/** State of a XUL popup/panel, e.g. `editBookmarkPanel` → "open". */
	async popupState(id: string): Promise<string | null> {
		return await this.chrome('return document.getElementById(arguments[0])?.state ?? null', [id]) as string | null
	}

	async waitForPopup(id: string, state = 'open', timeoutMs = 5_000): Promise<void> {
		// Some panels (extension popups) are removed from the DOM on close.
		const matches = (current: string | null) => current === state || (state === 'closed' && current === null)
		await waitFor(async () => matches(await this.popupState(id)) || undefined, timeoutMs, `${id} never became ${state}`)
	}

	// --- Real X input (headed only) ---------------------------------------------

	/** Moves the real X pointer to the centre of an element, gliding when `steps` > 1. */
	async pointerTo(target: Target, steps = 1): Promise<void> {
		const rect = await this.screenRect(target)
		await this.pointerToPoint(rect.x + rect.width / 2, rect.y + rect.height / 2, steps)
	}

	async pointerToPoint(x: number, y: number, steps = 1): Promise<void> {
		const display = this.requireDisplay()
		const from = await this.pointerLocation()
		for (let step = 1; step <= steps; step++) {
			const t = easeInOut(step / steps)
			const px = Math.round(from.x + (x - from.x) * t)
			const py = Math.round(from.y + (y - from.y) * t)
			await execFileAsync('xdotool', ['mousemove', String(px), String(py)], { env: { ...process.env, DISPLAY: display } })
			if (steps > 1) await sleep(16)
		}
	}

	/** Real X click at the pointer's current position (button 1 left, 3 right). */
	async pointerClick(button: 1 | 3 = 1): Promise<void> {
		await execFileAsync('xdotool', ['click', String(button)], { env: { ...process.env, DISPLAY: this.requireDisplay() } })
	}

	/** Real X click on an element. */
	async realClick(target: Target, options: { button?: 1 | 3, glide?: number } = {}): Promise<void> {
		await this.pointerTo(target, options.glide ?? 1)
		await this.pointerClick(options.button ?? 1)
	}

	async keys(...combo: string[]): Promise<void> {
		await execFileAsync('xdotool', ['key', ...combo], { env: { ...process.env, DISPLAY: this.requireDisplay() } })
	}

	async type(text: string): Promise<void> {
		await execFileAsync('xdotool', ['type', '--delay', '40', text], { env: { ...process.env, DISPLAY: this.requireDisplay() } })
	}

	private async pointerLocation(): Promise<{ x: number, y: number }> {
		const { stdout } = await execFileAsync('xdotool', ['getmouselocation', '--shell'], { env: { ...process.env, DISPLAY: this.requireDisplay() } })
		const read = (key: string) => Number(new RegExp(`^${key}=(\\d+)`, 'm').exec(stdout)?.[1] ?? 0)
		return { x: read('X'), y: read('Y') }
	}

	// --- Capture (headed only) --------------------------------------------------

	/**
	 * Screenshot of the X display, including native popups and panels that
	 * Marionette's own screenshot can't see. Crops to `crop` (device px), then
	 * scales to `width` px wide when given.
	 */
	async screenshot(file: string, crop?: Rect, width?: number): Promise<void> {
		const display = this.requireDisplay()
		const root = `${file}.root.png`
		await execFileAsync('import', ['-display', display, '-window', 'root', root])
		const geometry = crop ? ['-crop', `${crop.width}x${crop.height}+${crop.x}+${crop.y}`, '+repage'] : []
		const resize = width ? ['-filter', 'Lanczos', '-resize', `${width}x`] : []
		await execFileAsync('magick', [root, ...geometry, ...resize, file])
		await rm(root, { force: true })
	}

	/**
	 * Starts recording the display region `crop` (device px), with the X pointer
	 * drawn. Returns a function that stops recording and writes a looping GIF,
	 * scaled to `width` px wide when given.
	 */
	async record(file: string, crop: Rect, options: { fps?: number, width?: number } = {}): Promise<() => Promise<void>> {
		const fps = options.fps ?? 15
		const display = this.requireDisplay()
		const video = `${file}.mkv`
		const ffmpeg = spawn('ffmpeg', [
			'-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(fps),
			'-video_size', `${crop.width}x${crop.height}`, '-i', `${display}+${crop.x},${crop.y}`,
			'-c:v', 'libx264rgb', '-crf', '0', '-preset', 'ultrafast', video,
		], { stdio: ['pipe', 'ignore', 'inherit'] })
		const exited = new Promise<number | null>((done) => {
			ffmpeg.once('exit', (code) => done(code))
			ffmpeg.once('error', () => done(-1))
		})
		await sleep(500)
		if (ffmpeg.exitCode !== null) throw new Error(`ffmpeg could not record ${display} (needs x11grab; use nix develop)`)
		return async () => {
			await sleep(400)
			ffmpeg.stdin?.end('q')
			if (await exited !== 0) throw new Error(`ffmpeg failed while recording ${file}`)
			await videoToGif(video, file, fps, options.width)
			await rm(video, { force: true })
		}
	}

	private requireDisplay(): string {
		if (!this.display) throw new Error('This needs a headed session (display: true)')
		return this.display
	}

	async close(): Promise<void> {
		await this.cleanup()
	}
}

/** Two-pass palette GIF: much smaller and cleaner than ffmpeg's default dithering. */
export async function videoToGif(video: string, gif: string, fps = 15, width?: number): Promise<void> {
	const scale = width ? `,scale=${width}:-1:flags=lanczos` : ''
	await execFileAsync('ffmpeg', [
		'-y', '-loglevel', 'error', '-i', video,
		'-vf', `fps=${fps}${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
		'-loop', '0', gif,
	])
}

export async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number, message: string): Promise<T> {
	const deadline = Date.now() + timeoutMs
	let lastError: unknown
	while (Date.now() <= deadline) {
		try {
			const value = await probe()
			if (value !== undefined) return value
		} catch (error) {
			lastError = error
			if (error instanceof Error && /exited|Could not start/.test(error.message)) throw error
		}
		await sleep(100)
	}
	throw new Error(`${message}${lastError ? `: ${String(lastError)}` : ''}`)
}

function easeInOut(t: number): number {
	return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

async function startXvfb(disposers: Array<() => Promise<void> | void>, width: number, height: number): Promise<string> {
	// -displayfd makes Xvfb pick a free display and write its number to fd 3.
	const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', `${width}x${height}x24`, '-dpi', '96', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
	disposers.push(() => new Promise<void>((done) => {
		if (xvfb.exitCode !== null || xvfb.signalCode !== null) return done()
		xvfb.once('exit', () => done())
		xvfb.kill()
	}))
	let output = ''
	xvfb.stdio[3]?.on('data', (chunk: Buffer) => { output += chunk.toString() })
	let failure: string | undefined
	xvfb.once('error', (error) => { failure = `Could not start Xvfb: ${error.message}` })
	xvfb.once('exit', (code) => { failure ??= `Xvfb exited (${code}) before choosing a display` })
	const number = await waitFor(async () => {
		if (failure) throw new Error(failure)
		return /^(\d+)\n/.exec(output)?.[1]
	}, 10_000, 'Xvfb never reported a display')
	return `:${number}`
}

function defaultPrefs(options: FirefoxSessionOptions, proxyPort: number): Record<string, string | number | boolean> {
	return {
		'marionette.port': 0,
		// First-run noise off.
		'browser.aboutwelcome.enabled': false,
		'browser.startup.homepage_override.mstone': 'ignore',
		'browser.shell.checkDefaultBrowser': false,
		'datareporting.policy.dataSubmissionEnabled': false,
		'toolkit.telemetry.reportingpolicy.firstRun': false,
		'browser.tabs.warnOnClose': false,
		'browser.warnOnQuit': false,
		'browser.newtabpage.enabled': false,
		'browser.urlbar.suggest.quicksuggest.sponsored': false,
		'extensions.getAddons.cache.enabled': false,
		'app.update.disabledForTesting': true,
		'browser.translations.automaticallyPopup': false,
		'sidebar.revamp': false,
		// Xvfb's DPI follows its screen size; pin 1 CSS px = 1 device px so crops are exact.
		'layout.css.devPixelsPerPx': '1.0',
		// Lets asExtension() evaluate code inside the add-on's own pages.
		'extensions.webextensions.default-content-security-policy': "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval';",
		// Containers are native; Multi-Account Containers isn't needed.
		'privacy.userContext.enabled': true,
		'privacy.userContext.ui.enabled': true,
		'browser.toolbars.bookmarks.visibility': options.bookmarksToolbar === false ? 'never' : 'always',
		...(options.dark !== false ? {
			'extensions.activeThemeID': 'firefox-compact-dark@mozilla.org',
			'ui.systemUsesDarkTheme': 1,
		} : {}),
		// Route every http:// request to the fixture server.
		'network.proxy.type': 1,
		'network.proxy.http': '127.0.0.1',
		'network.proxy.http_port': proxyPort,
		'network.proxy.no_proxies_on': '',
		'network.proxy.allow_hijacking_localhost': true,
		'security.insecure_connection_text.enabled': false,
		'security.insecure_connection_icon.enabled': false,
		'dom.security.https_first': false,
		'dom.security.https_only_mode': false,
	}
}

function userJs(prefs: Record<string, string | number | boolean>): string {
	return `${Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`).join('\n')}\n`
}

async function startFixtureProxy(pages: Record<string, FixturePage>, upstreams: Record<string, string>): Promise<{ server: Server, port: number }> {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
		const upstream = upstreams[url.host]
		if (upstream) {
			const target = new URL(`${url.pathname}${url.search}`, upstream)
			const forward = httpRequest(target, { method: request.method, headers: request.headers }, (reply) => {
				response.writeHead(reply.statusCode ?? 502, reply.headers)
				reply.pipe(response)
			})
			forward.on('error', (error) => {
				response.writeHead(502, { 'content-type': 'text/plain' })
				response.end(`firefox-addon-live: ${url.host} → ${upstream} failed: ${error.message}`)
			})
			request.pipe(forward)
			return
		}
		const page = pages[`${url.host}${url.pathname}`] ?? pages[url.host]
		const title = escapeHtml(page?.title ?? url.host)
		response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		response.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:48px;background:#f4f1fb;color:#1c1b22}h1{font-weight:600}</style>
<body>${page?.body ?? `<h1>${title}</h1><p>Fixture page for ${escapeHtml(url.href)}</p>`}</body>`)
	})
	await new Promise<void>((done, fail) => {
		server.once('error', fail)
		server.listen(0, '127.0.0.1', () => done())
	})
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Fixture proxy did not bind')
	return { server, port: address.port }
}

function escapeHtml(text: string): string {
	return text.replace(/[<>&"]/g, (character) => `&#${character.charCodeAt(0)};`)
}
