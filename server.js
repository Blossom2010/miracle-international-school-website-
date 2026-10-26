require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT || 3000);
const adminEmail = (process.env.ADMIN_EMAIL || process.env.TEACHER_EMAIL || '').trim().toLowerCase();
const accountPath = path.join(__dirname, '.private', 'teacher-account.json');
const databasePath = process.env.DATABASE_PATH
    ? (path.isAbsolute(process.env.DATABASE_PATH)
        ? process.env.DATABASE_PATH
        : path.resolve(__dirname, process.env.DATABASE_PATH))
    : path.join(__dirname, '.private', 'miracle-school.sqlite');
const scrypt = promisify(crypto.scrypt);
const sessionCookieAgeSeconds = 365 * 24 * 60 * 60;
const studentSessionCookieAgeSeconds = sessionCookieAgeSeconds;
const defaultSubjects = ['Mathematics', 'English Language', 'Basic Science', 'Social Studies', 'Civic Education'];
const maxSubjects = 15;
const pendingResets = new Map();
const pendingStudentResets = new Map();
let database;

app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});
app.use('/image', express.static(path.join(__dirname, 'image'), { index: false }));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});

const adminSetupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});

const requestResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 3,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});

const completeResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});

const studentResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 3,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});

const studentResetCompleteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});

