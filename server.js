/* FREE SERVICES ONLY: Firebase Auth/Firestore, EmailJS free tier, Web
    Notifications, Web Audio, Web Speech, and free hosting. No paid SMS,
    calling, or paid email API is used by this backend.

    Smart Medicine Reminder backend
  Setup:
  1. Install Node.js 18+ and run: npm install
  2. Create .env from .env.example.
  3. Run: npm start, then open http://localhost:3000.

  The browser can be closed: this server owns the schedule and checks it every
  minute. A fully stopped server cannot execute timers. The frontend remains
  useful offline, but production alerts require this process to stay running.
*/

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const nodemailer = require("nodemailer");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "smart-medicine.json");
const STATIC_ROOT = __dirname;

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(STATIC_ROOT));

const mailTransport = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } })
    : null;

function emptyStore() {
    return { profile: null, profiles: {}, reminders: [], alertLogs: [], escalationKeys: [] };
}

function readStore() {
    try {
        if (!fs.existsSync(DATA_FILE)) return emptyStore();
        return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch (error) {
        console.error("Could not read data store:", error.message);
        return emptyStore();
    }
}

function writeStore(store) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temporary = `${DATA_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2), "utf8");
    fs.renameSync(temporary, DATA_FILE);
}

function requiredText(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function validateProfile(body) {
    const profile = body.profile || body;
    const medicines = body.medicines || body.reminders || profile.medicines || [];
    if (!requiredText(profile.name) || !requiredText(profile.age) || !requiredText(profile.gender)) return "Patient name, age, and gender are required.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.caregiverEmail || "")) return "Caregiver email must be valid.";
    if (!Array.isArray(profile.diseases) || profile.diseases.length === 0) return "At least one disease is required.";
    if (!Array.isArray(medicines) || medicines.length === 0) return "At least one medicine is required.";
    for (const medicine of medicines) {
        if (!requiredText(medicine.name) || !requiredText(medicine.dosage) || !requiredText(medicine.time)) return "Each medicine needs a name, dosage, and time.";
    }
    return null;
}

function normalizeReminder(reminder, profile) {
    const time = String(reminder.time || "").slice(0, 5);
    return {
        id: reminder.id || crypto.randomUUID(),
        name: String(reminder.name).trim(),
        dosage: String(reminder.dosage || "").trim(),
        notes: String(reminder.notes || "").trim(),
        time,
        date: reminder.date || new Date().toISOString().slice(0, 10),
        taken: Boolean(reminder.taken),
        takenAt: reminder.takenAt || null,
        missedAlerted: Boolean(reminder.missedAlerted),
        status: reminder.status || (reminder.taken ? "taken" : "pending"),
        confirmedVia: reminder.confirmedVia || null
    };
}

function reminderKey(reminder) {
    return `${reminder.date}|${reminder.id}`;
}

function reminderDueAt(reminder) {
    const [year, month, day] = String(reminder.date).split("-").map(Number);
    const [hours, minutes] = String(reminder.time).split(":").map(Number);
    return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

function emailRecipients(profile) {
    const recipients = (profile?.familyMembers || []).map((member) => member.email).filter(Boolean);
    if (!recipients.length && profile?.caregiverEmail) recipients.push(profile.caregiverEmail);
    return [...new Set(recipients)];
}

async function sendEmailMessage(recipientEmail, subject, message) {
    if (mailTransport) {
        return mailTransport.sendMail({ from: process.env.MAIL_FROM || process.env.GMAIL_USER, to: recipientEmail, subject, text: message });
    }
    const serviceId = process.env.EMAILJS_SERVICE_ID;
    const templateId = process.env.EMAILJS_TEMPLATE_ID;
    const publicKey = process.env.EMAILJS_PUBLIC_KEY;
    if (!serviceId || !templateId || !publicKey) {
        throw new Error("Gmail SMTP or EmailJS server credentials are not configured");
    }

    const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            service_id: serviceId,
            template_id: templateId,
            user_id: publicKey,
            template_params: {
                to_email: recipientEmail,
                to_name: "Family caregiver",
                patient_name: "Smart Medicine patient",
                medicine_name: subject,
                scheduled_time: "See message",
                alert_type: message
            }
        })
    });
    if (!response.ok) throw new Error(`EmailJS returned ${response.status}`);
    return { sent: true };
}

async function sendEscalationEmail(profile, reminder) {
    const recipients = emailRecipients(profile);
    if (!recipients.length) throw new Error("No family recipient email is configured");
    const subject = `URGENT: Missed medicine dose for ${profile.name}`;
    const message = `${profile.name} did not confirm ${reminder.name} (${reminder.dosage || "prescribed dose"}) at ${reminder.time}. Please check on them.`;
    return Promise.all(recipients.map((recipient) => sendEmailMessage(recipient, subject, message)));
}

async function processMissedReminders() {
    const store = readStore();
    const profile = store.profile;
    if (!profile) return;
    const now = Date.now();
    store.escalationKeys = Array.isArray(store.escalationKeys) ? store.escalationKeys : [];
    let changed = false;

    for (const reminder of store.reminders) {
        const key = reminderKey(reminder);
        const status = reminder.status || (reminder.taken ? "taken" : "pending");
        const overdue = status === "pending" && !reminder.taken && now >= reminderDueAt(reminder) + 5 * 60 * 1000;
        if (!overdue || store.escalationKeys.includes(key)) continue;

        reminder.status = "missed";
        reminder.missedAlerted = true;
        store.escalationKeys.push(key);
        store.alertLogs = Array.isArray(store.alertLogs) ? store.alertLogs : [];
        store.alertLogs.push({ key, channel: "email", status: "queued", medicine: reminder.name, timestamp: new Date().toISOString() });
        changed = true;
        writeStore(store);

        try {
            await sendEscalationEmail(profile, reminder);
            store.alertLogs.push({ key, channel: "email", status: "sent", medicine: reminder.name, timestamp: new Date().toISOString() });
        } catch (error) {
            console.error(`Could not send escalation for ${reminder.name}:`, error.message);
            store.alertLogs.push({ key, channel: "email", status: "failed", medicine: reminder.name, timestamp: new Date().toISOString() });
        }
        writeStore(store);
    }
    if (changed) console.log("Missed-dose sweep complete");
}

app.get("/api/health", (req, res) => res.json({ ok: true, serverTime: new Date().toISOString() }));

app.get("/api/state", (req, res) => res.json(readStore()));

app.post("/api/send-email", async (req, res) => {
    const { recipientEmail, subject, message } = req.body || {};
    if (!requiredText(recipientEmail) || !requiredText(subject) || !requiredText(message)) return res.status(400).json({ success: false, error: "recipientEmail, subject, and message are required" });
    try {
        await sendEmailMessage(recipientEmail, subject, message);
        const store = readStore();
        store.alertLogs = Array.isArray(store.alertLogs) ? store.alertLogs : [];
        store.alertLogs.push({ channel: "email", status: "sent", recipientEmail, subject, timestamp: new Date().toISOString() });
        writeStore(store);
        res.json({ success: true });
    } catch (error) {
        console.error("Email send failed:", error.message);
        const store = readStore();
        store.alertLogs = Array.isArray(store.alertLogs) ? store.alertLogs : [];
        store.alertLogs.push({ channel: "email", status: "failed", recipientEmail, subject, error: error.message, timestamp: new Date().toISOString() });
        writeStore(store);
        res.status(502).json({ success: false, error: "Email could not be sent" });
    }
});

app.get("/api/patient-profile", (req, res) => {
    const firebaseUid = String(req.query.firebase_uid || "").trim();
    const email = String(req.query.email || "").trim().toLowerCase();
    const identityKey = firebaseUid || email;
    const store = readStore();
    const profile = store.profiles?.[identityKey] || (store.profile && (!firebaseUid || store.profile.firebase_uid === firebaseUid) && (!email || store.profile.email === email) ? store.profile : null);
    if (!profile) return res.status(404).json({ success: false, error: "Profile not found" });
    const reminders = store.profiles?.[identityKey] ? (store.reminders || []) : [];
    res.json({ success: true, profile, reminders });
});

app.post("/api/patient-profile", (req, res) => {
    const error = validateProfile(req.body);
    if (error) return res.status(400).json({ success: false, error });
    const firebaseUid = String(req.body.firebase_uid || req.body.profile?.firebase_uid || "").trim();
    const email = String(req.body.email || req.body.profile?.email || "").trim().toLowerCase();
    if (!firebaseUid && !email) return res.status(400).json({ success: false, error: "firebase_uid or email is required" });
    const identityKey = firebaseUid || email;
    const profile = { ...req.body.profile, firebase_uid: firebaseUid || null, email: email || null, patientId: firebaseUid || email, updatedAt: new Date().toISOString() };
    const store = readStore();
    store.profiles = store.profiles || {};
    store.profiles[identityKey] = profile;
    store.profile = profile;
    store.reminders = (req.body.reminders || req.body.medicines || profile.medicines).map((reminder) => normalizeReminder(reminder, profile));
    writeStore(store);
    res.json({ success: true, profile, reminders: store.reminders });
});

app.post("/api/mark-taken", (req, res) => {
    const { reminderId } = req.body;
    const store = readStore();
    const reminder = store.reminders.find((item) => item.id === reminderId);
    if (!reminder) return res.status(404).json({ success: false, error: "Reminder not found" });
    reminder.taken = true;
    reminder.takenAt = new Date().toISOString();
    reminder.status = "taken";
    reminder.confirmedVia = req.body.confirmedVia === "voice" ? "voice" : "button";
    reminder.escalationAcknowledged = true;
    writeStore(store);
    res.json({ success: true, reminder });
});

app.post("/api/medicine-confirmation", (req, res) => {
    const { medicine_id: medicineId, patient_id: patientId, status, confirmed_at: confirmedAt } = req.body || {};
    if (!requiredText(medicineId) || !requiredText(patientId) || !["taken", "not_taken"].includes(status)) return res.status(400).json({ success: false, error: "medicine_id, patient_id, and a valid status are required" });
    const store = readStore();
    const reminder = store.reminders.find((item) => item.id === medicineId);
    if (!reminder) return res.status(404).json({ success: false, error: "Medicine reminder not found" });
    const timestamp = confirmedAt && !Number.isNaN(Date.parse(confirmedAt)) ? new Date(confirmedAt).toISOString() : new Date().toISOString();
    reminder.patientId = patientId;
    reminder.status = status;
    reminder.taken = status === "taken";
    reminder.takenAt = reminder.taken ? timestamp : null;
    reminder.confirmedAt = timestamp;
    reminder.confirmedVia = "voice";
    reminder.escalationAcknowledged = reminder.taken;
    writeStore(store);
    res.json({ success: true, medicine_id: medicineId, patient_id: patientId, status, confirmed_at: timestamp });
});

app.post("/api/mark-missed", (req, res) => {
    const { reminderId } = req.body;
    const store = readStore();
    const reminder = store.reminders.find((item) => item.id === reminderId);
    if (!reminder) return res.status(404).json({ success: false, error: "Reminder not found" });
    reminder.status = "missed";
    reminder.missedAlerted = true;
    store.escalationKeys = Array.isArray(store.escalationKeys) ? store.escalationKeys : [];
    const key = reminderKey(reminder);
    if (!store.escalationKeys.includes(key)) store.escalationKeys.push(key);
    writeStore(store);
    res.json({ success: true, reminder });
});

cron.schedule("* * * * *", () => processMissedReminders().catch((error) => console.error("Missed-dose sweep failed:", error.message)), { timezone: process.env.CRON_TIMEZONE || "UTC" });
processMissedReminders().catch((error) => console.error("Initial missed-dose sweep failed:", error.message));

app.listen(PORT, () => console.log(`Smart Medicine Reminder running at http://localhost:${PORT}`));
