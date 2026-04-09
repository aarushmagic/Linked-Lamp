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
        firebaseInitialized = true;
        console.log('[firebase-messaging-sw.js] Firebase initialized successfully (for token generation).');
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


// ============================================================================
// ROCK SOLID PUSH HANDLER
// ============================================================================
// iOS terminates push subscriptions after 3+ "silent pushes" (pushes received
// where showNotification is not called). 
// Firebase's `onBackgroundMessage` is dangerous here because it relies on
// extracting config from IndexedDB to initialize before it handles events.
// If IndexedDB is cleared, it fails silently, causing a silent push.
// By listening to the raw 'push' event synchronously, we GUARANTEE iOS sees
// a notification every single time, avoiding the NotRegistered termination.
self.addEventListener('push', (event) => {
    let title = 'Linked Lamp';
    let body = 'Your lamp received a tap!';

    try {
        const payload = event.data ? event.data.json() : {};
        // FCM payload wraps data-only payloads in a 'data' object
        if (payload && payload.data) {
            title = payload.data.title || title;
            body = payload.data.body || body;
        }
    } catch (e) {
        console.error('Failed to parse push data:', e);
    }

    event.waitUntil(
        self.registration.showNotification(title, {
            body: body,
            icon: 'pwa-icon.png',
            badge: 'pwa-icon.png',
            // Use static tag without timestamp if you don't want them to pile up,
            // or dynamic tag to ensure every single tap shows a separate bubble.
            // Using a timestamp ensures we never collapse them if iOS expects multiples.
            tag: 'lamp-tap-' + Date.now(),
            renotify: true
        })
    );
});

