/** Fixture pages for `FirefoxSessionOptions.pages`. */

import type { FixturePage } from './session'

/** A plain "Sign in to <product>" page, for scenes that need a believable site. */
export function signInPage(product: string, accent: string): FixturePage {
	return {
		title: `${product}: Sign-in`,
		body: `
<style>
	body { padding: 24px 32px; }
	header { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 18px; }
	header i { width: 26px; height: 22px; border-radius: 5px; background: ${accent}; display: inline-block; }
	main { margin: 40px auto 0; max-width: 260px; background: white; border-radius: 14px; padding: 28px; box-shadow: 0 2px 12px #0001; }
	h1 { margin: 0 0 6px; font-size: 22px; }
	p { margin: 0 0 18px; color: #555; font-size: 13px; }
	label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
	input { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #ccc; border-radius: 8px; }
	button { margin-top: 18px; width: 100%; padding: 10px; border: 0; border-radius: 8px; background: ${accent}; color: white; font-size: 14px; }
</style>
<header><i></i>${product}</header>
<main>
	<h1>Sign in</h1>
	<p>To continue to ${product}</p>
	<label>Email or username</label><input>
	<label>Password</label><input type="password">
	<button>Sign in</button>
</main>`,
	}
}
