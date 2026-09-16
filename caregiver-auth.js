import { createUserWithEmailAndPassword, deleteUser, signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { arrayUnion, doc, getDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import config from './firebase-config.js';

const message = document.querySelector('#auth-message');
const form = document.querySelector('#caregiver-auth-form');
const getValues = () => ({ email: document.querySelector('#caregiver-email').value.trim().toLowerCase(), password: document.querySelector('#caregiver-password').value, patientLookup: document.querySelector('#patient-lookup').value.trim() });

if (!config.enabled) message.textContent = config.initializationError
    ? 'Firebase failed to initialize - check firebase-config.js.'
    : 'Firebase is not configured. Add the web config from Firebase Console to firebase-config.js.';
const auth = config.auth;
const db = config.db;

async function authenticate(mode) {
    const values = getValues();
    if (!auth || !db) throw new Error('Firebase setup is required before using caregiver login.');
    if (!values.patientLookup) throw new Error('Enter the patient ID supplied by the patient.');
    const credential = mode === 'signup'
        ? await createUserWithEmailAndPassword(auth, values.email, values.password)
        : await signInWithEmailAndPassword(auth, values.email, values.password);
    const patientRef = doc(db, 'patients', values.patientLookup);
    try {
        await updateDoc(patientRef, { linkedCaregiverUIDs: arrayUnion(credential.user.uid) });
        const patient = await getDoc(patientRef);
        if (!patient.exists()) throw new Error('Patient ID was not found. Ask the patient for the exact ID.');
        const familyMembers = patient.data().familyMembers || [];
        if (!familyMembers.some((member) => String(member.email || '').trim().toLowerCase() === values.email)) {
            throw new Error('This email is not listed as a caregiver for this patient - please ask the patient to add you first.');
        }
    } catch (error) {
        if (mode === 'signup' && auth.currentUser) await deleteUser(auth.currentUser).catch(() => { });
        throw new Error(error.code ? `${error.code}: ${error.message}` : error.message);
    }
    sessionStorage.setItem('smartMedicinePatientId', values.patientLookup);
    window.location.href = 'caregiver-dashboard.html';
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = 'Signing in...';
    try { await authenticate('login'); } catch (error) { message.textContent = error.code ? `${error.code}: ${error.message}` : error.message; }
});

document.querySelector('#signup-button').addEventListener('click', async () => {
    message.textContent = 'Creating account...';
    try { await authenticate('signup'); } catch (error) { message.textContent = error.code ? `${error.code}: ${error.message}` : error.message; }
});
