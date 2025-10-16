self.addEventListener('push', function(event) {
  let payload = {}
  let title = 'Rodina'
  let body = 'Nové oznámení'
  try{
    if(event.data){
      const txt = event.data.text()
      try{ payload = JSON.parse(txt) }catch(_){ payload = { body: txt } }
      title = payload.title || title
      body = payload.body || body
    }
  }catch(_){ }
  const data = {
    type: payload.type || 'message',
    from: payload.from || null,
    fromName: payload.fromName || '',
    kind: payload.kind || 'audio',
    ts: payload.ts || Date.now()
  }
  const opts = {
    body,
    tag: data.type === 'call' ? `call-${data.from || ''}` : undefined,
    renotify: data.type === 'call',
    vibrate: data.type === 'call' ? [150, 100, 150, 100, 150] : undefined,
    data
  }
  event.waitUntil(self.registration.showNotification(title, opts))
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  const d = event.notification && event.notification.data || {}
  // Otevřít aplikaci a případně přesměrovat na volajícího
  const url = '/'
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = all.find(c => 'focus' in c)
    if (win) {
      await win.focus()
      // volitelně můžeme poslat zprávu do otevřené stránky o příchozím hovoru
      try { win.postMessage({ type: 'sw:notifyClick', data: d }) } catch(_){}
    } else {
      await clients.openWindow(url)
    }
  })())
});
