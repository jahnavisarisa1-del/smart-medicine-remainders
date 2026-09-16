/* BUG FIX NOTES:
    1. Mute was only checked by the beep path; speech and notifications could
        still start. All three paths now read the current mute state at fire time.
    2. Page-load checks treated old reminders as due. Reminders now fire only
        inside a 30-second live-time window; loading/rendering never fires one.
    FREE SERVICES ONLY: Firebase Auth/Firestore, EmailJS free tier, Web
    Notifications, Web Audio, Web Speech, and free static/server hosting. No
    paid SMS, calling, or paid email API is used by this frontend. */
const STORAGE_KEY = "smartMedicineReminderData";
const API_BASE = window.SMART_MEDICINE_API || "";
let selectedDiseaseNames = new Set();
const MISSED_DOSE_GRACE_MINUTES = 5;
const activeAlarms = Object.create(null);
const activeReminders = Object.create(null);
const ACTIVE_REMINDERS_KEY = "smartMedicineActiveReminders";
const TEST_MODE_KEY = "smartMedicineTestMode";
const REMINDER_GRACE_MS = 30000;
let availableVoices = [];
let speechRecognition = null;
let speechRecognitionActive = false;
let speechRecognitionShouldRun = false;
let speechRecognitionReminder = null;
let speechRecognitionLanguage = localStorage.getItem("smartMedicineSpeechLanguage") || "en-US";
let speechRecognitionRestartTimer = null;
let familyMembers = [];
let reminderIntervalId = null;
let serverSyncIntervalId = null;

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));

function renderFamilyMembers(members = []) {
    familyMembers = members;
    const container = $("#family-members");
    if (!container) return;
    container.innerHTML = members.map((member, index) => `<div class="family-form-row"><input data-family="name" value="${escapeHtml(member.name || "")}" placeholder="Name" required><input data-family="relationship" value="${escapeHtml(member.relationship || "")}" placeholder="Relationship" required><input data-family="email" value="${escapeHtml(member.email || "")}" placeholder="Email" type="email" required><button type="button" class="remove-button" data-remove-family="${index}">Remove</button></div>`).join("");
    container.querySelectorAll("[data-remove-family]").forEach((button) => button.addEventListener("click", () => { familyMembers.splice(Number(button.dataset.removeFamily), 1); renderFamilyMembers(familyMembers); }));
}

function collectFamilyMembers() {
    return [...document.querySelectorAll(".family-form-row")].map((row) => ({ name: row.querySelector("[data-family='name']").value.trim(), relationship: row.querySelector("[data-family='relationship']").value.trim(), email: row.querySelector("[data-family='email']").value.trim() }));
}

function readData() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { profile: null, medicines: [] };
    } catch (error) {
        return { profile: null, medicines: [] };
    }
}

function saveData(data) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
        showToast("Unable to save changes in this browser");
    }
}

function audioMuted() {
    return localStorage.getItem("smartMedicineMuteAudio") === "true";
}

function reminderDelayMs() {
    return localStorage.getItem(TEST_MODE_KEY) === "true" ? 15000 : MISSED_DOSE_GRACE_MINUTES * 60 * 1000;
}

function reminderIdFor(reminder) {
    return `${reminder.id}|${reminder.date}|${reminder.time}`;
}

function persistActiveReminders() {
    const serializable = Object.fromEntries(Object.entries(activeReminders).map(([id, reminder]) => [id, {
        ...reminder,
        timeoutId: undefined
    }]));
    localStorage.setItem(ACTIVE_REMINDERS_KEY, JSON.stringify(serializable));
}

function removeActiveReminder(reminderId) {
    if (activeReminders[reminderId]?.timeoutId) window.clearTimeout(activeReminders[reminderId].timeoutId);
    delete activeReminders[reminderId];
    persistActiveReminders();
}

function startMissedDoseTimer(reminder, profile) {
    const reminderId = reminderIdFor(reminder);
    if (activeReminders[reminderId]) return;
    const timer = {
        reminderId,
        sourceReminderId: reminder.id,
        medicineName: reminder.name,
        scheduledTime: reminder.time,
        patientName: profile.name,
        profile,
        taken: Boolean(reminder.taken),
        sent: false,
        dueAt: Date.now() + reminderDelayMs()
    };
    timer.timeoutId = window.setTimeout(() => checkAndSendAlert(reminderId), reminderDelayMs());
    activeReminders[reminderId] = timer;
    persistActiveReminders();
}

