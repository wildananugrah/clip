import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Before render: attaches the live listeners for the device theme and other tabs.
import './lib/theme'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
