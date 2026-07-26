export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    firebase: {
      apiKey: process.env.FIREBASE_API_KEY || '',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
      projectId: process.env.FIREBASE_PROJECT_ID || '',
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
      appId: process.env.FIREBASE_APP_ID || ''
    },
    vapidKey: process.env.FIREBASE_VAPID_KEY || '',
    backgroundPushConfigured: Boolean(
      process.env.FIREBASE_API_KEY &&
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_MESSAGING_SENDER_ID &&
      process.env.FIREBASE_APP_ID &&
      process.env.FIREBASE_VAPID_KEY
    )
  });
}