function checkAndSendAlert(reminderId) {
    const active = activeReminders[reminderId];
    if (!active || active.taken || active.sent) return;
    active.sent = true;
    const recipients = alertRecipients(active.profile);
    const payload = {
        patientName: active.patientName,
        medicineName: active.medicineName,
        scheduledTime: active.scheduledTime,
        alertType: "Missed Dose - 5 Minutes Overdue"
    };
    if (!recipients.length) {
        console.error("Automatic alert failed: no family member or caregiver email is configured", payload);
        showToast("Automatic alert failed: no caregiver email configured");
        removeActiveReminder(reminderId);
        return;
    }
    Promise.allSettled(recipients.map((recipient) => sendMedicineAlert(recipient.email, recipient.name, payload.patientName, payload.medicineName, payload.scheduledTime, payload.alertType)
        .then(() => console.log(`Alert email sent to ${recipient.name || recipient.email}`))
        .catch((error) => { console.error("Automatic alert email failed:", error); showToast(`Failed to alert ${recipient.name || recipient.email}`); })))
        .then((results) => {
            if (results.some((result) => result.status === "fulfilled")) showToast("Missed-dose alert sent to family");
            fetch(`${API_BASE}/api/mark-missed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reminderId: active.sourceReminderId }) }).catch(() => { });
            removeActiveReminder(reminderId);
        });
}

function restoreActiveReminders() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(ACTIVE_REMINDERS_KEY)) || {}; } catch (error) { saved = {}; }
    Object.entries(saved).forEach(([reminderId, savedReminder]) => {
        if (savedReminder.sent || savedReminder.taken) return;
        const remaining = Math.max(0, Number(savedReminder.dueAt) - Date.now());
        activeReminders[reminderId] = { ...savedReminder, timeoutId: window.setTimeout(() => checkAndSendAlert(reminderId), remaining) };
    });
    persistActiveReminders();
}

function cancelMissedDoseTimer(reminderId) {
    const active = activeReminders[reminderId];
    if (!active) return;
    active.taken = true;
    window.clearTimeout(active.timeoutId);
    delete activeReminders[reminderId];
    persistActiveReminders();
}

function stopReminderAudio(reminderId) {
    const alarm = activeAlarms[reminderId];
    if (!alarm) return;
    window.clearTimeout(alarm.timeoutId);
    try { alarm.oscillator.stop(); } catch (error) { /* already stopped */ }
    alarm.audio.close();
    delete activeAlarms[reminderId];
}

function stopAllReminderAudio() {
    Object.keys(activeAlarms).forEach((reminderId) => stopReminderAudio(reminderId));
    if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function playReminderAudio(reminder) {
    const muted = audioMuted();
    console.log("Mute is currently:", muted);
    const reminderId = reminder.id;
    if (activeAlarms[reminderId]) return;
    if (!muted) try {
        const audio = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.frequency.value = 880;
        oscillator.type = "sine";
        gain.gain.value = 0.08;
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start();
        const timeoutId = window.setTimeout(() => stopReminderAudio(reminderId), 60000);
        activeAlarms[reminderId] = { audio, oscillator, timeoutId };
    } catch (error) {
        showToast(`Reminder: time for ${reminder.name}`);
    }
    try {
        if (!muted && window.speechSynthesis) {
            const language = readData().profile?.preferredLanguage || "en-US";
            const phrase = languagePhrases[language] || languagePhrases["en-US"];
            const speech = new SpeechSynthesisUtterance(phrase.reminder(reminder.name));
            const selectedVoice = availableVoices.find((voice) => voice.lang.toLowerCase().startsWith(language.split("-")[0].toLowerCase()));
            if (selectedVoice) speech.voice = selectedVoice;
            else if (language !== "en-US") showToast(`Voice not available in ${language}; using English.`);
            speech.lang = selectedVoice ? language : "en-US";
            window.speechSynthesis.speak(speech);
        }
    } catch (error) {
        showToast("Voice reminder is unavailable");
    }
}

/* EmailJS template variables are exactly: to_email, to_name, patient_name,
    medicine_name, scheduled_time, and alert_type. */
let emailJsInitialized = false;
const EMAIL_FLAGS_KEY = "smartMedicineEmailSentFor";

function emailFlags() {
    try { return JSON.parse(localStorage.getItem(EMAIL_FLAGS_KEY)) || {}; } catch (error) { return {}; }
}

function saveEmailFlags(flags) {
    localStorage.setItem(EMAIL_FLAGS_KEY, JSON.stringify(flags));
}

function initializeEmailJS() {
    const config = window.SMART_MEDICINE_NOTIFICATIONS || {};
    if (!window.emailjs || !config.emailjsServiceId || !config.emailjsTemplateId || !config.emailjsPublicKey) return;
    try {
        if (emailJsInitialized) return;
        window.emailjs.init({ publicKey: config.emailjsPublicKey });
        emailJsInitialized = true;
    } catch (error) {
        console.error("EmailJS initialization failed", error);
        updateEmailStatus("Email failed to initialize - check console");
    }
}

function updateEmailStatus(message) {
    const status = $("#email-status");
    if (status) status.innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
}

function sendMedicineAlert(toEmail, toName, patientName, medicineName, scheduledTime, alertType) {
    const config = window.SMART_MEDICINE_NOTIFICATIONS || {};
    if (!emailJsInitialized || !toEmail) {
        const error = new Error("EmailJS is not initialized or recipient email is missing");
        console.error("Email failed:", error);
        updateEmailStatus("Failed to send alert - check console");
        return Promise.reject(error);
    }
    return window.emailjs.send(config.emailjsServiceId, config.emailjsTemplateId, { to_email: toEmail, to_name: toName, patient_name: patientName, medicine_name: medicineName, scheduled_time: scheduledTime, alert_type: alertType })
        .then((response) => { console.log("Email sent successfully", response); updateEmailStatus(`Alert sent to ${toName || toEmail}`); return response; })
        .catch((error) => { console.error("Email failed:", error); updateEmailStatus("Failed to send alert - check console"); throw error; });
}

function alertRecipients(profile) {
    const recipients = (profile.familyMembers || []).filter((member) => member.email).map((member) => ({ email: member.email, name: member.name }));
    if (!recipients.length && profile.caregiverEmail) recipients.push({ email: profile.caregiverEmail, name: profile.caregiverName || "Caregiver" });
    return recipients;
}

function sendReminderEmails(reminder, profile, alertType) {
    const flags = emailFlags();
    const key = `${todayKey()}|${reminder.id}|${alertType}`;
    if (flags[key]) return;
    flags[key] = true;
    saveEmailFlags(flags);
    alertRecipients(profile).forEach((recipient) => sendMedicineAlert(recipient.email, recipient.name, profile.name, reminder.name, reminder.time, alertType).catch(() => { }));
}

function showView(viewName) {
    $("#profile-view")?.classList.toggle("hidden", viewName !== "profile");
    $("#dashboard-view")?.classList.toggle("hidden", viewName !== "dashboard");
    if (viewName === "dashboard") renderDashboard();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 3000);
}

function fuzzyScore(query, item) {
    const aliases = { sugar: "diabetes", bp: "hypertension", tb: "tuberculosis", pcod: "polycystic ovary syndrome", pcos: "polycystic ovary syndrome", copd: "copd", ed: "erectile dysfunction" };
    const normalizedQuery = aliases[query.trim().toLowerCase()] || query.trim().toLowerCase();
    const text = `${item.name} ${item.synonyms || ""} ${item.brandNames || ""}`.toLowerCase();
    if (!normalizedQuery) return 0;
    if (text.includes(normalizedQuery)) return 100;
    return normalizedQuery.split(/\s+/).reduce((score, word) => score + (text.includes(word) ? 20 : 0), 0);
}

function searchDiseases(query) {
    return diseaseLibrary
        .map((disease) => ({ disease, score: fuzzyScore(query, disease) }))
        .filter((result) => !query.trim() || result.score > 0)
        .sort((a, b) => b.score - a.score || a.disease.name.localeCompare(b.disease.name))
        .slice(0, 80)
        .map((result) => result.disease);
}

function renderDiseaseChoices(selected = [], query = "") {
    selectedDiseaseNames = new Set(selected);
    $("#disease-list").innerHTML = searchDiseases(query).map((disease) => `
        <label class="choice ${selected.includes(disease.name) ? "selected" : ""}"><input type="checkbox" value="${escapeHtml(disease.name)}" ${selected.includes(disease.name) ? "checked" : ""}>${escapeHtml(disease.name)}</label>
    `).join("");
    $("#disease-list").querySelectorAll("input").forEach((input) => input.addEventListener("change", () => {
        if (input.checked) selectedDiseaseNames.add(input.value);
        else selectedDiseaseNames.delete(input.value);
        input.closest(".choice").classList.toggle("selected", input.checked);
        updateSuggestedMedicines();
    }));
}

function getSelectedDiseases() {
    return [...selectedDiseaseNames];
}

function suggestedNames() {
    return [...new Set(getSelectedDiseases().flatMap((name) => diseaseLibrary.find((disease) => disease.name === name)?.medicines || []))];
}

function updateSuggestedMedicines() {
    const current = collectMedicinesFromForm();
    const names = [...new Set([...current.map((medicine) => medicine.name).filter(Boolean), ...suggestedNames()])];
    renderMedicineEditor(names.map((name) => ({ name, ...(medicineLibrary[name] || {}) })));
}

function searchMedicineLibrary(query) {
    return Object.entries(medicineLibrary)
        .map(([name, details]) => ({ name, details, score: fuzzyScore(query, { name, brandNames: details.brandNames }) }))
        .filter((result) => !query.trim() || result.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, 10);
}

function renderMedicineSuggestions(query = "") {
    const container = $("#medicine-suggestions");
    const matches = query.trim() ? searchMedicineLibrary(query) : [];
    container.innerHTML = matches.map(({ name, details }) => `<button type="button" class="suggestion" data-medicine="${escapeHtml(name)}"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(details.brandNames || "Generic medicine")}</small></button>`).join("");
    container.querySelectorAll("[data-medicine]").forEach((button) => button.addEventListener("click", () => {
        const current = collectMedicinesFromForm();
        const name = button.dataset.medicine;
        if (!current.some((medicine) => medicine.name.toLowerCase() === name.toLowerCase())) {
            current.push({ name, ...(medicineLibrary[name] || {}) });
            renderMedicineEditor(current);
        }
        $("#medicine-search").value = "";
        container.innerHTML = "";
    }));
}

function collectMedicinesFromForm() {
    return [...document.querySelectorAll(".medicine-row")].map((row) => ({
        name: row.querySelector("[data-field='name']")?.value.trim() || "",
        dosage: row.querySelector("[data-field='dosage']")?.value.trim() || "",
        frequency: Number(row.querySelector("[data-field='frequency']")?.value || 1),
        times: row.querySelector("[data-field='times']")?.value.trim() || "",
        notes: row.querySelector("[data-field='notes']")?.value.trim() || ""
    }));
}

function renderMedicineEditor(medicines) {
    const list = medicines.length ? medicines : [{ name: "", dosage: "", frequency: 1, times: "08:00" }];
    $("#medicine-editor").innerHTML = list.map((medicine, index) => `
        <div class="medicine-row" data-index="${index}">
            <div class="medicine-row-head"><strong>Medicine ${index + 1}</strong><button class="remove-button" type="button" data-remove="${index}">Remove</button></div>
            <div class="medicine-fields">
                <label>Medicine name *<input data-field="name" value="${escapeHtml(medicine.name || "")}" placeholder="e.g. Metformin" required></label>
                <label>Dosage<input data-field="dosage" value="${escapeHtml(medicine.dosage || "")}" placeholder="e.g. 500 mg" required></label>
                <label>Times/day<input data-field="frequency" type="number" min="1" max="8" value="${medicine.frequency || 1}" required></label>
                <label>Reminder times *<input data-field="times" value="${escapeHtml(medicine.times || "08:00")}" placeholder="08:00, 20:00" required></label>
                <label>Notes<input data-field="notes" value="${escapeHtml(medicine.notes || "")}" placeholder="e.g. after food"></label>
            </div>
        </div>
    `).join("");
    $("#medicine-editor").querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => {
        const rows = collectMedicinesFromForm();
        rows.splice(Number(button.dataset.remove), 1);
        renderMedicineEditor(rows);
    }));
}

function loadProfileIntoForm() {
    const data = readData();
    const profile = data.profile;
    if (!profile) {
        $("#profile-form").reset();
        renderDiseaseChoices();
        renderMedicineEditor([]);
        return;
    }
    $("#patient-name").value = profile.name || "";
    $("#patient-age").value = profile.age || "";
    $("#patient-gender").value = profile.gender || "";
    $("#preferred-language").value = profile.preferredLanguage || "en-US";
    $("#caregiver-name").value = profile.caregiverName || "";
    $("#caregiver-email").value = profile.caregiverEmail || "";
    renderFamilyMembers(profile.familyMembers || []);
    renderDiseaseChoices(profile.diseases || []);
    renderMedicineEditor(profile.medicines || []);
}

function validateProfile(profile) {
    if (!profile.name || !profile.age || !profile.gender || !profile.preferredLanguage || !profile.caregiverName || !profile.caregiverEmail) return "Complete all required patient and caregiver fields.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.caregiverEmail)) return "Enter a valid caregiver email address.";
    if (!profile.diseases.length) return "Select at least one disease or condition.";
    if (!profile.medicines.length || profile.medicines.some((medicine) => !medicine.name || !medicine.dosage || !medicine.times)) return "Add at least one medicine with dosage and reminder time.";
    if (profile.medicines.some((medicine) => medicine.times.split(",").map((time) => time.trim()).filter(Boolean).length !== Number(medicine.frequency))) return "Make the number of reminder times match Times/day for each medicine.";
    return "";
}

async function saveProfile(event) {
    event.preventDefault();
    const profile = {
        name: $("#patient-name").value.trim(), age: $("#patient-age").value, gender: $("#patient-gender").value, preferredLanguage: $("#preferred-language").value,
        caregiverName: $("#caregiver-name").value.trim(), caregiverEmail: $("#caregiver-email").value.trim(), familyMembers: collectFamilyMembers(),
        diseases: getSelectedDiseases(), medicines: collectMedicinesFromForm().filter((medicine) => medicine.name)
    };
    const error = validateProfile(profile);
    $("#profile-error").textContent = error;
    if (error) return;
    if (profile.familyMembers.some((member) => !member.name || !member.relationship || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email))) { $("#profile-error").textContent = "Complete every family member's name, relationship, and valid email."; return; }
    const reminders = buildReminders(profile.medicines);
    saveData({ profile, medicines: reminders });
    await syncProfileToServer(profile, reminders);
    showToast("Profile saved");
    window.location.href = "dashboard.html";
}

async function syncProfileToServer(profile, reminders) {
    try {
        const cloud = await window.smartMedicineCloudReady;
        const identity = cloud?.getIdentity?.();
        if (window.location.protocol !== "file:") {
            const response = await fetch(`${API_BASE}/api/patient-profile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile, reminders, ...identity }) });
            if (!response.ok) throw new Error("Node server profile sync failed");
        }
    } catch (error) {
        console.error("Node profile sync failed", error);
    }
    try {
        const cloud = await window.smartMedicineCloudReady;
        const cloudProfile = await cloud?.saveProfile(profile, reminders);
        if (cloudProfile?.patientId) { profile.patientId = cloudProfile.patientId; saveData({ profile, medicines: reminders }); }
    } catch (error) {
        console.error("Firebase profile sync failed", error);
        showToast("Saved locally; Firebase sync is unavailable");
    }
}

