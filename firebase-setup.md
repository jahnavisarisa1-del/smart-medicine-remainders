# Smart Medicine Reminder setup

Run `npm.cmd install`, then `npm.cmd start`, and open `http://localhost:3000/index.html`. Opening `index.html` directly works with localStorage, but Firebase, service workers, EmailJS, and cross-origin notification services require HTTP or HTTPS.

## Firebase Spark

1. Create a Firebase project and register a Web app.
2. Enable Email/Password Authentication.
3. Create Firestore and deploy `firestore.rules`.
4. Copy the web config into `firebase-config.js`.
5. Patients create an account through `patient-login.html`, complete their profile, and receive a patient ID equal to their Firebase Auth UID.
6. Caregivers use `caregiver-login.html`; signup links their UID only when their email is listed in the patient's `familyMembers` array. `caregiver-dashboard.html` listens with Firestore `onSnapshot`.

Firebase browser configuration is safe to ship, but Firestore rules are the security boundary. Firebase Spark quotas apply.

## EmailJS

Create an EmailJS account, connect Gmail or Outlook, create a template using `to_email`, `patient_name`, `medicine_name`, `dosage`, `scheduled_time`, and `alert_type`, then put Service ID, Template ID, and Public Key in `notification-config.js`. EmailJS advertises 200 emails/month on its free plan; check current limits.

## Browser limitations

Notifications, speech, and Web Audio require permission and browser support. A fully closed browser cannot run JavaScript timers; keep the app open or install the PWA. Installed PWAs are more reliable on Android; iOS has stricter background and notification limitations.
