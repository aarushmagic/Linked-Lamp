const CACHE_NAME = 'linked-lamp-v1';
const ASSETS = [
    './index.html',
    './style.css',
    './script.js',
    'https://unpkg.com/mqtt/dist/mqtt.min.js',
    'https://cdn.jsdelivr.net/npm/@jaames/iro@5',
    'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap',
    'https://fonts.googleapis.com/icon?family=Material+Icons+Round'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('fetch', event => {
    // Only intercept same-origin or known CDNs, skip Firebase backend calls
    if (event.request.method !== 'GET') return;
    
    event.respondWith(
        caches.match(event.request).then(response => {
            return response || fetch(event.request);
        })
    );
});
