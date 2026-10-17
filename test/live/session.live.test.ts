/**
 * End-to-end check of the harness against a tiny fixture add-on: install,
 * real clicks on chrome and page elements, extension storage, captures.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FirefoxSession, addonButtonId, menuItem, openAddonPreferences, settle } from '../../src/index'

const ADDON_ID = 'fixture@firefox-addon-live'
let session: FirefoxSession
let out: string
let upstream: Server

const stored = (key: string) => session.asExtension('return (await browser.storage.local.get(args[0]))[args[0]] ?? null', [key])

beforeAll(async () => {
	out = await mkdtemp(join(tmpdir(), 'firefox-addon-live-test-'))
	upstream = createServer((request, response) => {
		response.writeHead(200, { 'content-type': 'text/html' })
		response.end(`<title>Upstream</title><p id="seen">${request.headers.host} ${request.url}</p>`)
	})
	await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', () => done()))
	const port = (upstream.address() as { port: number }).port
	session = await FirefoxSession.start({
		width: 800,
		height: 562,
		addon: { source: resolve(import.meta.dirname, '../fixture-addon'), id: ADDON_ID },
		upstreams: { 'real.example': `http://127.0.0.1:${port}` },
		pages: { 'links.example': { title: 'Links', body: '<h1>Links</h1><p><a id="target" href="http://docs.example/page">Docs</a></p>' } },
	})
}, 90_000)

afterAll(async () => {
	await session?.close()
	upstream?.close()
	await rm(out, { recursive: true, force: true })
})

describe('FirefoxSession', () => {
	it('installs the add-on and runs code with its privileges', async () => {
		expect(session.addonId).toBe(ADDON_ID)
		expect(session.extensionOrigin).toMatch(/^moz-extension:\/\//)
		await session.asExtension('await browser.storage.local.set({ seeded: args[0] }); return true', ['yes'])
		expect(await stored('seeded')).toBe('yes')
	})

	it('runs extension code without changing the visible tabs', async () => {
		await session.openTab('http://links.example/')
		await settle(session)
		const tabs = () => session.chrome('return [gBrowser.visibleTabs.length, gBrowser.selectedTab.linkedBrowser.currentURI.spec]')
		const before = await tabs()
		await session.asExtension('return true')
		expect(await tabs()).toEqual(before)
	})

	it('creates and reuses containers', async () => {
		const work = await session.ensureContainer('Live Work', 'orange', 'briefcase')
		expect(work).toBeGreaterThan(0)
		expect(await session.ensureContainer('Live Work')).toBe(work)
		await session.openTab('http://links.example/', work)
		expect(await session.chrome('return gBrowser.selectedBrowser.getAttribute("usercontextid")')).toBe(String(work))
	})

	it('clicks the browser action with the real pointer', async () => {
		await session.openTab('http://links.example/')
		await settle(session)
		await session.realClick(addonButtonId(ADDON_ID, 'browserAction'))
		await expect.poll(() => stored('clicked')).toBe('http://links.example/')
	})

	it('right-clicks a link in the page and picks the add-on menu item', async () => {
		await session.openTab('http://links.example/')
		await session.realClick({ content: '#target' }, { button: 3 })
		await session.waitForPopup('contentAreaContextMenu')
		await session.realClick(menuItem('contentAreaContextMenu', 'Fixture: remember link'))
		await expect.poll(() => stored('link')).toBe('http://docs.example/page')
	})

	it('clicks inside the inline options page in about:addons', async () => {
		await openAddonPreferences(session)
		await session.realClick({ inlineOptions: '#flag' })
		await expect.poll(() => stored('flag')).toBe(true)
	})

	it('forwards upstream hosts to a real server', async () => {
		await session.openTab('http://real.example/path?q=1')
		expect(await session.content("return document.getElementById('seen').textContent")).toBe('real.example /path?q=1')
	})

	it('writes scaled stills and GIFs of the display', async () => {
		const png = join(out, 'still.png')
		const gif = join(out, 'clip.gif')
		await session.screenshot(png, { x: 0, y: 0, width: 800, height: 562 }, 640)
		const stop = await session.record(gif, { x: 0, y: 0, width: 800, height: 562 }, { width: 320 })
		await session.pointerToPoint(100, 100, 12)
		await stop()
		expect((await stat(png)).size).toBeGreaterThan(1_000)
		expect((await stat(gif)).size).toBeGreaterThan(1_000)
	})
})