function isValidPassword(password, minimumLength = 8) {
    return typeof password === 'string' && password.length >= minimumLength && password.length <= 128;
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
    const [saltHex, hashHex] = storedHash.split(':');
    if (!saltHex || !hashHex) return false;

    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function loadAdminAccount() {
    const existingAdmin = database.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (existingAdmin) return;

    let passwordHash;
    try {
        const legacyAccount = JSON.parse(await fs.readFile(accountPath, 'utf8'));
        if (adminEmail && legacyAccount.email === adminEmail && typeof legacyAccount.passwordHash === 'string') {
            passwordHash = legacyAccount.passwordHash;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    if (!passwordHash) return;
    database.prepare('INSERT INTO users (username, email, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(adminEmail, adminEmail, passwordHash, 'admin', new Date().toISOString());
}

function createMailer() {
    const { SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
    const smtpPort = Number(process.env.SMTP_PORT || 587);
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_FROM || !Number.isInteger(smtpPort)) {
        throw new Error('Email is not configured. Set the SMTP and MAIL_FROM values in your .env file.');
    }

    return {
        from: MAIL_FROM,
        transporter: nodemailer.createTransport({
            host: SMTP_HOST,
            port: smtpPort,
            secure: process.env.SMTP_SECURE === 'true',
            auth: { user: SMTP_USER, pass: SMTP_PASS }
        })
    };
}

function normalizeStudentId(studentId) {
    return studentId.trim().toLowerCase();
}

function getRecordKey(studentId, session) {
    return JSON.stringify([normalizeStudentId(studentId), session.trim().toLowerCase()]);
}

function validateSubjects(subjects) {
    if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > maxSubjects ||
        subjects.some(subject => typeof subject !== 'string' || !subject.trim() || subject.trim().length > 100)) {
        throw new Error(`Provide between 1 and ${maxSubjects} valid subject names.`);
    }
    const normalized = subjects.map(subject => subject.trim());
    if (new Set(normalized.map(subject => subject.toLowerCase())).size !== normalized.length) {
        throw new Error('Subject names must be unique.');
    }
    return normalized;
}

function normalizeStudentKey(value) {
    return value.trim().toLowerCase();
}

function normalizeFeeSession(session) {
    return typeof session === 'string' && session.trim().length <= 100 ? session.trim() : '';
}

function validatePaymentAmount(amountKobo) {
    return Number.isSafeInteger(amountKobo) && amountKobo > 0 && amountKobo <= 100000000000;
}

function getStudentFinance(studentId, session) {
    const row = database.prepare(`
        SELECT students.student_id AS studentId, students.name, students.class_name AS className,
            students.guardian_email AS guardianEmail, students.guardian_phone AS guardianPhone,
            COALESCE(student_fee_overrides.amount_kobo, fee_schedules.amount_kobo) AS dueKobo,
            CASE WHEN student_fee_overrides.student_id IS NOT NULL OR fee_schedules.class_key IS NOT NULL THEN 1 ELSE 0 END AS feeConfigured,
            COALESCE(SUM(CASE WHEN payments.status = 'approved' THEN payments.amount_kobo ELSE 0 END), 0) AS paidKobo,
            COALESCE(SUM(CASE WHEN payments.status = 'pending' THEN payments.amount_kobo ELSE 0 END), 0) AS pendingKobo
        FROM students
        LEFT JOIN student_fee_overrides ON student_fee_overrides.student_id = students.student_id
            AND student_fee_overrides.session_key = ?
        LEFT JOIN fee_schedules ON fee_schedules.class_key = lower(trim(students.class_name))
            AND fee_schedules.session_key = ?
        LEFT JOIN payments ON payments.student_id = students.student_id AND payments.session_key = ?
        WHERE students.student_id = ? AND students.is_active = 1
        GROUP BY students.student_id
    `).get(session.toLowerCase(), session.toLowerCase(), session.toLowerCase(), studentId);
    if (!row) return undefined;
    const dueKobo = row.dueKobo === null ? null : row.dueKobo;
    return {
        ...row,
        dueKobo,
        feeConfigured: Boolean(row.feeConfigured),
        balanceKobo: dueKobo === null ? null : Math.max(0, dueKobo - row.paidKobo)
    };
}

function getFinanceRoster(session) {
    return database.prepare(`
        SELECT students.student_id AS studentId, students.name, students.class_name AS className,
            students.guardian_email AS guardianEmail, students.guardian_phone AS guardianPhone,
            COALESCE(student_fee_overrides.amount_kobo, fee_schedules.amount_kobo) AS dueKobo,
            CASE WHEN student_fee_overrides.student_id IS NOT NULL OR fee_schedules.class_key IS NOT NULL THEN 1 ELSE 0 END AS feeConfigured,
            COALESCE(SUM(CASE WHEN payments.status = 'approved' THEN payments.amount_kobo ELSE 0 END), 0) AS paidKobo,
            COALESCE(SUM(CASE WHEN payments.status = 'pending' THEN payments.amount_kobo ELSE 0 END), 0) AS pendingKobo
        FROM students
        LEFT JOIN student_fee_overrides ON student_fee_overrides.student_id = students.student_id
            AND student_fee_overrides.session_key = ?
        LEFT JOIN fee_schedules ON fee_schedules.class_key = lower(trim(students.class_name))
            AND fee_schedules.session_key = ?
        LEFT JOIN payments ON payments.student_id = students.student_id AND payments.session_key = ?
        WHERE students.is_active = 1
        GROUP BY students.student_id
        ORDER BY students.class_name, students.name
    `).all(session.toLowerCase(), session.toLowerCase(), session.toLowerCase()).map(row => ({
        ...row,
        feeConfigured: Boolean(row.feeConfigured),
        balanceKobo: row.dueKobo === null ? null : Math.max(0, row.dueKobo - row.paidKobo)
    }));
}

function getPublishedResults(studentId) {
    return database.prepare('SELECT record_json, published_at FROM results WHERE student_id = ? AND published_at IS NOT NULL ORDER BY session_name')
        .all(normalizeStudentKey(studentId))
        .map(row => ({ ...JSON.parse(row.record_json), publishedAt: row.published_at }))
        .filter(result => {
            const finance = getStudentFinance(studentId, result.session);
            return finance?.feeConfigured && finance.balanceKobo === 0;
        });
}

function normalizeResult(student) {
    if (!student || typeof student.id !== 'string' || !student.id.trim() || student.id.trim().length > 80 ||
        typeof student.name !== 'string' || !student.name.trim() || student.name.trim().length > 120 ||
        !['Male', 'Female'].includes(student.sex) ||
        typeof student.class !== 'string' || !student.class.trim() || student.class.length > 80 ||
        typeof student.phone !== 'string' || student.phone.length > 30 ||
        typeof student.session !== 'string' || !student.session.trim() || student.session.trim().length > 100 ||
        !student.scores || typeof student.scores !== 'object' || Array.isArray(student.scores)) {
        throw new Error('Student result contains invalid or missing details.');
    }

    const scores = {};
    for (const [subject, score] of Object.entries(student.scores)) {
        if (!subject.trim() || subject.length > 100 || !score ||
            !Number.isFinite(score.test) || score.test < 0 || score.test > 30 ||
            (score.exam !== null && score.exam !== undefined &&
                (!Number.isFinite(score.exam) || score.exam < 0 || score.exam > 70))) {
            throw new Error('Result scores must be within test /30 and exam /70.');
        }
        scores[subject.trim()] = { test: score.test, exam: score.exam ?? null };
    }
    if (!Object.keys(scores).length || Object.keys(scores).length > maxSubjects) {
        throw new Error(`A result must have between 1 and ${maxSubjects} subject scores.`);
    }
    const examsEntered = Object.values(scores).filter(score => score.exam !== null).length;
    if (examsEntered > 0 && examsEntered !== Object.keys(scores).length) {
        throw new Error('Enter exam marks for every subject, or leave all exam marks blank.');
    }

    const examComplete = examsEntered === Object.keys(scores).length;
    const totalMarks = Object.values(scores).reduce((total, score) =>
        total + score.test + (examComplete ? score.exam : 0), 0);
    const maxMarks = Object.keys(scores).length * (examComplete ? 100 : 30);
    const percentage = Number(((totalMarks / maxMarks) * 100).toFixed(1));
    const id = student.id.trim();
    const session = student.session.trim();
    return {
        ...student,
        recordKey: getRecordKey(id, session),
        id,
        name: student.name.trim(),
        class: student.class.trim(),
        session,
        classSize: Number.isSafeInteger(student.classSize) && student.classSize > 0 ? student.classSize : null,
        teacherComment: typeof student.teacherComment === 'string' ? student.teacherComment.slice(0, 1000) : '',
        principalComment: typeof student.principalComment === 'string' ? student.principalComment.slice(0, 1000) : '',
        scores,
        examComplete,
        totalMarks,
        maxMarks,
        percentage,
        grade: calculateGrade(percentage),
        remark: calculateRemark(percentage)
    };
}

function calculateGrade(score) {
    if (score >= 70) return 'A';
    if (score >= 60) return 'B';
    if (score >= 50) return 'C';
    if (score >= 40) return 'E';
    if (score >= 30) return 'D';
    return 'F';
}

function calculateRemark(score) {
    if (score >= 70) return 'Excellent';
    if (score >= 60) return 'V.Good';
    if (score >= 50) return 'Good';
    if (score >= 40) return 'Pass';
    if (score >= 30) return 'Fair';
    return 'Fail';
}

function saveResult(student, insertOnly = false) {
    const result = normalizeResult(student);
    const statement = insertOnly
        ? database.prepare('INSERT OR IGNORE INTO results (record_key, student_id, student_name, session_name, record_json, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        : database.prepare('INSERT INTO results (record_key, student_id, student_name, session_name, record_json, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(record_key) DO UPDATE SET student_id = excluded.student_id, student_name = excluded.student_name, session_name = excluded.session_name, record_json = excluded.record_json, updated_at = excluded.updated_at, published_at = NULL');
    statement.run(
        result.recordKey,
        normalizeStudentId(result.id),
        result.name.toLowerCase(),
        result.session.toLowerCase(),
        JSON.stringify(result),
        new Date().toISOString()
    );
    return result;
}

function requireTeacher(req, res, next) {
    return requireAccountSession(req, res, next, 'school_session', 'teacher');
}

function requireTeacherResultEditor(req, res, next) {
    if (req.user.role !== 'teacher') {
        return res.status(403).json({ error: 'Only teacher accounts can enter or change academic results.' });
    }
    return next();
}

function requireStudent(req, res, next) {
    return requireAccountSession(req, res, next, 'student_session', 'student');
}

function requireAccountSession(req, res, next, cookieName, role) {
    const token = req.cookies?.[cookieName];
    const tokenHash = token ? crypto.createHash('sha256').update(token).digest('hex') : '';
    const activeSession = role === 'student'
        ? database.prepare('SELECT student_sessions.student_id AS id, students.student_id AS studentId, students.name, students.is_active FROM student_sessions JOIN students ON students.student_id = student_sessions.student_id WHERE student_sessions.token_hash = ?')
            .get(tokenHash)
        : database.prepare('SELECT users.id, users.username, users.email, users.role, users.is_active FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id WHERE auth_sessions.token_hash = ?')
            .get(tokenHash);
    if (!activeSession || !activeSession.is_active || (role === 'teacher' && !['admin', 'teacher'].includes(activeSession.role))) {
        return res.status(401).json({ error: 'Sign in again to access school records.' });
    }
    req.user = activeSession;
    if (role === 'student') req.user.role = role;
    createSessionCookie(req, res, token, role === 'student' ? studentSessionCookieAgeSeconds : sessionCookieAgeSeconds, cookieName);
    return next();
}

function createSessionCookie(req, res, token, maxAge, cookieName = 'school_session') {
    const parts = [`${cookieName}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`];
    if (req.secure || req.get('x-forwarded-proto') === 'https') parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function initializeDatabase() {
    const directory = path.dirname(databasePath);
    require('node:fs').mkdirSync(directory, { recursive: true });
    database = new Database(databasePath);
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.exec(`
        CREATE TABLE IF NOT EXISTS results (
            record_key TEXT PRIMARY KEY,
            student_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            session_name TEXT NOT NULL,
            record_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            published_at TEXT
        );
        CREATE INDEX IF NOT EXISTS results_student_id_idx ON results(student_id);
        CREATE INDEX IF NOT EXISTS results_student_name_idx ON results(student_name);
        CREATE TABLE IF NOT EXISTS settings (
            setting_key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'teacher')),
            is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions(user_id);
        CREATE TABLE IF NOT EXISTS students (
            student_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            class_name TEXT NOT NULL,
            guardian_email TEXT NOT NULL,
            guardian_phone TEXT NOT NULL DEFAULT '',
            password_hash TEXT,
            is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS student_sessions (
            token_hash TEXT PRIMARY KEY,
            student_id TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS student_sessions_student_id_idx ON student_sessions(student_id);
        CREATE TABLE IF NOT EXISTS fee_schedules (
            class_key TEXT NOT NULL,
            session_key TEXT NOT NULL,
            class_name TEXT NOT NULL,
            session_name TEXT NOT NULL,
            amount_kobo INTEGER NOT NULL CHECK (amount_kobo >= 0),
            updated_at TEXT NOT NULL,
            PRIMARY KEY (class_key, session_key)
        );
        CREATE TABLE IF NOT EXISTS student_fee_overrides (
            student_id TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
            session_key TEXT NOT NULL,
            session_name TEXT NOT NULL,
            amount_kobo INTEGER NOT NULL CHECK (amount_kobo >= 0),
            updated_at TEXT NOT NULL,
            PRIMARY KEY (student_id, session_key)
        );
        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
            session_key TEXT NOT NULL,
            session_name TEXT NOT NULL,
            amount_kobo INTEGER NOT NULL CHECK (amount_kobo > 0),
            reference TEXT NOT NULL,
            reference_key TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
            source TEXT NOT NULL CHECK (source IN ('student', 'admin')),
            submitted_at TEXT NOT NULL,
            verified_at TEXT,
            verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS payments_student_session_idx ON payments(student_id, session_key, status);
    `);
    const resultColumns = database.pragma('table_info(results)');
    if (!resultColumns.some(column => column.name === 'published_at')) {
        database.exec('ALTER TABLE results ADD COLUMN published_at TEXT');
    }
    const userColumns = database.pragma('table_info(users)');
    if (!userColumns.some(column => column.name === 'username')) {
        database.exec('ALTER TABLE users ADD COLUMN username TEXT');
    }
    database.exec(`
        UPDATE users SET username = email WHERE username IS NULL OR trim(username) = '';
        CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_idx ON users(lower(username));
    `);
}

app.use((req, res, next) => {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(cookie => {
        const separator = cookie.indexOf('=');
        if (separator < 0) return ['', ''];
        const key = cookie.slice(0, separator).trim();
        const value = cookie.slice(separator + 1).trim();
        try {
            return [key, decodeURIComponent(value)];
        } catch {
            return [key, value];
        }
    }).filter(([key]) => key));
    req.cookies = cookies;
    next();
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get(['/admin', '/teacher'], (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/student', (req, res) => {
    res.sendFile(path.join(__dirname, 'student.html'));
});

app.get('/api/health', (req, res) => res.json({ database: 'connected' }));

app.get('/api/admin/setup-status', (req, res) => {
    const setupComplete = Boolean(database.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get());
    return res.json({ setupComplete });
});

app.post('/api/admin/setup', adminSetupLimiter, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !isValidPassword(password, 12)) {
        return res.status(400).json({ error: 'Enter a valid school email and a password of at least 12 characters.' });
    }

    try {
        const passwordHash = await hashPassword(password);
        const token = crypto.randomBytes(32).toString('hex');
        const createAdmin = database.transaction(() => {
            if (database.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
                const error = new Error('The administrator account has already been created. Sign in instead.');
                error.status = 409;
                throw error;
            }
            const result = database.prepare(`
                INSERT INTO users (username, email, password_hash, role, is_active, created_at)
                VALUES (?, ?, ?, 'admin', 1, ?)
            `).run(email, email, passwordHash, new Date().toISOString());
            database.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)')
                .run(crypto.createHash('sha256').update(token).digest('hex'), result.lastInsertRowid, new Date().toISOString());
        });
        createAdmin();
        createSessionCookie(req, res, token, sessionCookieAgeSeconds);
        return res.status(201).json({ email, role: 'admin' });
    } catch (error) {
        if (error.status === 409) return res.status(409).json({ error: error.message });
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'That school email is already in use. Contact the administrator.' });
        }
        console.error('Unable to set up administrator account:', error);
        return res.status(500).json({ error: 'Unable to create the administrator account.' });
    }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier : req.body?.email;
    const password = req.body?.password;
    if (typeof identifier !== 'string' || identifier.length > 254 || typeof password !== 'string' || password.length > 128) {
        return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    try {
        const normalizedIdentifier = identifier.trim().toLowerCase();
        const user = database.prepare('SELECT id, username, email, password_hash, role, is_active FROM users WHERE lower(email) = ? OR lower(username) = ?')
            .get(normalizedIdentifier, normalizedIdentifier);
        const matchesPassword = await verifyPassword(password, user?.password_hash || crypto.randomBytes(48).toString('hex'));
        if (!user || !matchesPassword || !user.is_active) {
            return res.status(401).json({ error: 'Invalid username/email or password.' });
        }
        const token = crypto.randomBytes(32).toString('hex');
        database.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)')
            .run(crypto.createHash('sha256').update(token).digest('hex'), user.id, new Date().toISOString());
        createSessionCookie(req, res, token, sessionCookieAgeSeconds);
        return res.sendStatus(204);
    } catch (error) {
        console.error('Login failed:', error);
        return res.status(500).json({ error: 'Unable to process login.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    if (req.cookies?.school_session) {
        database.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
            .run(crypto.createHash('sha256').update(req.cookies.school_session).digest('hex'));
    }
    createSessionCookie(req, res, '', 0);
    return res.sendStatus(204);
});

app.get('/api/auth/session', requireTeacher, (req, res) =>
    res.json({ id: req.user.id, username: req.user.username, email: req.user.email, role: req.user.role })
);

app.patch('/api/admin/password', requireTeacher, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });

    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        return res.status(400).json({ error: 'Enter your current password and a new password.' });
    }
    if (!isValidPassword(newPassword, 8)) {
        return res.status(400).json({ error: 'Your new password must be at least 8 characters long.' });
    }

    try {
        const user = database.prepare('SELECT id, password_hash FROM users WHERE id = ? AND role = ?').get(req.user.id, 'admin');
        if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
            return res.status(401).json({ error: 'Your current password is incorrect.' });
        }
        database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(newPassword), req.user.id);
        database.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(req.user.id);
        return res.sendStatus(204);
    } catch (error) {
        console.error('Unable to update admin password:', error);
        return res.status(500).json({ error: 'Unable to update the admin password.' });
    }
});

