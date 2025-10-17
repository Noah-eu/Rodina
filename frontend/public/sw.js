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
  // Pro hovory připrav delší vibrační pattern (Android)
  let vibe = undefined
  if (data.type === 'call') {
    try {
      const seq = []
      for (let i=0;i<20;i++) { seq.push(250, 180) } // ~8.6s vibrací
      vibe = seq
    } catch(_) { vibe = [150,100,150,100,150] }
  }
  const opts = {
    body,
    tag: data.type === 'call' ? `call-${data.from || ''}` : undefined,
    renotify: data.type === 'call',
    requireInteraction: data.type === 'call',
    vibrate: vibe,
    icon: '/assets/default-avatar.png',
    actions: data.type === 'call' ? [
      { action: 'accept', title: 'Přijmout' },
      { action: 'decline', title: 'Odmítnout' }
    ] : undefined,
    data
  }
  event.waitUntil((async () => {
    await self.registration.showNotification(title, opts)
    // Experimentální: zkusit otevřít okno s appkou pro rychlé přijetí (některé prohlížeče blokují bez interakce)
    try {
      if (data.type === 'call') {
        const all = await clients.matchAll({ type: 'window', includeUncontrolled: true })
        const hasVisible = all && all.length
        if (!hasVisible) {
          const params = new URLSearchParams()
          params.set('notify', '1')
          params.set('ntype', data.type)
          if (data.from) params.set('from', data.from)
          if (data.fromName) params.set('fromName', data.fromName)
          if (data.kind) params.set('kind', data.kind)
          if (data.ts) params.set('ts', String(data.ts))
          params.set('autopopup', '1')
          await clients.openWindow('/?' + params.toString())
        }
      }
    } catch(_) {}
  })())
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  const d = (event.notification && event.notification.data) || {}
  // Otevřít aplikaci; pokud neexistuje okno, přenes data přes query parametry
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = all.find(c => 'focus' in c)
    if (win) {
      await win.focus()
      // Akce notifikace: accept/decline
      if (event.action === 'accept') {
        try { win.postMessage({ type: 'sw:notifyAction', action: 'accept', data: d }) } catch(_){ }
      } else if (event.action === 'decline') {
        try { win.postMessage({ type: 'sw:notifyAction', action: 'decline', data: d }) } catch(_){ }
      } else {
        try { win.postMessage({ type: 'sw:notifyClick', data: d }) } catch(_){ }
      }
    } else {
      const params = new URLSearchParams()
      params.set('notify', '1')
      if (d.type) params.set('ntype', d.type)
      if (d.from) params.set('from', d.from)
      if (d.fromName) params.set('fromName', d.fromName)
      if (d.kind) params.set('kind', d.kind)
      if (d.ts) params.set('ts', String(d.ts))
      const url = '/?' + params.toString()
      await clients.openWindow(url)
    }
  })())
});
