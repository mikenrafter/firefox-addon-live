browser.menus.create({ id: 'fixture-link', title: 'Fixture: remember link', contexts: ['link'] })
browser.menus.onClicked.addListener((info) => browser.storage.local.set({ link: info.linkUrl }))
browser.browserAction.onClicked.addListener((tab) => browser.storage.local.set({ clicked: tab.url }))