app.post('/api/student/auth/login', loginLimiter, async (req, res) => {
    const studentId = typeof req.body?.studentId === 'string' ? normalizeStudentKey(req.body.studentId) : '';
    const password = req.body?.password;
    if (!studentId || typeof password !== 'string' || password.length > 128) {
        return res.status(401).json({ error: 'Invalid student ID or password.' });
    }
    try {
        const student = database.prepare('SELECT student_id, password_hash, is_active FROM students WHERE student_id = ?')
            .get(studentId);
        const passwordMatches = await verifyPassword(
            password,
            student?.password_hash || crypto.randomBytes(48).toString('hex')
        );
        if (!student || !student.is_active || !student.password_hash || !passwordMatches) {
            return res.status(401).json({ error: 'Invalid student ID or password.' });
        }
        const token = crypto.randomBytes(32).toString('hex');
        database.prepare('INSERT INTO student_sessions (token_hash, student_id, created_at) VALUES (?, ?, ?)')
            .run(crypto.createHash('sha256').update(token).digest('hex'), student.student_id, new Date().toISOString());
        createSessionCookie(req, res, token, studentSessionCookieAgeSeconds, 'student_session');
        return res.sendStatus(204);
    } catch (error) {
        console.error('Student login failed:', error);
        return res.status(500).json({ error: 'Unable to process student sign-in.' });
    }
});

