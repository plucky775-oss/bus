function js(value) {
  return JSON.stringify(value || '');
}

export default function handler(req, res) {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || ''
  };

  const source = `
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: ${js(config.apiKey)},
  authDomain: ${js(config.authDomain)},
  projectId: ${js(config.projectId)},
  storageBucket: ${js(config.storageBucket)},
  messagingSenderId: ${js(config.messagingSenderId)},
  appId: ${js(config.appId)}
};

const CACHE = 'hogye-bus-alert-v28';
const CORE = ['/', '/index.html', '/styles.css?v=2.8.0', '/app.js?v=2.8.0', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/assets/future-bus-alert.mp3?v=2.8.0'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).catch(() => undefined));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(hit => hit || caches.match('/index.html'))));
});

if (firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.messagingSenderId && firebaseConfig.appId) {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage(payload => {
    const notification = payload.notification || {};
    const data = payload.data || {};
    self.registration.showNotification(notification.title || data.title || '우리 버스 알림', {
      body: notification.body || data.body || '버스가 곧 도착합니다.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'bus-alert',
      requireInteraction: true,
      silent: data.alertMode === 'pushOnly',
      vibrate: ['push', 'vibratePush'].includes(data.alertMode || 'push') ? [300, 120, 300, 120, 500] : [],
      data: { url: data.url || '/' }
    });
  });
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if ('focus' in client) { client.navigate(target); return client.focus(); }
    }
    return clients.openWindow ? clients.openWindow(target) : undefined;
  }));
});
`;

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Service-Worker-Allowed', '/');
  res.status(200).send(source);
}
