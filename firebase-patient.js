import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { doc, getDoc, setDoc, updateDoc, arrayUnion } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import config from './firebase-config.js';

if (config.enabled && config.auth && config.db) {
    const auth = config.auth;
    const db = config.db;
    window.smartMedicineCloudReady = new Promise((resolve) => onAuthStateChanged(auth, (user) => resolve(user ? window.smartMedicineCloud : null)));
    window.smartMedicineCloud = {
        getIdentity() {
            const user = auth.currentUser;
            if (!user) throw new Error('Patient authentication is required');
            return { firebase_uid: user.uid, email: (user.email || '').trim().toLowerCase() };
        },
        async saveProfile(profile, reminders) {
            const user = auth.currentUser;
            if (!user) throw new Error('Patient authentication is required');
            const patientId = user.uid;
            const familyMembers = profile.familyMembers || [];
            const familyMemberEmails = familyMembers.map((member) => String(member.email || '').trim().toLowerCase()).filter(Boolean);
            const previous = (await getDoc(doc(db, 'patients', patientId))).data() || {};
            const cloudProfile = { ...previous, ...profile, patientId, patientUID: user.uid, linkedCaregiverUIDs: previous.linkedCaregiverUIDs || [], familyMembers, familyMemberEmails, caregiverEmailLower: String(profile.caregiverEmail || '').trim().toLowerCase(), medicines: reminders, doseLog: previous.doseLog || [], alertLog: previous.alertLog || [], updatedAt: new Date().toISOString() };
            await setDoc(doc(db, 'patients', patientId), cloudProfile, { merge: true });
            return { ...profile, patientId };
        },
        async logDose(patientId, event) {
            if (!patientId) return;
            await updateDoc(doc(db, 'patients', patientId), { doseLog: arrayUnion({ ...event, timestamp: new Date().toISOString() }), updatedAt: new Date().toISOString() });
        },
        async logAlert(patientId, event) {
            if (!patientId) return;
            await updateDoc(doc(db, 'patients', patientId), { alertLog: arrayUnion({ ...event, timestamp: new Date().toISOString() }), updatedAt: new Date().toISOString() });
        },
        async updateProfile(patientId, fields) {
            if (!patientId) return;
            await updateDoc(doc(db, 'patients', patientId), { ...fields, updatedAt: new Date().toISOString() });
        }
    };
}

if (config.enabled && config.auth && (location.pathname.endsWith('dashboard.html') || location.pathname.endsWith('index.html'))) {
    onAuthStateChanged(config.auth, (user) => { if (!user) location.href = 'patient-login.html'; });
}