app.post('/api/student/auth/logout', (req, res) => {
    if (req.cookies?.student_session) {
        database.prepare('DELETE FROM student_sessions WHERE token_hash = ?')
            .run(crypto.createHash('sha256').update(req.cookies.student_session).digest('hex'));
    }
    createSessionCookie(req, res, '', 0, 'student_session');
    return res.sendStatus(204);
});

app.post('/api/student/auth/request-reset', studentResetLimiter, async (req, res) => {
    const studentId = typeof req.body?.studentId === 'string' ? normalizeStudentKey(req.body.studentId) : '';
    if (!studentId) return res.status(400).json({ error: 'Enter a valid student ID.' });
    const student = database.prepare('SELECT student_id, guardian_email FROM students WHERE student_id = ? AND is_active = 1')
        .get(studentId);
    if (!student?.guardian_email) return res.json({ message: 'If the student account is registered, a password setup code has been sent to its guardian email.' });
    try {
        const { transporter, from } = createMailer();
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        const secret = process.env.RESET_CODE_SECRET;
        pendingStudentResets.set(student.student_id, {
            codeHash: crypto.createHmac('sha256', secret).update(code).digest('hex'),
            expiresAt: Date.now() + 10 * 60 * 1000,
            attempts: 0
        });
        await transporter.sendMail({
            from,
            to: student.guardian_email,
            subject: 'Your Miracle School student password code',
            text: `The password setup/reset code for student ID ${student.student_id} is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`
        });
        return res.json({ message: 'If the student account is registered, a password setup code has been sent to its guardian email.' });
    } catch (error) {
        pendingStudentResets.delete(student.student_id);
        console.error('Student password email failed:', error);
        return res.status(503).json({ error: 'Unable to send the student password code. Check the server email configuration.' });
    }
});

app.post('/api/student/auth/reset-password', studentResetCompleteLimiter, async (req, res) => {
    const studentId = typeof req.body?.studentId === 'string' ? normalizeStudentKey(req.body.studentId) : '';
    const { code, password } = req.body || {};
    if (!studentId || typeof code !== 'string' || !/^\d{6}$/.test(code) || !isValidPassword(password)) {
        return res.status(400).json({ error: 'Enter a valid student ID, six-digit code, and password of at least 8 characters.' });
    }
    const pendingReset = pendingStudentResets.get(studentId);
    const student = database.prepare('SELECT student_id FROM students WHERE student_id = ? AND is_active = 1').get(studentId);
    if (!pendingReset || pendingReset.expiresAt <= Date.now() || !student) {
        pendingStudentResets.delete(studentId);
        return res.status(400).json({ error: 'Invalid or expired password code.' });
    }
    const secret = process.env.RESET_CODE_SECRET;
    const submittedHash = crypto.createHmac('sha256', secret).update(code).digest();
    const expectedHash = Buffer.from(pendingReset.codeHash, 'hex');
    pendingReset.attempts += 1;
    if (!crypto.timingSafeEqual(submittedHash, expectedHash)) {
        if (pendingReset.attempts >= 5) pendingStudentResets.delete(studentId);
        return res.status(400).json({ error: 'Invalid or expired password code.' });
    }
    try {
        database.prepare('UPDATE students SET password_hash = ? WHERE student_id = ?')
            .run(await hashPassword(password), studentId);
        database.prepare('DELETE FROM student_sessions WHERE student_id = ?').run(studentId);
        pendingStudentResets.delete(studentId);
        return res.sendStatus(204);
    } catch (error) {
        console.error('Student password update failed:', error);
        return res.status(500).json({ error: 'Unable to save the student password.' });
    }
});

app.get('/api/student/portal', requireStudent, (req, res) => {
    const session = normalizeFeeSession(req.query.session);
    if (!session) return res.status(400).json({ error: 'Enter a valid session/term.' });
    const finance = getStudentFinance(req.user.studentId, session);
    if (!finance) return res.status(401).json({ error: 'Student account is unavailable.' });
    const payments = database.prepare(`
        SELECT id, session_name AS session, amount_kobo AS amountKobo, reference, status, submitted_at AS submittedAt, verified_at AS verifiedAt
        FROM payments WHERE student_id = ? AND session_key = ? ORDER BY submitted_at DESC
    `).all(req.user.studentId, session.toLowerCase());
    return res.json({ ...finance, session, payments, results: getPublishedResults(req.user.studentId) });
});

