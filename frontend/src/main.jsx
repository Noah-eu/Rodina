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
      await initPush(reg, '')
    })
    .catch(()=>{})
}
