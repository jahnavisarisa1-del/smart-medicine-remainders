import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import config from './firebase-config.js';

const form = document.querySelector('#patient-auth-form');
const message = document.querySelector('#patient-auth-message');
const values = () => ({ email: document.querySelector('#patient-email').value.trim(), password: document.querySelector('#patient-password').value });

if (!config.enabled) message.textContent = config.initializationError
    ? 'Firebase failed to initialize - check firebase-config.js.'
    : 'Firebase is not configured. Add the web config from Firebase Console to firebase-config.js.';

async function authenticate(mode) {
    if (!config.auth || !config.db) throw new Error('Firebase setup is required before signing in.');
    const { email, password } = values();
    const credential = mode === 'signup'
        ? await createUserWithEmailAndPassword(config.auth, email, password)
        : await signInWithEmailAndPassword(config.auth, email, password);
    const patientRef = doc(config.db, 'patients', credential.user.uid);
    const patient = await getDoc(patientRef);
    if (mode === 'signup' && !patient.exists()) {
        await setDoc(patientRef, { patientUID: credential.user.uid, patientId: credential.user.uid, linkedCaregiverUIDs: [], familyMembers: [], familyMemberEmails: [], medicines: [], doseLog: [], alertLog: [], updatedAt: new Date().toISOString() });
        window.location.href = 'index.html';
        return;
    }
    if (!patient.exists()) throw new Error('No patient profile is linked to this account.');
    const data = patient.data();
    localStorage.setItem('smartMedicineReminderData', JSON.stringify({ profile: data, medicines: data.medicines || [] }));
    window.location.href = 'dashboard.html';
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = 'Signing in...';
    try { await authenticate('login'); } catch (error) { message.textContent = error.message; }
});

document.querySelector('#patient-signup-button').addEventListener('click', async () => {
    message.textContent = 'Creating account...';
    try { await authenticate('signup'); } catch (error) { message.textContent = error.message; }
});