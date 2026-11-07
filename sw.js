// Homebase service worker: shows notifications and opens the right page when you tap one.
// It doesn't cache anything; the app always loads fresh from the web.

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Homebase', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { go: d.go || 'today' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var go = (e.notification.data && e.notification.data.go) || 'today';
  var url = new URL('./#go=' + go, self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.registration.scope) === 0) {
        list[i].postMessage({ go: go });
        return list[i].focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
