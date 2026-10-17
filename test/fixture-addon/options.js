document.getElementById('flag').addEventListener('change', (event) => browser.storage.local.set({ flag: event.target.checked }))
