/**
 * The only door between the page and the Windows app. Deliberately tiny: the
 * page can hear mute requests from the tray and report its mute state back,
 * and nothing else — no Node, no IPC of its own choosing.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jarvisDesktop', {
  onMute(cb) {
    ipcRenderer.on('jarvis:mute', (_e, on) => cb(on === true ? true : on === false ? false : null))
  },
  reportMuted(on) {
    ipcRenderer.send('jarvis:muted', Boolean(on))
  },
})
