# firefox-addon-live

Drive a throwaway Firefox with your add-on loaded, from TypeScript. Use it for live tests that click real browser UI, and for regenerating README screenshots and GIFs.

- Runs vanilla Firefox (from nixpkgs) on a private Xvfb display, so menus, panels and popups render for real and nothing touches your desktop.
- Clicks with the real X pointer (`xdotool`), so context menus, page actions and toolbar buttons behave as they do for users.
- Serves fixture pages for any `http://` hostname through a local proxy (`http://mail.example/`), so no network is needed. `upstreams` sends chosen hostnames to a real local server instead.
- Records PNG stills and looping GIFs (ffmpeg, two-pass palette) of exactly what happened.
- Profile, add-on copy and X server are temporary and removed on `close()`.

It speaks Marionette (Firefox's remote protocol) directly; there is no Selenium or geckodriver.

Used by [ContainMarks](https://gitlab.com/mikenrafter/containMarks), [Permanent Container Tabs](https://gitlab.com/mikenrafter/permanent-container-tabs), [Get Clone](https://gitlab.com/mikenrafter/get-clone) and [Anubis Fast](https://gitlab.com/mikenrafter/anubis-fast).

## Setup

Add the flake input and use its dev shell:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    firefox-addon-live = {
      url = "github:mikenrafter/firefox-addon-live";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, flake-utils, firefox-addon-live }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = firefox-addon-live.lib.devShell {
          inherit pkgs;
          packages = [ ];    # anything else your project needs
          shellHook = "";    # appended to the library's hook
        };
      });
}
```

The shell provides Node 22, Firefox (`FIREFOX_BINARY`), Xvfb, ffmpeg, ImageMagick and xdotool. It also links this library into your repo as `.firefox-addon-live`. Depend on that link in `package.json`, and gitignore it:

```json
"devDependencies": {
  "firefox-addon-live": "file:.firefox-addon-live",
  "tsx": "^4.23.15"
}
```

The flake lock decides which version you get; `nix flake update firefox-addon-live` moves it. The package ships TypeScript source, which Vitest and `tsx` run directly.

If you build your own shell, `firefox-addon-live.lib.tools pkgs` is the package list and `firefox-addon-live.lib.shellHook pkgs` is the hook.

## Live tests

```ts
import { FirefoxSession, menuItem } from 'firefox-addon-live'

const session = await FirefoxSession.start({
  addon: { source: 'src', id: 'my-addon@example' },  // unpacked, already built
  pages: { 'docs.example': { title: 'Docs', body: '<a id="link" href="http://docs.example/a">A</a>' } },
})

await session.openTab('http://docs.example/', await session.ensureContainer('Work'))
await session.realClick({ content: '#link' }, { button: 3 })        // right-click a page element
await session.waitForPopup('contentAreaContextMenu')
await session.realClick(menuItem('contentAreaContextMenu', 'Open in container'))

const saved = await session.asExtension('return browser.storage.local.get()')  // runs as the add-on
await session.close()
```

Run live tests in their own Vitest config with `fileParallelism: false` and generous timeouts (see `vitest.live.config.ts`).

### Pointing at things

`realClick`, `pointerTo` and `screenRect` take a `Target`:

| Target | Means |
| --- | --- |
| `'urlbar-input'` | chrome element by id |
| `'#nav-bar > toolbarbutton'` | chrome element by CSS selector (starts with a symbol) |
| `{ find: 'return gBrowser.selectedTab' }` | function body run in the browser window; `args` is passed through |
| `{ content: 'a#link' }` | element in the selected tab's page |
| `{ inlineOptions: '#save' }` | element in the add-on's options page inside about:addons |

Builders for common UI: `selectedTab`, `toolbarItem(label)`, `menuItem(popupId, label)`, `dialogField(id)`, `dialogButton('accept')`, `addonButtonId(addonId, 'browserAction' | 'pageAction')`.

The add-on's toolbar button is pinned to the toolbar on install (pass `pinToToolbar: false` to leave it in the extensions panel).

### Running code

- `chrome(script, args)` / `chromeAsync(body, args)`: browser-window privileges (`gBrowser`, `PlacesUtils`, …).
- `content(script, args)`: the selected tab's page.
- `asExtension(body, args)`: inside a hidden page of your add-on, with its `browser.*` API. Nothing changes on screen, so it is safe mid-recording.

## README captures

```ts
import { GLIDE, runCaptures, settle, signInPage } from 'firefox-addon-live'

await runCaptures({
  outDir: 'product-page',
  session: { addon: { source: 'src' }, pages: { 'mail.example': signInPage('Mail', '#6d4aff') } },
  scenes: {
    reopen: {
      async run(session, kit) {
        await session.openTab('http://mail.example/')
        await settle(session)                       // one tab, no menus, pointer parked
        const stop = await kit.record('usage-reopen')
        await session.realClick({ content: 'h1' }, { button: 3, glide: GLIDE })
        await kit.still('usage-reopen')             // usage-reopen.png
        await stop()                                // usage-reopen.gif
      },
    },
    settings: {
      frame: { width: 800, height: 1000 },          // taller scenes get their own Firefox
      async run(session, kit) { /* … */ },
    },
  },
})
```

Run it with `tsx scripts/capture-readme-assets.ts [scene …]`; `OUT_DIR` overrides the output directory. The default frame is an 800×562 window scaled to 640 px wide: below about 700 px Firefox folds page actions into a menu.

## Developing

```bash
nix develop -c npm install
nix develop -c npm test            # Marionette protocol unit tests
nix develop -c npm run test:live   # the harness against a fixture add-on
```

## License

MIT