app.post('/api/student/payments', requireStudent, (req, res) => {
    const session = normalizeFeeSession(req.body?.session);
    const amountKobo = req.body?.amountKobo;
    const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim() : '';
    if (!session || !validatePaymentAmount(amountKobo) || !reference || reference.length > 120) {
        return res.status(400).json({ error: 'Provide a session/term, positive payment amount, and transfer/receipt reference.' });
    }
    try {
        const result = database.transaction(() => {
            const finance = getStudentFinance(req.user.studentId, session);
            if (!finance?.feeConfigured) {
                const error = new Error('The school fee for this session has not been set. Contact the school office.');
                error.status = 400;
                throw error;
            }
            const remainingClaimable = Math.max(0, finance.balanceKobo - finance.pendingKobo);
            if (amountKobo > remainingClaimable) {
                const error = new Error('The claim is greater than the remaining unpaid amount.');
                error.status = 400;
                throw error;
            }
            return database.prepare(`
                INSERT INTO payments (student_id, session_key, session_name, amount_kobo, reference, reference_key, status, source, submitted_at)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', 'student', ?)
            `).run(
                req.user.studentId,
                session.toLowerCase(),
                session,
                amountKobo,
                reference,
                reference.toLowerCase(),
                new Date().toISOString()
            );
        })();
        return res.status(201).json({ id: result.lastInsertRowid, status: 'pending' });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That payment reference has already been submitted.' });
        if (error.status === 400) return res.status(400).json({ error: error.message });
        console.error('Unable to submit student payment claim:', error);
        return res.status(500).json({ error: 'Unable to submit payment claim.' });
    }
});

app.get('/api/admin/teachers', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const teachers = database.prepare(`
        SELECT users.id, users.username, users.email, users.is_active AS isActive, users.created_at AS createdAt,
            COUNT(auth_sessions.token_hash) AS activeSessions
        FROM users LEFT JOIN auth_sessions ON auth_sessions.user_id = users.id
        WHERE users.role = 'teacher'
        GROUP BY users.id ORDER BY users.email
    `).all();
    return res.json(teachers);
});

app.post('/api/admin/teachers', requireTeacher, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !isValidPassword(password)) {
        return res.status(400).json({ error: 'Enter a username (3-32 letters, numbers, dots, underscores, or hyphens), a valid email, and a password of at least 8 characters.' });
    }
    const accountConflict = database.prepare(`
        SELECT 1 FROM users
        WHERE lower(email) IN (?, ?) OR lower(username) IN (?, ?)
    `).get(username.toLowerCase(), email, username.toLowerCase(), email);
    if (accountConflict) {
        return res.status(409).json({ error: 'That username or email is already assigned to an account.' });
    }
    try {
        const passwordHash = await hashPassword(password);
        const result = database.prepare('INSERT INTO users (username, email, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
            .run(username, email, passwordHash, 'teacher', new Date().toISOString());
        return res.status(201).json({ id: result.lastInsertRowid, username, email, isActive: true });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'That username or email is already assigned to an account.' });
        }
        console.error('Unable to create teacher account:', error);
        return res.status(500).json({ error: 'Unable to create teacher account.' });
    }
});

app.patch('/api/admin/teachers/:id', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const id = Number(req.params.id);
    const isActive = req.body?.isActive;
    if (!Number.isSafeInteger(id) || id < 1 || typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'Invalid teacher account update.' });
    }
    const update = database.prepare("UPDATE users SET is_active = ? WHERE id = ? AND role = 'teacher'")
        .run(isActive ? 1 : 0, id);
    if (!update.changes) return res.status(404).json({ error: 'Teacher account was not found.' });
    if (!isActive) database.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
    return res.sendStatus(204);
});

app.delete('/api/admin/teachers/:id', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid teacher account.' });
    const result = database.prepare("DELETE FROM users WHERE id = ? AND role = 'teacher'").run(id);
    if (!result.changes) return res.status(404).json({ error: 'Teacher account was not found.' });
    return res.sendStatus(204);
});

app.post('/api/admin/students', requireTeacher, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const studentId = typeof req.body?.studentId === 'string' ? req.body.studentId.trim() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const className = typeof req.body?.className === 'string' ? req.body.className.trim() : '';
    const guardianEmail = typeof req.body?.guardianEmail === 'string' ? req.body.guardianEmail.trim().toLowerCase() : '';
    const guardianPhone = typeof req.body?.guardianPhone === 'string' ? req.body.guardianPhone.trim() : '';
    const password = req.body?.password;
    const studentKey = normalizeStudentKey(studentId);
    if (!studentId || studentId.length > 80 || !name || name.length > 120 ||
        !className || className.length > 80 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail) || guardianEmail.length > 254 ||
        guardianPhone.length > 30 || !isValidPassword(password)) {
        return res.status(400).json({ error: 'Enter a student ID, name, class, valid guardian email, and password of at least 8 characters.' });
    }
    try {
        const passwordHash = await hashPassword(password);
        database.prepare(`
            INSERT INTO students (student_id, name, class_name, guardian_email, guardian_phone, password_hash, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        `).run(studentKey, name, className, guardianEmail, guardianPhone, passwordHash, new Date().toISOString());
        return res.status(201).json({ studentId: studentKey, name, className });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'A student with that ID already exists.' });
        }
        console.error('Unable to create student account:', error);
        return res.status(500).json({ error: 'Unable to create student account.' });
    }
});

