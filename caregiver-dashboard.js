import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { collection, onSnapshot, query, where } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import config from './firebase-config.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const loading = document.querySelector('#caregiver-loading');
const content = document.querySelector('#caregiver-content');
const error = document.querySelector('#caregiver-error');
const patientList = document.querySelector('#family-patient-list');
if (!config.enabled) error.textContent = config.initializationError
    ? 'Firebase failed to initialize - check firebase-config.js.'
    : 'Firebase is not configured. Add the Firebase web config first.';
const auth = config.auth;
const db = config.db;

document.querySelector('#logout-button').addEventListener('click', async () => {
    try { if (auth) await signOut(auth); } catch (signOutError) { error.textContent = `${signOutError.code}: ${signOutError.message}`; return; }
    sessionStorage.removeItem('smartMedicinePatientId');
    window.location.href = 'caregiver-login.html';
});

function render(patient) {
    const today = new Date().toISOString().slice(0, 10);
    const doseLog = patient.doseLog || [];
    const latestStatus = new Map(doseLog.filter((event) => event.time).map((event) => [`${event.medicine}|${event.time}`, event.status]));
    const medicines = (patient.medicines || []).filter((medicine) => medicine.date === today || !medicine.date).map((medicine) => ({ ...medicine, status: latestStatus.get(`${medicine.name}|${medicine.time}`) || (medicine.taken ? 'taken' : 'pending') }));
    const missed = doseLog.filter((event) => event.status === 'missed' || event.status === 'escalation');
    document.querySelector('#family-patient-name').textContent = patient.name || 'Patient';
    document.querySelector('#family-diseases').textContent = (patient.diseases || []).join(', ') || 'No conditions recorded';
    document.querySelector('#family-monitored-by').textContent = `Also monitored by: ${(patient.familyMembers || []).map((member) => member.name).join(', ') || 'No other family members listed'}`;
    document.querySelector('#family-contact').textContent = patient.contact || 'Not provided';
    document.querySelector('#family-dose-count').textContent = medicines.length;
    document.querySelector('#family-missed-count').textContent = missed.length;
    document.querySelector('#family-reminders').innerHTML = medicines.length ? medicines.map((medicine) => `<div class="family-reminder"><strong>${esc(medicine.name)}</strong><span>${esc(medicine.dosage)} · ${esc(medicine.time)}</span><b class="status-${esc(medicine.status || 'pending')}">${medicine.status === 'taken' ? 'Taken ✅' : medicine.status === 'missed' ? 'Missed ❌' : 'Pending ⏳'}</b></div>`).join('') : '<p class="muted">No reminders for today.</p>';
    document.querySelector('#family-dose-log').innerHTML = missed.length ? missed.slice(-20).reverse().map((event) => `<div class="history-entry"><strong>${esc(event.medicine || event.medicineName)}</strong><small>${esc(event.status)} · ${esc(new Date(event.timestamp).toLocaleString())}</small></div>`).join('') : '<p class="muted">No missed doses.</p>';
    document.querySelector('#family-alert-log').innerHTML = (patient.alertLog || []).length ? patient.alertLog.slice(-20).reverse().map((event) => `<div class="history-entry"><strong>${esc(event.channel || 'alert')} · ${esc(event.status)}</strong><small>${esc(new Date(event.timestamp).toLocaleString())}</small></div>`).join('') : '<p class="muted">No alerts logged.</p>';
    loading.classList.add('hidden'); content.classList.remove('hidden');
}

function renderPatients(patients) {
    patientList.innerHTML = patients.map((patient) => {
        const medicines = (patient.medicines || []).filter((medicine) => medicine.date === new Date().toISOString().slice(0, 10) || !medicine.date);
        return `<article class="panel family-patient-card"><span class="eyebrow">Linked patient</span><h2>${esc(patient.name || 'Patient')}</h2><p>${esc((patient.diseases || []).join(', ') || 'No conditions recorded')}</p><strong>${medicines.length} scheduled dose${medicines.length === 1 ? '' : 's'}</strong><div>${medicines.map((medicine) => `<p><b>${esc(medicine.name)}</b> · ${esc(medicine.dosage)} · ${esc(medicine.time)}</p>`).join('') || '<p class="muted">No reminders for today.</p>'}</div></article>`;
    }).join('');
    render(patients[0]);
}

if (auth && db) onAuthStateChanged(auth, (user) => {
    if (!user) { window.location.href = 'caregiver-login.html'; return; }
    const patientsQuery = query(collection(db, 'patients'), where('linkedCaregiverUIDs', 'array-contains', user.uid));
    onSnapshot(patientsQuery, (snapshot) => {
        if (snapshot.empty) {
            loading.textContent = 'No linked patients found.';
            return;
        }
        renderPatients(snapshot.docs.map((patient) => patient.data()));
    }, (snapshotError) => { error.textContent = `${snapshotError.code}: ${snapshotError.message}`; });
});
