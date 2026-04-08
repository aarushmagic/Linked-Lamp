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
            
            const title = (payload.notification && payload.notification.title) || 'Linked Lamp';
            const body = (payload.notification && payload.notification.body) || 'Your lamp received a tap!';

            return self.registration.showNotification(title, {
                body: body,
                icon: 'icon-192.png',
                badge: 'icon-192.png',
                tag: 'linked-lamp-notify',
                renotify: true
            });
        });
    }
} catch (e) {
    console.error("Firebase SW Init Error: ", e);
}


