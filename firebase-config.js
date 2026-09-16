import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

/* Verify Email/Password Authentication and Firestore are enabled in Firebase Console. */
const firebaseConfig = {
    apiKey: "AIzaSyCMzfvL6S1Y4L_x7Vizey4uKXzWKAZdNj4",
    authDomain: "smart-medicine-remainder-4bd21.firebaseapp.com",
    projectId: "smart-medicine-remainder-4bd21",
    storageBucket: "smart-medicine-remainder-4bd21.firebasestorage.app",
    messagingSenderId: "1041033635322",
    appId: "1:1041033635322:web:1a5f6e17105e472ca2f043",
    measurementId: "G-3J9DH6QBL6"
};

let app = null;
let auth = null;
let db = null;
let initializationError = null;

try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
} catch (error) {
    initializationError = error;
    window.smartMedicineFirebaseError = error;
    console.error('Firebase failed to initialize - check firebase-config.js', error);
}

const enabled = Boolean(app && auth && db);
export { firebaseConfig, enabled, initializationError };
export { auth, db };
export default { value: firebaseConfig, enabled, app, auth, db, initializationError };