function buildReminders(medicines) {
    return medicines.flatMap((medicine) => medicine.times.split(",").map((time) => ({ id: `${Date.now()}-${Math.random()}`, name: medicine.name, dosage: medicine.dosage, notes: medicine.notes || "", time: time.trim(), taken: false, date: todayKey(), snoozedUntil: null })));
}

function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatTime(time) {
    const [hours, minutes] = time.split(":").map(Number);
    const date = new Date(); date.setHours(hours, minutes, 0, 0);
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderDashboard() {
    const data = readData();
    const profile = data.profile;
    if (!profile) { showView("profile"); return; }
    $("#today-label").textContent = new Date().toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    $("#caregiver-display").textContent = profile.caregiverEmail || "Not configured";
    $("#patient-display").textContent = profile.name;
    $("#profile-details").innerHTML = `<div><dt>Patient ID</dt><dd>${escapeHtml(profile.patientId || "Enable Firebase sync")}</dd></div><div><dt>Age</dt><dd>${escapeHtml(profile.age)}</dd></div><div><dt>Gender</dt><dd>${escapeHtml(profile.gender)}</dd></div><div><dt>Language</dt><dd>${escapeHtml(profile.preferredLanguage)}</dd></div><div><dt>Conditions</dt><dd>${escapeHtml(profile.diseases.join(", "))}</dd></div>`;
    renderReminders(data.medicines || []);
}

function renderReminders(reminders) {
    const todays = reminders.filter((reminder) => reminder.date === todayKey());
    const completed = todays.filter((reminder) => reminder.taken).length;
    const progress = todays.length ? Math.round((completed / todays.length) * 100) : 0;
    $("#progress-value").textContent = `${progress}%`;
    $("#progress-bar").style.width = `${progress}%`;
    $("#reminder-list").innerHTML = todays.length ? todays.sort((a, b) => a.time.localeCompare(b.time)).map((reminder) => `
        <article class="reminder ${reminder.taken ? "taken" : ""}"><span class="reminder-time">${formatTime(reminder.time)}</span><div><strong>${escapeHtml(reminder.name)}</strong><small>${escapeHtml(reminder.dosage)}${reminder.notes ? ` · ${escapeHtml(reminder.notes)}` : ""}${reminder.snoozedUntil ? " · Snoozed" : ""}</small></div><div class="reminder-actions"><button class="take-button ${reminder.taken ? "taken" : ""}" data-take="${reminder.id}">${reminder.taken ? "Taken" : "Mark taken"}</button><button class="voice-button ${reminder.taken ? "confirmed" : ""}" data-voice="${reminder.id}" ${reminder.taken ? "disabled" : ""}><span class="mic-icon" aria-hidden="true">&#127908;</span><span class="voice-label">${reminder.taken ? "Confirmed" : "Tap and Speak"}</span></button><div class="voice-feedback ${reminder.taken ? "success" : "hidden"}" data-voice-feedback="${reminder.id}" role="status">${reminder.taken ? "&#10003; Taken" : ""}</div><div class="voice-fallback hidden" data-voice-fallback="${reminder.id}"><span>Speech is unavailable. Did you take it?</span><button type="button" data-fallback-yes="${reminder.id}">Yes</button><button type="button" data-fallback-no="${reminder.id}">No</button></div></div><button class="snooze-button" data-snooze="${reminder.id}" ${reminder.taken ? "disabled" : ""}>Snooze</button><button class="delete-button" data-delete="${reminder.id}">Delete</button></article>
    `).join("") : `<p class="muted">No reminders for today. Edit your plan to add one.</p>`;
    const next = todays.filter((reminder) => !reminder.taken && minutesUntil(reminder.time) >= 0).sort((a, b) => minutesUntil(a.time) - minutesUntil(b.time))[0];
    $("#next-dose").textContent = next ? next.name : (todays.length ? "All complete" : "No reminders");
    $("#next-dose-time").textContent = next ? `In ${countdownText(next.time)} · ${formatTime(next.time)}` : "Your schedule is clear";
    document.querySelectorAll("[data-take]").forEach((button) => button.addEventListener("click", () => updateReminder(button.dataset.take, false)));
    document.querySelectorAll("[data-voice]").forEach((button) => button.addEventListener("click", () => { const reminder = reminders.find((item) => item.id === button.dataset.voice); if (reminder) startVoiceConfirmation(reminder); }));
    document.querySelectorAll("[data-fallback-yes]").forEach((button) => button.addEventListener("click", () => onConfirmed(button.dataset.fallbackYes, "taken", new Date().toISOString())));
    document.querySelectorAll("[data-fallback-no]").forEach((button) => button.addEventListener("click", () => speakConfirmationPrompt()));
    document.querySelectorAll("[data-snooze]").forEach((button) => button.addEventListener("click", () => snoozeReminder(button.dataset.snooze)));
    document.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => updateReminder(button.dataset.delete, true)));
}

