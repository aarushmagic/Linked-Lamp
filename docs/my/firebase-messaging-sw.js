importScripts('https://www.gstatic.com/firebasejs/10.10.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.10.0/firebase-messaging-compat.js');

try {
    const urlParams = new URLSearchParams(self.location.search);
    if (urlParams.has('config')) {
        const configStr = decodeURIComponent(urlParams.get('config'));
        const config = JSON.parse(configStr);
        firebase.initializeApp(config);
        const messaging = firebase.messaging();

        messaging.onBackgroundMessage((payload) => {
            console.log('[firebase-messaging-sw.js] Received background message ', payload);
            // The browser FCM automatically handles 'notification' payloads so we don't
            // explicitly need to call self.registration.showNotification here
        });
    }
} catch (e) {
    console.error("Firebase SW Init Error: ", e);
}


