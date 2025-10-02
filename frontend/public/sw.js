self.addEventListener('push', function(event) {
  const data = event.data ? event.data.text() : 'Nové oznámení'
  event.waitUntil(self.registration.showNotification('FamCall', { body: data }))
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(clients.openWindow('/'))
});
