import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { initPush } from './push'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// register service worker for push notifications (requires HTTPS / deployed site)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(async (reg)=>{
      console.log('SW registered')
  // Build API base: in PROD it's "/api" (Netlify redirect → proxy), in DEV append "/api" to backend origin
  const devBase = (import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '') + '/api'
  const apiBase = import.meta.env.PROD ? '/api' : devBase
      try {
        const u = JSON.parse(localStorage.getItem('rodina:user') || 'null')
        await initPush(reg, apiBase, u?.id || null)
      } catch (_) {
        await initPush(reg, apiBase, null)
      }
    })
    .catch(()=>{})
}
