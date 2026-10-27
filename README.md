# Miracle School Result Portal

## Run locally

1. Install Node.js 20 or newer from [nodejs.org](https://nodejs.org/) and reopen PowerShell.
2. In PowerShell, go to this project folder and run the setup script:

   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   .\setup.ps1
   ```

   The first run generates the reset-code secret, installs the packages, and starts the server. It does not overwrite an existing `.env`.
3. Open `http://localhost:3000/admin`. Keep the PowerShell window open while using the portal; press **Ctrl+C** to stop the server.
4. If this is a new database, create the one-time admin account with the school's email and a password of at least 12 characters on the Admin Portal page. The form signs in the new admin and cannot be used again once the account exists.
5. To enable password-reset emails, edit `.env` and replace the example SMTP values with the host, port, username, and password from your email provider. Do not put credentials in `index.html`.

You can also run the setup steps manually:

   ```powershell
   Copy-Item .env.example .env
   # Edit .env: set a random RESET_CODE_SECRET (at least 24 characters).
   # Leave ADMIN_EMAIL and ADMIN_PASSWORD empty to create the first admin in the browser.
   npm install
   npm start
   ```

The Node server creates the SQLite database and its tables automatically on first start at `.private/miracle-school.sqlite`. The first admin account is created from the Admin Portal setup form when the database has no admin account. Existing databases keep their saved administrator account. The `.private` folder and `.env` are excluded from source control. Back up the `.private` folder to preserve the database. Do not open `index.html` directly when using email resets or shared results; those need the server API.

If the browser says **Cannot GET /admin**, it is likely connected to a static server such as VS Code Live Server instead of this Node app. Start the app with `npm start` and use `http://localhost:3000/admin`; the Admin and Teacher routes are handled by `server.js`.

## Deploy on Render

GitHub Pages cannot run Node.js or `server.js`. This project includes a `render.yaml` Blueprint for a Node web service with a persistent disk for the SQLite database. The persistent disk requires a paid Render service; do not remove it or store the database on the temporary application filesystem.

1. Put the complete project, including `server.js`, `package.json`, `package-lock.json`, `index.html`, `student.html`, the `image` folder, and `render.yaml`, in a GitHub repository. Do not upload `.env`, `.private`, or database files.
2. In Render, create a new **Blueprint** and connect that repository. Review the Blueprint and deploy the `miracle-school-portal` service.
3. Wait for the service health check to pass, then open the Render service URL with `/admin` (for example, `https://your-service.onrender.com/admin`). Create the first admin account there. Use `/student` for the student portal. Do not use the GitHub Pages URL for signing in or creating accounts.
4. If you use password reset or parent-result emails, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` as secret/environment variables in the Render service settings. For WhatsApp result PDFs, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_WHATSAPP_FROM`; Render provides `RENDER_EXTERNAL_URL` for the short-lived PDF link. Never commit provider credentials.

The Blueprint stores SQLite at `/var/data/miracle-school.sqlite`; the disk survives application restarts and redeploys. Keep the service and disk in the same deployment, and maintain separate backups. Moving an existing database from a previous host requires a secure database migration; a new Render disk starts with a new database and admin setup.

The administrator creates individual teacher accounts from **Admin: Teachers** in the portal. Teacher passwords must be at least 8 characters. Reset codes are emailed to the account's registered email, expire after 10 minutes, and can only be used once. A password reset signs that account out on all devices. Keep `.env` and `.private` private.

When the site opens, a short welcome animation leads to the portal chooser. **Admin Portal** (`/admin`), **Teacher Portal** (`/teacher`), and **Student Portal** (`/student`) each have a separate sign-in page when no matching staff session is active. Admin and teacher sign-ins use separate role-checked accounts; a teacher account cannot sign into the admin portal, and an admin account cannot sign into the teacher portal. Staff sessions remain saved until logout. Opening the other staff portal signs out the current role and displays the selected portal's sign-in form. The Teacher Portal contains result entry, result search, and subject tools; only teacher accounts can create or import academic results. The Admin Portal contains school management controls for teachers, students, fees, payments, and result releases. Use **All Portals** or log out to return to the portal chooser.

The administrator creates each teacher account with a unique username (3-32 letters, numbers, dots, underscores, or hyphens), an email address, and a password of at least 8 characters. Teachers can sign in to the shared result portal using either their username or email. The email is used for password-reset codes. Existing accounts keep working with their email as their initial username after the database upgrade. The administrator can view accounts, disable or re-enable access, and remove accounts. Disabling or removing an account ends its active sessions. Sign-in uses a protected HTTP-only cookie backed by a session record in SQLite; the session remains valid across browser and server restarts until the teacher logs out, the administrator disables/removes the account, or the password is reset. The cookie is renewed during use and expires after one year without activity. Opening the file directly uses a local-only demo and does not connect to the shared database or administrator controls.

## Student portal, fees, and payments

- In Node-hosted mode, open `/student` for the separate student portal. Only admins can create student accounts. They can create a student individually in **Create a Student Portal Account**, setting the student ID and password, or import the school roster from CSV. Required CSV headings are `studentId`, `name`, `class`, and `guardianEmail`; `guardianPhone` is optional. Add an optional `studentPassword` column (at least 8 characters) to set initial passwords in bulk. Leaving it blank preserves any existing password. Re-importing updates roster details while preserving student passwords and finance records.
- Students sign in with the student ID and password created by the admin. Passwords are stored as hashes, not readable text. Keep credential CSV files private and delete them securely after distributing student credentials. Students can request a password setup/reset code at the guardian email in the roster; codes expire after 10 minutes, and setting/resetting the password ends that student's other sessions.
- Admins set a class fee for each session/term; a per-student fee override can be used when needed. Amounts are in Nigerian naira (NGN). The admin dashboard shows roster count, configured fees, total due, approved payments, pending claims, and outstanding balance for the selected session/term.
- This version does **not** take online card or bank payments. A student pays through the school's independently provided payment channel and submits the amount plus transfer/receipt reference. The claim stays pending and does not reduce the balance until an admin checks the school payment records and approves it. Admins may also enter payments they have independently confirmed. References must be unique; rejected claims do not affect balances.
- Teachers can save results as usual, but results are hidden from student accounts until an admin releases them. Release is enforced by the server and is blocked until the configured fee for that student/session is fully covered by approved payments. Editing a result hides it again until it is released again.
- After release, teachers can use **Email Parent** beside a saved result to email its subject marks, grades, comments, and overall result to the guardian email on the student's active roster record. The server checks release and fee status again when sending. Configure valid `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` values in `.env`; keep credentials private.
- Teachers can use **Send WhatsApp PDF** to deliver a generated PDF of a released result to the guardian's WhatsApp number on the active student record. The server checks teacher access, result release, full approved fee payment, and the guardian's saved WhatsApp opt-in before sending; it never accepts a recipient number from the browser. Record consent using the checkbox when creating a student, or the optional `guardianWhatsAppOptIn` CSV column (`true`/`yes`/`1` to record consent; `false`/`no`/`0` to revoke; blank to keep an existing record unchanged). Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, and `PUBLIC_BASE_URL` (or use Render's `RENDER_EXTERNAL_URL`) in the private environment; `WHATSAPP_DEFAULT_COUNTRY_CODE` defaults to `+234` for local Nigerian numbers. Never commit Twilio credentials. A PDF download link is random and expires after 30 minutes. Use an approved WhatsApp media template and set `TWILIO_WHATSAPP_CONTENT_SID` for business-initiated messages outside an open 24-hour WhatsApp conversation; the template must accept the PDF URL as media variable `{{1}}`. Without a template, Twilio can send the PDF only during an open conversation window.
- Student accounts, fee schedules, overrides, payment claims, approved payments, and result-release status use the same SQLite database at `DATABASE_PATH`. Back up the host's persistent database volume regularly; the **Download Results Backup** feature only backs up academic results, not the student roster or finance ledger.

## CBT exams

- Admins create exams from **CBT Exams**. Assign each teacher to a class from **Admin: Teachers**; a teacher can view answer reports only for that assigned class.
- Download the question CSV template and fill it in a spreadsheet or word processor that can export CSV. Required columns are `type`, `question`, and `mark`. Objective rows require `optionA`, `optionB`, `optionC`, `optionD`, and `correctAnswer` (A, B, C, or D). Theory rows can include an `answerGuide`. Quote CSV cells containing commas or line breaks.
- Set the scheduled start, one total exam duration in hours and minutes, and a four-digit numeric access code of your choice. Objective and theory questions share this timer; the timer starts at the scheduled start. Students in the matching class see the exam in `/student`, but cannot start before the scheduled time. Admins can choose a replacement code before the exam starts. Students are limited to five code attempts per 15 minutes.
- Student answers autosave for both objective and theory questions. Theory questions and responses remain private and are never included in teacher reports. The answer key is not available to students.
- After the scheduled exam ends, only objective questions, answer keys, and students' selected objective answers are available in the **CBT Exams** score sheet for teachers assigned to that class. Teachers enter a score for every objective question; the portal validates each score against that question's maximum and calculates the student's total out of the possible marks. Theory questions, responses, and answer guides are excluded from that report.
- After the exam ends, it is removed from the student's available exam list. Teachers can review and update saved objective scores from their class-scoped report.
- Exam questions, answer keys, access-code hashes, and attempts are stored in the same persistent SQLite database as the student roster. Include that database in your normal secure backup process.

## Teacher attendance

- Teachers open **Attendance** in the Teacher Portal to manage the saved roster for their assigned class. Ask the administrator to assign a class to a teacher account before using attendance.
- Add each student by name once; the name remains on that class list for future dates. Teachers can remove a student from the list; removing the student also deletes their saved attendance history.
- Select an attendance date, then mark each student **Present** (green) or **Absent** (red). A reason is required when marking a student absent. Attendance is saved in the shared SQLite database and can be reopened by choosing the same date.
- Attendance roster and records are restricted to the signed-in teacher's assigned class.

## Result records and reports

- In Node-hosted mode, results and subjects are stored in a SQLite database at `DATABASE_PATH` (default `.private/miracle-school.sqlite`). The server stores each result by normalized student ID plus session/term, so searching by ID returns the student's saved terms. After admin release, a student signing in with that ID can see all of their released results across sessions/terms and every subject in each result; other students' records are not shown. Browser-local results are migrated into the server database at the next successful teacher sign-in; migration keeps existing server records if a matching record already exists.
- Keep `DATABASE_PATH` on a persistent disk/volume provided by the host. Ephemeral deployments can delete the SQLite file on restart/redeploy, and GitHub Pages cannot run the Node API or provide a shared database. A database file on one teacher's computer is not shared with other devices; deploy the Node server and persistent volume for multi-teacher access.
- In directly opened local-file demo mode, results and subjects are stored only in IndexedDB in that browser. Browser storage can be cleared; export regular backups from the Student Database tab. After the Node API is deployed, sign in through the hosted portal to migrate the local records to the shared database.
- Results and the configured subject list have no app-imposed student/term limit; the browser and hosting storage capacity still apply.
- The subject manager allows up to 15 subjects total (the original five plus ten additional subjects). “Browser Storage Full” means this browser has exhausted the space allocated for this site; it is separate from the subject limit. Download a results backup before freeing browser storage, as deleting site data can permanently erase local results.
- A student's result is identified by student ID and session/term. Saving the same student and term updates that result; saving another term keeps the earlier result.
- Enter the total class size with each result. It is saved with that student/session record and shown on the result PDF and WhatsApp message.
- Enter separate teacher and principal comments for each pupil. They are saved with the result, restored when loading it for exam entry, and shown on the report PDF and WhatsApp message. On the Node-hosted portal, comments are stored with the shared central result; in file/demo mode, they remain only in that browser.
- Use **Download Results Backup** regularly and keep the downloaded JSON file somewhere safe. **Restore Backup** can merge a backup; records with the same student ID and session/term are replaced by the backup copy.
- Each subject's test is out of 30 and exam is out of 70. Exam marks are optional when saving: the teacher can compute and save a test-stage result first, leaving all exam fields blank. The test-stage percentage is based on the test score alone (test score ÷ 30 × 100). For the exam period, enter the same student ID and session/term; the saved result and test marks load when the ID field loses focus or the session changes. You can also choose **Load Saved Test Result**. Fill in every exam mark, then save/update; the subject and overall percentage, grade, and remark update to the combined test + exam score out of 100. Save either all exam marks or none; mixed exam entry cannot be saved. Results show whether exams are pending or final. Test-stage PDFs and WhatsApp messages are labelled as pending exam results.
- Grades and remarks are: 70–100 A / Excellent, 60–<70 B / V.Good, 50–<60 C / Good, 40–<50 E / Pass, 30–<40 D / Fair, and below 30 F / Fail.
- **View PDF** opens the report. Choose **Download / Print PDF** and select **Save as PDF** in the browser's print dialog. The report is laid out for A4 portrait, with compact spacing and page-break rules to keep it on one sheet when it fits and prevent table rows from splitting. The browser/printer may still paginate unusually long reports. The suggested filename includes the student ID and session/term. The browser decides where the file is saved; choose the same folder in the dialog each time or set a default Downloads folder in browser settings. **Prepare WhatsApp** opens a chat with a message and the report preview; save the PDF, then attach it to that chat and send it yourself. The page does not automatically send files.

## Source-code visibility

The HTML and JavaScript must be sent to a visitor's browser to run, so they cannot be made secret or blocked from being saved from a public website. Making a GitHub repository private can limit access to the repository itself, but does not hide frontend code from visitors. Keep credentials and private data on a secured backend, not in the webpage.

GitHub Pages is static hosting and cannot run this Node server. For results shared among teachers/devices and server-side authentication, deploy the full Node app on a persistent server host and use its persistent disk for the SQLite database. Keep `.env`, `.private`, and the database file private; the site now protects database routes with the teacher sign-in session.
