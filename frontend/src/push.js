// Inicializace push notifikací: vyžádá oprávnění, získá VAPID public key a přihlásí subscription na backend
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
  return outputArray
}

export async function initPush(swReg, apiBase='', userId=null){
  if (!('PushManager' in window)) return
  try{
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') { console.warn('[push] Permission not granted'); return }
    const base = (apiBase || '').replace(/\/$/, '')
    let pkRes = await fetch(`${base}/push/publicKey`).catch(()=>null)
    if (!pkRes || !pkRes.ok) {
      console.warn('[push] publicKey via proxy failed')
      // optional: try direct backend if configured
      const direct = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '') + '/api'
      if (direct) {
        pkRes = await fetch(`${direct}/push/publicKey`).catch(()=>null)
      }
    }
    if (!pkRes || !pkRes.ok) { console.warn('[push] No publicKey endpoint reachable'); return }
    const { publicKey } = await pkRes.json()
    const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
    let subRes = await fetch(`${base}/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub, userId }) }).catch(()=>null)
    if (!subRes || !subRes.ok) {
      const direct = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '') + '/api'
      if (direct) {
        subRes = await fetch(`${direct}/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub, userId }) }).catch(()=>null)
      }
    }
    if (!subRes || !subRes.ok) console.warn('[push] Subscribe failed')
  }catch(e){ /* ignore */ }
}