function minutesUntil(time) { const now = new Date(); const [hours, minutes] = time.split(":").map(Number); return (hours * 60 + minutes) - (now.getHours() * 60 + now.getMinutes()); }
function countdownText(time) { const total = Math.max(0, minutesUntil(time)); return `${Math.floor(total / 60)}h ${total % 60}m`; }

function updateReminder(id, remove) {
    const data = readData();
    if (remove) data.medicines = data.medicines.filter((reminder) => reminder.id !== id);
    else data.medicines = data.medicines.map((reminder) => reminder.id === id ? { ...reminder, taken: !reminder.taken, missedAlerted: false, takenAt: reminder.taken ? null : new Date().toISOString() } : reminder);
    const changed = data.medicines.find((reminder) => reminder.id === id);
    if (!remove && changed?.taken) cancelMissedDoseTimer(reminderIdFor(changed));
    if (!remove && data.medicines.find((reminder) => reminder.id === id)?.taken) {
        const flags = emailFlags();
        Object.keys(flags).filter((key) => key.includes(`|${id}|`)).forEach((key) => delete flags[key]);
        saveEmailFlags(flags);
    }
    saveData(data);
    if (!remove) syncTakenToServer(id, "button");
    if (!remove && changed) window.smartMedicineCloud?.logDose(data.profile?.patientId, { medicine: changed.name, time: changed.time, status: changed.taken ? "taken" : "pending" });
    if (!remove && changed?.taken) stopReminderAudio(id);
    renderDashboard(); showToast(remove ? "Reminder removed" : "Reminder updated");
}

