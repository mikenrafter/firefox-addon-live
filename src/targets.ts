/**
 * `Target` builders for common Firefox UI. Each one is a function body run in
 * the browser window (see `FirefoxSession.screenRect`).
 */

import type { Target } from './session'

/** The selected tab in the tab strip. */
export const selectedTab: Target = { find: 'return gBrowser.selectedTab' }

/** A bookmarks-toolbar bookmark or folder button, by label. */
export const toolbarItem = (label: string): Target => ({
	find: `return [...document.querySelectorAll('#PlacesToolbarItems > toolbarbutton')].find((item) => item.label === args[0])`,
	args: [label],
})

/**
 * A menu item by (prefix of its) label inside the open popup `popupId`,
 * searching open submenus too. Hidden items are skipped.
 */
export const menuItem = (popupId: string, label: string): Target => ({
	find: `return [...document.getElementById(args[0]).querySelectorAll('menu, menuitem')]
		.find((item) => !item.hidden && item.label?.startsWith(args[1]) && item.closest('menupopup').state === 'open')`,
	args: [popupId, label],
})

/** An element inside an open window-modal dialog (e.g. Edit Bookmark), by id. */
export const dialogField = (id: string): Target => ({
	find: `for (const browser of document.querySelectorAll('.dialogFrame')) {
			const element = browser.contentDocument?.getElementById(args[0])
			if (element) return element
		}
		return null`,
	args: [id],
})

/** The accept or cancel button of an open window-modal dialog. */
export const dialogButton = (type: 'accept' | 'cancel'): Target => ({
	find: `for (const browser of document.querySelectorAll('.dialogFrame')) {
			const button = browser.contentDocument?.querySelector('dialog')?.getButton?.(args[0])
			if (button) return button
		}
		return null`,
	args: [type],
})

/**
 * Id of an add-on's toolbar button (browser action) or address-bar button
 * (page action). Firefox builds both from the add-on id.
 */
export function addonButtonId(addonId: string, kind: 'browserAction' | 'pageAction'): string {
	const widget = addonId.toLowerCase().replace(/[^a-z0-9_-]/g, '_')
	return kind === 'pageAction' ? `pageAction-urlbar-${widget}` : `${widget}-browser-action`
}
