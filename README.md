# Smart Medicine Reminder

A vanilla HTML/CSS/JavaScript medicine reminder with a Node/Express scheduler and optional Firebase Auth/Firestore realtime family dashboard.

## Run locally

1. Install Node.js 18 or newer.
2. In this folder run `npm.cmd install`.
3. Copy `.env.example` to `.env` and configure either free Gmail SMTP or the EmailJS values.
4. Run `npm.cmd start`.
5. Open `http://localhost:3000/index.html`.

The Node process owns the missed-dose sweep. It must remain running for automatic server-side alerts. The browser adds notifications, speech, audio, and voice confirmation when supported.

## Free email setup

Gmail SMTP uses a normal free `@gmail.com` account. Enable 2-Step Verification in Google Account, open App passwords, create a password named `Smart Medicine Reminder`, and put the generated 16-character value in `GMAIL_APP_PASSWORD`. Do not use the normal Gmail password and do not commit `.env`.

If Gmail SMTP is not configured, the backend can use the configured EmailJS free-tier service. The browser integration is already configured in `notification-config.js` and uses the exact template fields required by the project.

## Firebase setup

1. Create a Firebase project on the Spark free plan and register a Web app.
2. Enable Email/Password Authentication.
3. Create Firestore in production mode.
4. Copy the Web SDK values into `firebase-config.js`.
5. Deploy rules with `firebase deploy --only firestore:rules`.
6. Patients create an Email/Password account at `patient-login.html`; their profile is stored in `patients/{patientUID}`. Family members sign up through `caregiver-login.html` using that patient ID.

Firebase Hosting is static hosting only. Deploy the frontend with `firebase init hosting` and `firebase deploy --only hosting`; deploy `server.js` separately on a free Node host and set the frontend `SMART_MEDICINE_API` value to that API URL when needed.

## Free-only service policy

This project uses Firebase free tier, browser Web Notifications/Web Audio/Web Speech, free Gmail SMTP via an App Password, and the EmailJS free tier. It does not use paid SMS, calling, or paid email APIs. Free-tier quotas and hosting availability still apply, so test with real devices before unattended use.

## Safety

The library is educational only. Medicine names, doses, and schedules must be confirmed with a clinician or pharmacist. Browser speech and notifications vary by browser, microphone, permissions, and background restrictions; the manual confirmation button remains available.