function confirmationWords(language) {
    const words = { "en-US": ["okay", "ok", "done", "taken", "yes"], "hi-IN": ["हो गया", "ठीक है", "हाँ", "ले लिया"], "te-IN": ["సరే", "అయిపోయింది", "తీసుకున్నాను"], "ta-IN": ["சரி", "முடிந்தது", "எடுத்துவிட்டேன்"], "ml-IN": ["ശരി", "കഴിഞ്ഞു", "കഴിച്ചു"], "kn-IN": ["ಸರಿ", "ಆಯಿತು", "ತೆಗೆದುಕೊಂಡೆ"] };
    return words[language] || words["en-US"];
}

function speakConfirmationPrompt() {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance("Did you take your tablet? Please say yes or no.");
    utterance.rate = 0.85;
    window.speechSynthesis.speak(utterance);
}

function setVoiceState(reminderId, state, message = "") {
    const button = document.querySelector(`[data-voice="${reminderId}"]`);
    const feedback = document.querySelector(`[data-voice-feedback="${reminderId}"]`);
    const fallback = document.querySelector(`[data-voice-fallback="${reminderId}"]`);
    if (!button || !feedback) return;
    button.classList.toggle("listening", state === "listening");
    button.querySelector(".voice-label").textContent = state === "listening" ? "Listening..." : "Tap and Speak";
    feedback.className = `voice-feedback ${state === "success" ? "success" : ""} ${message ? "" : "hidden"}`;
    feedback.textContent = message;
    if (fallback) fallback.classList.toggle("hidden", state !== "fallback");
}

