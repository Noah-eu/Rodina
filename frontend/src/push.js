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
    if (perm !== 'granted') return
    const pkRes = await fetch(`${apiBase}/api/push/publicKey`)
    if (!pkRes.ok) return
    const { publicKey } = await pkRes.json()
    const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
    await fetch(`${apiBase}/api/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub, userId }) })
  }catch(e){ /* ignore */ }
}
