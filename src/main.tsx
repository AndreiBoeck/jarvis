import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { IS_APP, readLink } from './config'
import { Pairing } from './ui/Mobile'

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
//
// The Android app pairs with the bridge first; until it has, there is nothing
// for the interface to talk to, so the pairing screen stands in for all of it.
if (IS_APP) document.documentElement.classList.add('is-app')
createRoot(document.getElementById('root')!).render(
  IS_APP && !readLink() ? <Pairing /> : <App />,
)