app.post('/api/admin/students/import', requireTeacher, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const students = req.body?.students;
    if (!Array.isArray(students) || !students.length || students.length > 20000) {
        return res.status(400).json({ error: 'Upload a CSV containing at least one student and no more than 20,000 rows.' });
    }

    const normalizedStudents = [];
    const seenIds = new Set();
    for (const student of students) {
        const studentId = typeof student.studentId === 'string' ? student.studentId.trim() : '';
        const name = typeof student.name === 'string' ? student.name.trim() : '';
        const className = typeof student.class === 'string' ? student.class.trim() : '';
        const guardianEmail = typeof student.guardianEmail === 'string' ? student.guardianEmail.trim().toLowerCase() : '';
        const guardianPhone = typeof student.guardianPhone === 'string' ? student.guardianPhone.trim() : '';
        const password = student.password;
        const studentKey = normalizeStudentKey(studentId);
        if (!studentId || studentId.length > 80 || !name || name.length > 120 ||
            !className || className.length > 80 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail) || guardianEmail.length > 254 ||
            guardianPhone.length > 30 ||
            (password !== undefined && password !== '' && !isValidPassword(password)) ||
            seenIds.has(studentKey)) {
            return res.status(400).json({ error: 'Each CSV row needs a unique studentId, name, class, and valid guardianEmail. guardianPhone is optional; password must be at least 8 characters when provided.' });
        }
        seenIds.add(studentKey);
        normalizedStudents.push({ studentId, studentKey, name, className, guardianEmail, guardianPhone, password });
    }

    try {
        for (const student of normalizedStudents) {
            student.passwordHash = student.password ? await hashPassword(student.password) : null;
            delete student.password;
        }
        const importStudents = database.transaction(() => {
            const insert = database.prepare(`
                INSERT INTO students (student_id, name, class_name, guardian_email, guardian_phone, password_hash, is_active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT(student_id) DO UPDATE SET name = excluded.name, class_name = excluded.class_name,
                    guardian_email = excluded.guardian_email, guardian_phone = excluded.guardian_phone,
                    password_hash = COALESCE(excluded.password_hash, students.password_hash), is_active = 1
            `);
            for (const student of normalizedStudents) {
                insert.run(student.studentKey, student.name, student.className, student.guardianEmail,
                    student.guardianPhone, student.passwordHash, new Date().toISOString());
            }
        });
        importStudents();
        return res.json({ imported: normalizedStudents.length });
    } catch (error) {
        console.error('Student roster import failed:', error);
        return res.status(500).json({ error: 'Unable to import the student roster.' });
    }
});

app.get('/api/admin/finance/overview', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const session = normalizeFeeSession(req.query.session);
    if (!session) return res.status(400).json({ error: 'Enter a valid session/term.' });
    const students = getFinanceRoster(session);
    const pending = database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount_kobo), 0) AS amountKobo FROM payments WHERE session_key = ? AND status = 'pending'")
        .get(session.toLowerCase());
    const configured = students.filter(student => student.feeConfigured);
    return res.json({
        totalStudents: students.length,
        studentsWithConfiguredFees: configured.length,
        totalDueKobo: configured.reduce((sum, student) => sum + student.dueKobo, 0),
        totalPaidKobo: students.reduce((sum, student) => sum + student.paidKobo, 0),
        totalOutstandingKobo: configured.reduce((sum, student) => sum + student.balanceKobo, 0),
        pendingPayments: pending.count,
        pendingAmountKobo: pending.amountKobo
    });
});

app.get('/api/admin/students', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const session = normalizeFeeSession(req.query.session);
    if (!session) return res.status(400).json({ error: 'Enter a valid session/term.' });
    return res.json(getFinanceRoster(session));
});

app.get('/api/admin/fees', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    return res.json(database.prepare('SELECT class_name AS className, session_name AS session, amount_kobo AS amountKobo FROM fee_schedules ORDER BY session_name, class_name').all());
});

app.put('/api/admin/fees', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const className = typeof req.body?.className === 'string' ? req.body.className.trim() : '';
    const session = normalizeFeeSession(req.body?.session);
    const amountKobo = req.body?.amountKobo;
    if (!className || className.length > 80 || !session ||
        !Number.isSafeInteger(amountKobo) || amountKobo < 0 || amountKobo > 100000000000) {
        return res.status(400).json({ error: 'Provide a class, session/term, and valid non-negative fee amount.' });
    }
    database.prepare(`
        INSERT INTO fee_schedules (class_key, session_key, class_name, session_name, amount_kobo, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(class_key, session_key) DO UPDATE SET class_name = excluded.class_name,
            session_name = excluded.session_name, amount_kobo = excluded.amount_kobo, updated_at = excluded.updated_at
    `).run(className.toLowerCase(), session.toLowerCase(), className, session, amountKobo, new Date().toISOString());
    return res.sendStatus(204);
});

app.put('/api/admin/students/:studentId/fee', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const studentId = normalizeStudentKey(req.params.studentId);
    const session = normalizeFeeSession(req.body?.session);
    const amountKobo = req.body?.amountKobo;
    if (!studentId || !session ||
        (amountKobo !== null && (!Number.isSafeInteger(amountKobo) || amountKobo < 0 || amountKobo > 100000000000))) {
        return res.status(400).json({ error: 'Provide a valid student ID, session/term, and fee amount or null to use the class fee.' });
    }
    if (!database.prepare('SELECT 1 FROM students WHERE student_id = ? AND is_active = 1').get(studentId)) {
        return res.status(404).json({ error: 'Student was not found.' });
    }
    if (amountKobo === null) {
        database.prepare('DELETE FROM student_fee_overrides WHERE student_id = ? AND session_key = ?')
            .run(studentId, session.toLowerCase());
    } else {
        database.prepare(`
            INSERT INTO student_fee_overrides (student_id, session_key, session_name, amount_kobo, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(student_id, session_key) DO UPDATE SET session_name = excluded.session_name,
                amount_kobo = excluded.amount_kobo, updated_at = excluded.updated_at
        `).run(studentId, session.toLowerCase(), session, amountKobo, new Date().toISOString());
    }
    return res.sendStatus(204);
});

app.get('/api/admin/payments', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const session = normalizeFeeSession(req.query.session);
    if (!session) return res.status(400).json({ error: 'Enter a valid session/term.' });
    return res.json(database.prepare(`
        SELECT payments.id, payments.student_id AS studentId, students.name, students.class_name AS className,
            payments.session_name AS session, payments.amount_kobo AS amountKobo, payments.reference,
            payments.status, payments.source, payments.submitted_at AS submittedAt, payments.verified_at AS verifiedAt
        FROM payments JOIN students ON students.student_id = payments.student_id
        WHERE payments.session_key = ? ORDER BY CASE payments.status WHEN 'pending' THEN 0 ELSE 1 END, payments.submitted_at DESC
    `).all(session.toLowerCase()));
});