async function startVoiceConfirmation(reminder) {
    if (readData().voiceConfirmationEnabled === false) { showToast("Voice confirmation is disabled in Settings."); return; }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { setVoiceState(reminder.id, "fallback"); showToast("Voice is not supported here. You can choose Yes or No."); return; }
    if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
        setVoiceState(reminder.id, "fallback", "Microphone access requires HTTPS or localhost.");
        showToast("Open this site over HTTPS or localhost to use the microphone.");
        return;
    }
    if (speechRecognitionActive) return;
    speechRecognitionReminder = reminder;
    speechRecognitionShouldRun = true;
    startSpeechRecognition(Recognition);
}

function scheduleSpeechRecognitionRestart(Recognition) {
    if (!speechRecognitionShouldRun || speechRecognitionRestartTimer) return;
    speechRecognitionRestartTimer = window.setTimeout(() => {
        speechRecognitionRestartTimer = null;
        if (speechRecognitionShouldRun && !speechRecognitionActive) startSpeechRecognition(Recognition);
    }, 250);
}

function startSpeechRecognition(Recognition) {
    const reminder = speechRecognitionReminder;
    if (!reminder || speechRecognitionActive || !speechRecognitionShouldRun) return;
    try {
        speechRecognition = new Recognition();
        const recognition = speechRecognition;
        const language = speechRecognitionLanguage;
        recognition.lang = language;
        recognition.interimResults = false;
        recognition.continuous = false;
        speechRecognitionActive = true;
        recognition.onstart = () => {
            setVoiceState(reminder.id, "listening", "Listening... Please say yes when you have taken it.");
        };
        recognition.onend = () => {
            if (speechRecognition !== recognition) return;
            speechRecognitionActive = false;
            if (speechRecognitionShouldRun) scheduleSpeechRecognitionRestart(Recognition);
            else setVoiceState(reminder.id, "idle");
        };
        recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript.toLowerCase().trim();
            const confirmations = [...confirmationWords(language), ...(languagePhrases[language]?.confirmations || [])];
            if (confirmations.some((word) => transcript.includes(word.toLowerCase()))) {
                speechRecognitionShouldRun = false;
                recognition.stop();
                onConfirmed(reminder.id, "taken", new Date().toISOString());
            }
            else { setVoiceState(reminder.id, "fallback", "I did not understand that."); speakConfirmationPrompt(); }
        };
        recognition.onerror = (event) => {
            console.error("Speech recognition failed", event.error);
            speechRecognitionActive = false;
            if (event.error === "not-allowed" || event.error === "service-not-allowed") {
                speechRecognitionShouldRun = false;
                setVoiceState(reminder.id, "fallback", "Please allow microphone access, then choose Yes or No.");
            } else if (speechRecognitionShouldRun) {
                setVoiceState(reminder.id, "listening", "Listening... Please try speaking again.");
                scheduleSpeechRecognitionRestart(Recognition);
            }
        };
        recognition.start();
    } catch (error) {
        speechRecognitionActive = false;
        console.error("Could not start speech recognition", error);
        if (speechRecognitionShouldRun) scheduleSpeechRecognitionRestart(Recognition);
    }
}

function stopVoiceRecognition() {
    speechRecognitionShouldRun = false;
    if (speechRecognitionRestartTimer) window.clearTimeout(speechRecognitionRestartTimer);
    speechRecognitionRestartTimer = null;
    speechRecognitionActive = false;
    if (speechRecognition) {
        try { speechRecognition.stop(); } catch (error) { /* Recognition may already be stopped. */ }
    }
    speechRecognition = null;
}

function changeSpeechLanguage(language) {
    speechRecognitionLanguage = ["en-US", "hi-IN", "te-IN"].includes(language) ? language : "en-US";
    localStorage.setItem("smartMedicineSpeechLanguage", speechRecognitionLanguage);
    if (speechRecognitionShouldRun && speechRecognitionReminder) {
        stopVoiceRecognition();
        speechRecognitionShouldRun = true;
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (Recognition) startSpeechRecognition(Recognition);
    }
}

