self.addEventListener('push', function(event) {
  let title = 'Rodina'
  let body = 'Nové oznámení'
  try{
    if(event.data){
      const txt = event.data.text()
      try{
        const json = JSON.parse(txt)
        title = json.title || title
        body = json.body || body
      }catch(_){ body = txt || body }
    }
  }catch(_){ }
  event.waitUntil(self.registration.showNotification(title, { body }))
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(clients.openWindow('/'))
});