app.post('/api/admin/payments', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const studentId = typeof req.body?.studentId === 'string' ? normalizeStudentKey(req.body.studentId) : '';
    const session = normalizeFeeSession(req.body?.session);
    const amountKobo = req.body?.amountKobo;
    const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim() : '';
    if (!studentId || !session || !validatePaymentAmount(amountKobo) || !reference || reference.length > 120) {
        return res.status(400).json({ error: 'Provide a student ID, session/term, positive amount, and payment reference.' });
    }
    try {
        const result = database.transaction(() => {
            const finance = getStudentFinance(studentId, session);
            if (!finance) {
                const error = new Error('Student was not found.');
                error.status = 404;
                throw error;
            }
            if (!finance.feeConfigured) {
                const error = new Error('Set a class fee or student fee before recording a payment.');
                error.status = 400;
                throw error;
            }
            if (amountKobo > finance.balanceKobo) {
                const error = new Error('Payment cannot exceed the remaining approved balance.');
                error.status = 400;
                throw error;
            }
            const timestamp = new Date().toISOString();
            return database.prepare(`
                INSERT INTO payments (student_id, session_key, session_name, amount_kobo, reference, reference_key, status, source, submitted_at, verified_at, verified_by)
                VALUES (?, ?, ?, ?, ?, ?, 'approved', 'admin', ?, ?, ?)
            `).run(studentId, session.toLowerCase(), session, amountKobo, reference, reference.trim().toLowerCase(), timestamp, timestamp, req.user.id);
        })();
        return res.status(201).json({ id: result.lastInsertRowid });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That payment reference has already been recorded.' });
        if (error.status) return res.status(error.status).json({ error: error.message });
        console.error('Unable to record manual payment:', error);
        return res.status(500).json({ error: 'Unable to record payment.' });
    }
});

app.patch('/api/admin/payments/:id', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const id = Number(req.params.id);
    const status = req.body?.status;
    if (!Number.isSafeInteger(id) || id < 1 || !['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Select approve or reject for a valid payment.' });
    }
    try {
        const updatePayment = database.transaction(() => {
            const payment = database.prepare("SELECT * FROM payments WHERE id = ? AND status = 'pending'").get(id);
            if (!payment) throw new Error('This payment is no longer pending.');
            if (status === 'approved') {
                const finance = getStudentFinance(payment.student_id, payment.session_name);
                if (!finance?.feeConfigured || payment.amount_kobo > finance.balanceKobo) {
                    throw new Error('Approving this payment would exceed the configured remaining fee balance.');
                }
            }
            database.prepare('UPDATE payments SET status = ?, verified_at = ?, verified_by = ? WHERE id = ?')
                .run(status, new Date().toISOString(), req.user.id, id);
        });
        updatePayment();
        return res.sendStatus(204);
    } catch (error) {
        return res.status(409).json({ error: error.message || 'Unable to update payment.' });
    }
});

app.post('/api/admin/results/publish', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const studentId = typeof req.body?.studentId === 'string' ? normalizeStudentKey(req.body.studentId) : '';
    const session = normalizeFeeSession(req.body?.session);
    if (!studentId || !session) return res.status(400).json({ error: 'Provide a student ID and session/term.' });
    const resultKey = getRecordKey(studentId, session);
    if (!database.prepare('SELECT 1 FROM results WHERE record_key = ?').get(resultKey)) {
        return res.status(404).json({ error: 'The student result was not found.' });
    }
    const finance = getStudentFinance(studentId, session);
    if (!finance?.feeConfigured || finance.balanceKobo !== 0) {
        return res.status(409).json({ error: 'The full configured school fee must be approved before releasing this result.' });
    }
    const publishedAt = new Date().toISOString();
    database.prepare('UPDATE results SET published_at = ? WHERE record_key = ?').run(publishedAt, resultKey);
    return res.json({ publishedAt });
});

app.get('/api/results', requireTeacher, (req, res) => {
    const studentId = typeof req.query.studentId === 'string' ? normalizeStudentId(req.query.studentId) : '';
    const name = typeof req.query.name === 'string' ? req.query.name.trim().toLowerCase() : '';
    let rows;
    if (studentId) {
        rows = database.prepare('SELECT record_json, published_at FROM results WHERE student_id = ? ORDER BY session_name').all(studentId);
    } else if (name) {
        rows = database.prepare('SELECT record_json, published_at FROM results WHERE student_name LIKE ? ORDER BY student_id, session_name').all(`%${name}%`);
    } else {
        rows = database.prepare('SELECT record_json, published_at FROM results ORDER BY student_id, session_name').all();
    }
    return res.json(rows.map(row => {
        const result = JSON.parse(row.record_json);
        return { ...result, publishedAt: row.published_at || null };
    }));
});

app.post('/api/results/email-parent', requireTeacher, async (req, res) => {
    if (req.user.role !== 'teacher') {
        return res.status(403).json({ error: 'Only teachers can send released results to parents.' });
    }
    const studentId = typeof req.body?.studentId === 'string' ? normalizeStudentKey(req.body.studentId) : '';
    const session = normalizeFeeSession(req.body?.session);
    if (!studentId || !session) {
        return res.status(400).json({ error: 'Provide a student ID and session/term.' });
    }

    const resultRow = database.prepare('SELECT record_json, published_at FROM results WHERE record_key = ?')
        .get(getRecordKey(studentId, session));
    if (!resultRow) return res.status(404).json({ error: 'The saved result was not found.' });
    if (!resultRow.published_at) {
        return res.status(409).json({ error: 'The admin must release this result before it can be emailed.' });
    }

    const finance = getStudentFinance(studentId, session);
    if (!finance?.feeConfigured || finance.balanceKobo !== 0) {
        return res.status(409).json({ error: 'This result is no longer available because the full fee is not confirmed as paid.' });
    }
    const guardian = database.prepare('SELECT guardian_email FROM students WHERE student_id = ? AND is_active = 1')
        .get(studentId);
    if (!guardian?.guardian_email) {
        return res.status(404).json({ error: 'No active student record with a parent email was found.' });
    }

    try {
        const { transporter, from } = createMailer();
        const result = JSON.parse(resultRow.record_json);
        const subjectLines = Object.entries(result.scores).map(([subject, score]) => {
            const testPercentage = Number(((score.test / 30) * 100).toFixed(1));
            const combinedPercentage = score.exam === null
                ? testPercentage
                : Number((score.test + score.exam).toFixed(1));
            const grade = calculateGrade(combinedPercentage);
            const remark = calculateRemark(combinedPercentage);
            const marks = score.exam === null
                ? `Test: ${score.test}/30; exam pending; ${testPercentage}%`
                : `Test: ${score.test}/30; exam: ${score.exam}/70; total: ${combinedPercentage}/100`;
            return `${subject}: ${marks}; grade ${grade}; ${remark}`;
        });
        const text = [
            `Miracle International School result for ${result.name}`,
            `Student ID: ${result.id}`,
            `Class: ${result.class}`,
            `Session / term: ${result.session}`,
            `Overall: ${result.percentage}% — grade ${result.grade}, ${result.remark}`,
            '',
            'Subject results:',
            ...subjectLines,
            '',
            result.teacherComment ? `Teacher's comment: ${result.teacherComment}` : '',
            result.principalComment ? `Principal's comment: ${result.principalComment}` : '',
            '',
            'This result was released by the school. Please contact the school if you have questions.'
        ].filter(Boolean).join('\n');
        await transporter.sendMail({
            from,
            to: guardian.guardian_email,
            subject: `Released school result: ${result.name} - ${result.session}`,
            text
        });
        return res.json({ sent: true });
    } catch (error) {
        console.error('Unable to email released result to parent:', error);
        return res.status(503).json({ error: 'Unable to email this result. Check the school email/SMTP configuration and try again.' });
    }
});