async function onConfirmed(medicineId, status, timestamp) {
    const data = readData();
    const patientId = data.profile?.patientId || "local-patient";
    updateReminderWithMethod(medicineId, "voice", timestamp);
    try {
        const response = await fetch(`${API_BASE}/api/medicine-confirmation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ medicine_id: medicineId, patient_id: patientId, status, confirmed_at: timestamp }) });
        if (!response.ok) throw new Error("Confirmation sync failed");
    } catch (error) { showToast("Saved here; server sync is unavailable."); }
}

function updateReminderWithMethod(id, method, confirmedAt = new Date().toISOString()) {
    const data = readData();
    data.medicines = data.medicines.map((reminder) => reminder.id === id ? { ...reminder, taken: true, confirmedVia: method, missedAlerted: false, takenAt: confirmedAt } : reminder);
    cancelMissedDoseTimer(reminderIdFor(data.medicines.find((reminder) => reminder.id === id)));
    const flags = emailFlags();
    Object.keys(flags).filter((key) => key.includes(`|${id}|`)).forEach((key) => delete flags[key]);
    saveEmailFlags(flags);
    saveData(data);
    if (method !== "voice") syncTakenToServer(id, method);
    const changed = data.medicines.find((reminder) => reminder.id === id);
    if (changed) window.smartMedicineCloud?.logDose(data.profile?.patientId, { medicine: changed.name, time: changed.time, status: "taken", confirmedVia: method });
    stopReminderAudio(id);
    renderDashboard();
    playConfirmationSound();
    showToast("Medicine marked as taken");
}

function playConfirmationSound() {
    if (audioMuted()) return;
    try {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 880;
        gain.gain.setValueAtTime(0.08, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.35);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.35);
    } catch (error) { console.warn("Success sound unavailable", error); }
}

async function syncTakenToServer(reminderId, confirmedVia = "button") {
    try {
        const response = await fetch(`${API_BASE}/api/mark-taken`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reminderId, confirmedVia }) });
        if (!response.ok) throw new Error("Could not sync taken status");
    } catch (error) {
        showToast("Marked locally; server sync is unavailable");
    }
}

async function syncServerState() {
    try {
        const response = await fetch(`${API_BASE}/api/state`, { cache: "no-store" });
        if (!response.ok) return;
        const serverState = await response.json();
        const data = readData();
        const serverReminders = new Map((serverState.reminders || []).map((reminder) => [reminder.id, reminder]));
        let changed = false;
        data.medicines = (data.medicines || []).map((reminder) => {
            const serverReminder = serverReminders.get(reminder.id);
            if (!serverReminder || (reminder.taken && serverReminder.status === "pending")) return reminder;
            if (serverReminder.status === "taken" || serverReminder.status === "missed") {
                if (serverReminder.status === "taken") cancelMissedDoseTimer(reminderIdFor(reminder));
                changed = changed || reminder.taken !== (serverReminder.status === "taken") || reminder.status !== serverReminder.status;
                return { ...reminder, taken: serverReminder.status === "taken", status: serverReminder.status, takenAt: serverReminder.takenAt || reminder.takenAt, confirmedVia: serverReminder.confirmedVia || reminder.confirmedVia };
            }
            return reminder;
        });
        if (changed) { saveData(data); renderDashboard(); }
    } catch (error) {
        // Local mode remains usable when the optional Node server is stopped.
    }
}

function snoozeReminder(id) {
    const data = readData();
    data.medicines = data.medicines.map((reminder) => reminder.id === id ? { ...reminder, snoozedUntil: Date.now() + 10 * 60 * 1000 } : reminder);
    saveData(data);
    stopReminderAudio(id);
    renderDashboard();
    showToast("Reminder snoozed for 10 minutes");
}

function scheduledTimestamp(reminder) {
    const [year, month, day] = reminder.date.split("-").map(Number);
    const [hours, minutes] = reminder.time.split(":").map(Number);
    return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

function checkMissedDoses() {
    // The per-reminder timeout owns the five-minute alert. The server remains
    // the recovery path when this browser is closed.
    syncServerState();
}

function searchLibrary() {
    const query = $("#library-search").value.trim().toLowerCase();
    const results = [...healthLibrary, ...Object.entries(medicineLibrary).map(([name, details]) => ({ kind: "Medicine", name, terms: details.brandNames || "", text: `General information about ${name}.`, advice: "Use only as prescribed and confirm questions with a pharmacist or clinician." }))]
        .map((item) => ({ item, score: fuzzyScore(query, item) }))
        .filter((result) => result.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((result) => result.item);
    $("#search-results").innerHTML = query && results.length ? results.map((item) => `<article class="result"><span class="badge">${item.kind}</span><h3>${item.name}</h3><p>${item.text}</p><p><strong>Suggestion:</strong> ${item.advice}</p></article>`).join("") : `<p class="muted">${query ? "No close match found. Try a disease or medicine name." : "Search results will appear here."}</p>`;
}

function requestNotificationPermission() { if ("Notification" in window && Notification.permission === "default") { showToast("Allow notifications so scheduled medicine reminders can reach you in the background."); Notification.requestPermission().catch(() => showToast("Notifications are unavailable; in-page reminders remain active.")); } }
function checkReminders() {
    const data = readData(); if (!data.profile) return;
    const now = Date.now();
    let changed = false;
    data.medicines.forEach((reminder) => {
        if (reminder.date !== todayKey() || reminder.taken || reminder.status === "missed") return;
        const dueAt = scheduledTimestamp(reminder);
        const isDueNow = Math.abs(now - dueAt) <= REMINDER_GRACE_MS;
        const snoozeDue = reminder.snoozedUntil && reminder.snoozedUntil <= now;
        if (!((isDueNow || snoozeDue) && !reminder.lastAlert)) return;
        reminder.lastAlert = `${reminder.date}-${reminder.time}`;
        reminder.snoozedUntil = null;
        changed = true;
        startMissedDoseTimer(reminder, data.profile);
        showToast(`Time for ${reminder.name}`);
        playReminderAudio(reminder);
        if ("Notification" in navigator && Notification.permission === "granted") {
            try { new Notification(`Medicine reminder: ${reminder.name}`, { body: `${reminder.dosage} · ${formatTime(reminder.time)}`, silent: audioMuted() }); }
            catch (error) { console.error("Notification failed:", error); }
        }
    });
    if (changed) { saveData(data); renderReminders(data.medicines); }
}

document.addEventListener("DOMContentLoaded", () => {
    if ($("#profile-form")) {
        renderDiseaseChoices();
        renderMedicineEditor([]);
        $("#profile-form").addEventListener("submit", saveProfile);
        $("#disease-search").addEventListener("input", (event) => renderDiseaseChoices(getSelectedDiseases(), event.target.value));
        $("#medicine-search").addEventListener("input", (event) => renderMedicineSuggestions(event.target.value));
        $("#add-medicine").addEventListener("click", () => renderMedicineEditor([...collectMedicinesFromForm(), { name: "", dosage: "", frequency: 1, times: "08:00" }]));
    }
    if ($("#search-button")) $("#search-button").addEventListener("click", searchLibrary);
    if ($("#library-search")) $("#library-search").addEventListener("keydown", (event) => { if (event.key === "Enter") searchLibrary(); });
    document.querySelectorAll("[data-action='profile']").forEach((button) => button.addEventListener("click", () => { loadProfileIntoForm(); showView("profile"); }));
    if ($("#add-family-member")) { $("#add-family-member").addEventListener("click", () => renderFamilyMembers([...collectFamilyMembers(), { name: "", relationship: "", email: "" }])); renderFamilyMembers(readData().profile?.familyMembers || []); }
    document.querySelectorAll("[data-action='dashboard']").forEach((button) => button.addEventListener("click", (event) => { event.preventDefault(); showView("dashboard"); }));
    initializeEmailJS();
    if ($("#mute-audio")) { $("#mute-audio").checked = localStorage.getItem("smartMedicineMuteAudio") === "true"; $("#mute-audio").addEventListener("change", (event) => { const muted = event.target.checked; localStorage.setItem("smartMedicineMuteAudio", String(muted)); const data = readData(); if (data.profile) { data.profile.muteAudio = muted; saveData(data); window.smartMedicineCloud?.updateProfile(data.profile.patientId, { muteAudio: muted }).catch((error) => console.error("Mute setting sync failed:", error)); } if (muted) stopAllReminderAudio(); }); }
    if ($("#settings-button")) { $("#settings-button").addEventListener("click", () => { const data = readData(); $("#settings-panel").classList.remove("hidden"); $("#settings-language").value = data.profile?.preferredLanguage || "en-US"; $("#voice-confirmation-enabled").checked = data.voiceConfirmationEnabled !== false; $("#normal-email-enabled").checked = data.normalReminderEmails !== false; if ($("#test-mode-enabled")) $("#test-mode-enabled").checked = localStorage.getItem(TEST_MODE_KEY) === "true"; }); $("#settings-close").addEventListener("click", () => $("#settings-panel").classList.add("hidden")); $("#settings-language").addEventListener("change", (event) => { const data = readData(); if (data.profile) { data.profile.preferredLanguage = event.target.value; saveData(data); window.smartMedicineCloud?.updateProfile(data.profile.patientId, { preferredLanguage: event.target.value }).catch(() => showToast("Language saved locally; Firebase sync failed")); } }); $("#voice-confirmation-enabled").addEventListener("change", (event) => { const data = readData(); data.voiceConfirmationEnabled = event.target.checked; saveData(data); }); $("#normal-email-enabled").addEventListener("change", (event) => { const data = readData(); data.normalReminderEmails = event.target.checked; saveData(data); }); if ($("#test-mode-enabled")) $("#test-mode-enabled").addEventListener("change", (event) => localStorage.setItem(TEST_MODE_KEY, String(event.target.checked))); $("#send-test-email").addEventListener("click", () => { const data = readData(); const recipient = alertRecipients(data.profile || {})[0]; if (!recipient) { showToast("Add a family member email before testing."); return; } sendMedicineAlert(recipient.email, recipient.name, data.profile.name, "Test medicine", "08:00", "Test Alert").catch(() => { }); }); }
    if ($("#voice-confirm-button")) $("#voice-confirm-button").addEventListener("click", () => { const next = readData().medicines?.find((reminder) => !reminder.taken); if (next) startVoiceConfirmation(next); else showToast("No pending reminder to confirm."); });
    const loadVoices = () => { availableVoices = window.speechSynthesis?.getVoices() || []; $("#voice-select").innerHTML = '<option value="">System default</option>' + availableVoices.map((voice) => `<option value="${escapeHtml(voice.name)}">${escapeHtml(voice.name)} (${escapeHtml(voice.lang)})</option>`).join(""); };
    loadVoices();
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = loadVoices;
    if ($("#speech-language")) {
        $("#speech-language").value = speechRecognitionLanguage;
        $("#speech-language").addEventListener("change", (event) => changeSpeechLanguage(event.target.value));
    }
    document.addEventListener("visibilitychange", () => { if (!document.hidden) syncServerState(); });
    requestNotificationPermission();
    if (reminderIntervalId) window.clearInterval(reminderIntervalId);
    if (serverSyncIntervalId) window.clearInterval(serverSyncIntervalId);
    restoreActiveReminders();
    reminderIntervalId = window.setInterval(checkReminders, 30000);
    serverSyncIntervalId = window.setInterval(syncServerState, 15000);
    syncServerState();
    if ($("#dashboard-view")) { if (readData().profile) showView("dashboard"); else window.location.href = "index.html"; }
});
