importScripts('https://www.gstatic.com/firebasejs/10.10.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.10.0/firebase-messaging-compat.js');

// Firebase config is received via postMessage from the main page and cached
// in IndexedDB so it survives service worker restarts.
const DB_NAME = 'll_sw_config';
const STORE_NAME = 'config';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function saveConfig(config) {
    return openDB().then(db => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(config, 'firebaseConfig');
        return new Promise(resolve => { tx.oncomplete = resolve; });
    });
}

function loadConfig() {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get('firebaseConfig');
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    });
}

let firebaseInitialized = false;

function initFirebase(config) {
    if (firebaseInitialized || !config) return;
    try {
        firebase.initializeApp(config);
        const messaging = firebase.messaging();

        messaging.onBackgroundMessage((payload) => {
            console.log('[firebase-messaging-sw.js] Received background message ', payload);

            // Read from data payload (not notification) — data-only messages
            // always route through the SW on iOS instead of being auto-handled.
            const title = (payload.data && payload.data.title) || 'Linked Lamp';
            const body = (payload.data && payload.data.body) || 'Your lamp received a tap!';

            return self.registration.showNotification(title, {
                body: body,
                icon: 'pwa-icon.png',
                badge: 'pwa-icon.png',
                tag: 'linked-lamp-' + Date.now(),
                renotify: true
            });
        });

        firebaseInitialized = true;
        console.log('[firebase-messaging-sw.js] Firebase initialized successfully.');
    } catch (e) {
        console.error("Firebase SW Init Error: ", e);
    }
}

// Listen for config from the main page
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'FIREBASE_CONFIG') {
        saveConfig(event.data.config).then(() => {
            initFirebase(event.data.config);
        });
    }
});

// On SW startup, try to load cached config from IndexedDB
loadConfig().then(config => {
    if (config) initFirebase(config);
}).catch(e => console.error('Failed to load cached config:', e));