app.put('/api/results', requireTeacher, requireTeacherResultEditor, (req, res) => {
    try {
        const student = saveResult(req.body?.result);
        return res.json(student);
    } catch (error) {
        return res.status(400).json({ error: error.message || 'Invalid result.' });
    }
});

app.post('/api/results/migrate', requireTeacher, requireTeacherResultEditor, (req, res) => {
    const { results, subjects } = req.body || {};
    if (!Array.isArray(results) || results.length > 10000) {
        return res.status(400).json({ error: 'Invalid local results migration.' });
    }
    try {
        const normalizedSubjects = validateSubjects(subjects);
        const importTransaction = database.transaction(() => {
            database.prepare('INSERT OR IGNORE INTO settings (setting_key, value_json) VALUES (?, ?)')
                .run('subjects', JSON.stringify(normalizedSubjects));
            for (const student of results) saveResult(student, true);
        });
        importTransaction();
        return res.json({ imported: results.length });
    } catch (error) {
        return res.status(400).json({ error: error.message || 'Unable to migrate browser records.' });
    }
});

app.post('/api/results/import', requireTeacher, requireTeacherResultEditor, (req, res) => {
    const { results, subjects } = req.body || {};
    if (!Array.isArray(results) || results.length > 10000) {
        return res.status(400).json({ error: 'Invalid backup results.' });
    }
    try {
        const normalizedSubjects = validateSubjects(subjects);
        const importTransaction = database.transaction(() => {
            for (const student of results) saveResult(student);
            database.prepare('INSERT INTO settings (setting_key, value_json) VALUES (?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json')
                .run('subjects', JSON.stringify(normalizedSubjects));
        });
        importTransaction();
        return res.json({ imported: results.length });
    } catch (error) {
        return res.status(400).json({ error: error.message || 'Unable to import results backup.' });
    }
});

app.get('/api/subjects', requireTeacher, (req, res) => {
    const row = database.prepare('SELECT value_json FROM settings WHERE setting_key = ?').get('subjects');
    return res.json(row ? JSON.parse(row.value_json) : defaultSubjects);
});

app.put('/api/subjects', requireTeacher, requireTeacherResultEditor, (req, res) => {
    try {
        const subjects = validateSubjects(req.body?.subjects);
        database.prepare('INSERT INTO settings (setting_key, value_json) VALUES (?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json')
            .run('subjects', JSON.stringify(subjects));
        return res.json(subjects);
    } catch (error) {
        return res.status(400).json({ error: error.message || 'Invalid subject list.' });
    }
});

app.post('/api/auth/request-reset', requestResetLimiter, async (req, res) => {
    const { email } = req.body || {};
    if (typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    try {
        const { transporter, from } = createMailer();
        const normalizedEmail = email.trim().toLowerCase();
        const user = database.prepare('SELECT email FROM users WHERE email = ? AND is_active = 1').get(normalizedEmail);
        if (user) {
            const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
            const secret = process.env.RESET_CODE_SECRET;
            if (!secret || secret.length < 24) {
                throw new Error('RESET_CODE_SECRET must be at least 24 characters.');
            }

            pendingResets.set(normalizedEmail, {
                codeHash: crypto.createHmac('sha256', secret).update(code).digest('hex'),
                expiresAt: Date.now() + 10 * 60 * 1000,
                attempts: 0
            });

            await transporter.sendMail({
                from,
                to: normalizedEmail,
                subject: 'Your Miracle School password reset code',
                text: `Your password reset code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`
            });
        }

        return res.json({ message: 'If the address is registered, a reset code has been sent.' });
    } catch (error) {
        const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
        pendingResets.delete(normalizedEmail);
        console.error('Password reset email failed:', error);
        return res.status(503).json({ error: 'Unable to send a reset code. Check the server email configuration.' });
    }
});

app.post('/api/auth/reset-password', completeResetLimiter, async (req, res) => {
    const { email, code, password } = req.body || {};
    if (typeof email !== 'string' || typeof code !== 'string' || !/^\d{6}$/.test(code) || !isValidPassword(password)) {
        return res.status(400).json({ error: 'Invalid reset details.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const pendingReset = pendingResets.get(normalizedEmail);
    const user = database.prepare('SELECT id FROM users WHERE email = ? AND is_active = 1').get(normalizedEmail);
    if (!pendingReset || pendingReset.expiresAt <= Date.now() || !user) {
        pendingResets.delete(normalizedEmail);
        return res.status(400).json({ error: 'Invalid or expired reset code.' });
    }

    const secret = process.env.RESET_CODE_SECRET;
    const submittedHash = crypto.createHmac('sha256', secret).update(code).digest();
    const expectedHash = Buffer.from(pendingReset.codeHash, 'hex');
    pendingReset.attempts += 1;
    if (!crypto.timingSafeEqual(submittedHash, expectedHash)) {
        if (pendingReset.attempts >= 5) pendingResets.delete(normalizedEmail);
        return res.status(400).json({ error: 'Invalid or expired reset code.' });
    }

    try {
        database.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            .run(await hashPassword(password), user.id);
        database.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id);
        pendingResets.delete(normalizedEmail);
        return res.sendStatus(204);
    } catch (error) {
        console.error('Password update failed:', error);
        return res.status(500).json({ error: 'Unable to save the new password.' });
    }
});

app.use((error, req, res, next) => {
    console.error('Request failed:', error);
    if (res.headersSent) return next(error);
    return res.status(400).json({ error: 'Invalid request.' });
});

async function start() {
    if (!process.env.RESET_CODE_SECRET || process.env.RESET_CODE_SECRET.length < 24) {
        throw new Error('Set RESET_CODE_SECRET to a random value of at least 24 characters in your .env file.');
    }
    initializeDatabase();
    await loadAdminAccount();
    app.listen(port, () => {
        console.log(`Miracle School portal running at http://localhost:${port}; database: ${databasePath}`);
    });
}

start().catch((error) => {
    console.error('Unable to start the portal:', error.message);
    process.exitCode = 1;
});
