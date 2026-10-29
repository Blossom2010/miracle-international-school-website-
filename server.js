import 'dotenv/config';
import { createClient } from '@libsql/client';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import nodemailer from 'nodemailer';
import Database from 'better-sqlite3';
import { createResultPdf, normalizeWhatsAppNumber, sendWhatsAppMedia } from './whatsapp.js';
import { fileURLToPath } from 'node:url';

(async () => { await fs.mkdir('/tmp/private', { recursive: true }); })();
const client = createClient({ url: process.env.DATABASE_URL });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); // Fixed typo from _filename to __filename
const app = express();
const port = Number(process.env.PORT || 3000);
const adminEmail = (process.env.ADMIN_EMAIL || process.env.TEACHER_EMAIL || '').trim().toLowerCase();
const accountPath = path.join(__dirname, 'private', 'teacher-account.json');
const databasePath = process.env.DATABASE_PATH
    ? (path.isAbsolute(process.env.DATABASE_PATH)
        ? process.env.DATABASE_PATH
        : path.resolve(__dirname, process.env.DATABASE_PATH))
    : path.join(__dirname, 'private', 'miracle-school.sqlite');
const scrypt = promisify(crypto.scrypt);
const sessionCookieAgeSeconds = 365 * 24 * 60 * 60;
const studentSessionCookieAgeSeconds = sessionCookieAgeSeconds;
const defaultSubjects = ['Mathematics', 'English Language', 'Basic Science', 'Social Studies', 'Civic Education'];
const maxSubjects = 15;
const pendingResets = new Map();
const pendingStudentResets = new Map();
const pendingWhatsAppPdfs = new Map();
const whatsappPdfLifetimeMs = 30 * 60 * 1000;
let database;
const whatsappMediaLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});

app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});
app.use('/image', express.static(path.join(__dirname, 'image'), { index: false }));

function pruneWhatsAppPdfs() {
    const now = Date.now();
    for (const [token, pdf] of pendingWhatsAppPdfs) {
        if (pdf.expiresAt <= now) pendingWhatsAppPdfs.delete(token);
    }
}

app.get('/api/whatsapp-media/:token', whatsappMediaLimiter, (req, res) => {
    pruneWhatsAppPdfs();
    const token = req.params.token;
    if (!/^[a-f\d]{64}$/i.test(token)) return res.sendStatus(404);
    const pdf = pendingWhatsAppPdfs.get(token);
    if (!pdf) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pdf.fileName}"`);
    return res.send(pdf.buffer);
});

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
const whatsappSendLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});
const examCodeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    keyGenerator: req => req.user.studentId,
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

function getTeacherAttendanceClass(req) {
    if (req.user.role !== 'teacher') return '';
    return typeof req.user.className === 'string' ? req.user.className.trim() : '';
}

function isValidAttendanceDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseExamCsv(csv) {
    if (typeof csv !== 'string' || csv.length > 2_000_000) {
        throw new Error('Upload a CSV file smaller than 2 MB.');
    }
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < csv.length; index += 1) {
        const character = csv[index];
        if (quoted) {
            if (character === '"' && csv[index + 1] === '"') {
                field += '"';
                index += 1;
            } else if (character === '"') {
                quoted = false;
            } else {
                field += character;
            }
        } else if (character === '"' && field === '') {
            quoted = true;
        } else if (character === ',') {
            row.push(field.trim());
            field = '';
        } else if (character === '\n' || character === '\r') {
            if (character === '\r' && csv[index + 1] === '\n') index += 1;
            row.push(field.trim());
            if (row.some(value => value !== '')) rows.push(row);
            row = [];
            field = '';
        } else {
            field += character;
        }
    }
    if (quoted) throw new Error('The CSV contains an unclosed quoted field.');
    row.push(field.trim());
    if (row.some(value => value !== '')) rows.push(row);
    if (rows.length < 2) throw new Error('The CSV must include a header row and at least one question.');

    const headers = rows[0].map((header, index) => index === 0 ? header.replace(/^\uFEFF/, '').toLowerCase() : header.toLowerCase());
    const requiredHeaders = ['type', 'question', 'mark'];
    if (requiredHeaders.some(header => !headers.includes(header))) {
        throw new Error('CSV headers must include type, question, and mark. See the downloadable template.');
    }
    const cell = (values, name) => values[headers.indexOf(name)] || '';
    const questions = rows.slice(1).map((values, index) => {
        const type = cell(values, 'type').toLowerCase();
        const question = cell(values, 'question');
        const mark = Number(cell(values, 'mark'));
        if (!['objective', 'theory'].includes(type) || !question || question.length > 5000 ||
            !Number.isFinite(mark) || mark <= 0 || mark > 100) {
            throw new Error(`Question ${index + 1}: enter type objective/theory, question text (max 5000 characters), and marks from 0 to 100.`);
        }
        if (type === 'objective') {
            const options = ['a', 'b', 'c', 'd'].map(letter => cell(values, `option${letter}`));
            const correctAnswer = cell(values, 'correctanswer').toUpperCase();
            if (options.some(option => !option || option.length > 1000) || !['A', 'B', 'C', 'D'].includes(correctAnswer)) {
                throw new Error(`Question ${index + 1}: objective questions need four options and a correctAnswer of A, B, C, or D.`);
            }
            return { type, question, options, correctAnswer, marks: mark };
        }
        const answerGuide = cell(values, 'answerguide');
        if (answerGuide.length > 5000) throw new Error(`Question ${index + 1}: answerGuide must be 5000 characters or fewer.`);
        return { type, question, answerGuide, marks: mark };
    });
    if (questions.length > 250) throw new Error('An exam can contain at most 250 questions.');
    if (!questions.some(question => question.type === 'objective') && !questions.some(question => question.type === 'theory')) {
        throw new Error('Add at least one objective or theory question.');
    }
    return questions;
}

function examEndTime(exam) {
    const durationMinutes = exam.duration_minutes || exam.objective_minutes + exam.theory_minutes;
    return Date.parse(exam.starts_at) + durationMinutes * 60_000;
}

function objectiveTotal(questions) {
    return questions.reduce((total, question) => total + (question.type === 'objective' ? question.marks : 0), 0);
}

function finishExamAttempt(attempt, questions, submittedAt = new Date().toISOString()) {
    if (attempt.submitted_at) return attempt;
    const total = objectiveTotal(questions);
    database.prepare(`UPDATE exam_attempts
        SET objective_score = 0, objective_total = ?, objective_scores_json = '{}', submitted_at = ?
        WHERE id = ?`).run(total, submittedAt, attempt.id);
    return { ...attempt, objective_score: 0, objective_total: total, objective_scores_json: '{}', submitted_at: submittedAt };
}

function publicExam(exam, now = Date.now()) {
    const startsAt = Date.parse(exam.starts_at);
    const endsAt = examEndTime(exam);
    return {
        id: exam.id,
        title: exam.title,
        subject: exam.subject,
        className: exam.class_name,
        startsAt: exam.starts_at,
        endsAt: new Date(endsAt).toISOString(),
        durationHours: Math.floor((exam.duration_minutes || exam.objective_minutes + exam.theory_minutes) / 60),
        durationMinutes: (exam.duration_minutes || exam.objective_minutes + exam.theory_minutes) % 60,
        status: now < startsAt ? 'upcoming' : now < endsAt ? 'open' : 'closed'
    };
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

function getPublishedResults(studentId) {
    return database.prepare('SELECT record_json, published_at FROM results WHERE student_id = ? AND published_at IS NOT NULL ORDER BY session_name')
        .all(normalizeStudentKey(studentId))
        .map(row => ({ ...JSON.parse(row.record_json), publishedAt: row.published_at }))
        .filter(result => {
            const finance = getStudentFinance(studentId, result.session);
            return finance?.feeConfigured && finance.balanceKobo === 0;
        });
}

function requireTeacher(req, res, next) {
    return requireAccountSession(req, res, next, 'school_session', 'teacher');
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
        : database.prepare('SELECT users.id, users.username, users.email, users.role, users.class_name AS className, users.is_active FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id WHERE auth_sessions.token_hash = ?')
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
            class_name TEXT,
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
            guardian_whatsapp_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (guardian_whatsapp_opt_in IN (0, 1)),
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
        CREATE TABLE IF NOT EXISTS exams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            subject TEXT NOT NULL,
            class_name TEXT NOT NULL,
            starts_at TEXT NOT NULL,
            duration_minutes INTEGER NOT NULL DEFAULT 0,
            objective_minutes INTEGER NOT NULL,
            theory_minutes INTEGER NOT NULL,
            access_code_hash TEXT NOT NULL,
            questions_json TEXT NOT NULL,
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS exams_class_start_idx ON exams(class_name, starts_at);
        CREATE TABLE IF NOT EXISTS exam_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
            student_id TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
            answers_json TEXT NOT NULL DEFAULT '{}',
            objective_score REAL NOT NULL DEFAULT 0,
            objective_total REAL NOT NULL DEFAULT 0,
            objective_scores_json TEXT NOT NULL DEFAULT '{}',
            submitted_at TEXT,
            started_at TEXT NOT NULL,
            UNIQUE (exam_id, student_id)
        );
        CREATE INDEX IF NOT EXISTS exam_attempts_exam_id_idx ON exam_attempts(exam_id);
        CREATE TABLE IF NOT EXISTS attendance_students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_key TEXT NOT NULL,
            class_name TEXT NOT NULL,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL,
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            UNIQUE (class_key, name_key)
        );
        CREATE INDEX IF NOT EXISTS attendance_students_class_idx ON attendance_students(class_key, name COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS attendance_records (
            student_id INTEGER NOT NULL REFERENCES attendance_students(id) ON DELETE CASCADE,
            attendance_date TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('present', 'absent')),
            reason TEXT NOT NULL DEFAULT '',
            updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (student_id, attendance_date)
        );
        CREATE INDEX IF NOT EXISTS attendance_records_date_idx ON attendance_records(attendance_date);
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
    res.json({ id: req.user.id, username: req.user.username, email: req.user.email, role: req.user.role, className: req.user.className })
);

app.get('/api/teacher/attendance', requireTeacher, (req, res) => {
    const className = getTeacherAttendanceClass(req);
    const attendanceDate = req.query.date;
    if (!className) return res.status(403).json({ error: 'Ask the administrator to assign your account to a class before taking attendance.' });
    if (!isValidAttendanceDate(attendanceDate)) return res.status(400).json({ error: 'Choose a valid attendance date.' });
    const students = database.prepare(`
        SELECT attendance_students.id, attendance_students.name,
            attendance_records.status, attendance_records.reason
        FROM attendance_students
        LEFT JOIN attendance_records ON attendance_records.student_id = attendance_students.id
            AND attendance_records.attendance_date = ?
        WHERE attendance_students.class_key = ?
        ORDER BY attendance_students.name COLLATE NOCASE
    `).all(attendanceDate, className.toLowerCase());
    return res.json({ className, date: attendanceDate, students });
});

app.post('/api/teacher/attendance/students', requireTeacher, (req, res) => {
    const className = getTeacherAttendanceClass(req);
    if (!className) return res.status(403).json({ error: 'Ask the administrator to assign your account to a class before adding students.' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 120) return res.status(400).json({ error: 'Enter a student name up to 120 characters.' });
    try {
        const result = database.prepare(`
            INSERT INTO attendance_students (class_key, class_name, name, name_key, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(className.toLowerCase(), className, name, name.toLowerCase(), req.user.id, new Date().toISOString());
        return res.status(201).json({ id: result.lastInsertRowid, name, status: null, reason: '' });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'A student with that name already exists in your class roster.' });
        }
        console.error('Unable to add attendance student:', error);
        return res.status(500).json({ error: 'Unable to add student to the attendance roster.' });
    }
});

app.delete('/api/teacher/attendance/students/:id', requireTeacher, (req, res) => {
    const className = getTeacherAttendanceClass(req);
    if (!className) return res.status(403).json({ error: 'Ask the administrator to assign your account to a class.' });
    const studentId = Number(req.params.id);
    if (!Number.isSafeInteger(studentId) || studentId < 1) return res.status(400).json({ error: 'Invalid student.' });
    
    const result = database.prepare(`
        DELETE FROM attendance_students 
        WHERE id = ? AND class_key = ?
    `).run(studentId, className.toLowerCase());
    
    if (!result.changes) return res.status(404).json({ error: 'Student not found in your class roster.' });
    return res.sendStatus(204);
});

app.post('/api/teacher/attendance', requireTeacher, (req, res) => {
    const className = getTeacherAttendanceClass(req);
    if (!className) return res.status(403).json({ error: 'Ask the administrator to assign your account to a class before saving attendance.' });
    
    const attendanceDate = req.body?.date;
    const records = req.body?.records;
    
    if (!isValidAttendanceDate(attendanceDate) || !Array.isArray(records)) {
        return res.status(400).json({ error: 'Provide a valid attendance date and records array.' });
    }

    try {
        const saveTransaction = database.transaction(() => {
            const upsertRecord = database.prepare(`
                INSERT INTO attendance_records (student_id, attendance_date, status, reason, updated_by, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(student_id, attendance_date) DO UPDATE SET
                    status = excluded.status,
                    reason = excluded.reason,
                    updated_by = excluded.updated_by,
                    updated_at = excluded.updated_at
            `);

            const verifyStudent = database.prepare(`
                SELECT 1 FROM attendance_students WHERE id = ? AND class_key = ?
            `);

            for (const record of records) {
                const studentId = Number(record?.studentId);
                const status = record?.status;
                const reason = typeof record?.reason === 'string' ? record.reason.trim().slice(0, 250) : '';

                if (!Number.isSafeInteger(studentId) || !['present', 'absent'].includes(status)) {
                    throw new Error('Invalid attendance status or student ID.');
                }

                if (!verifyStudent.get(studentId, className.toLowerCase())) {
                    throw new Error('One or more students do not belong to your class.');
                }

                upsertRecord.run(studentId, attendanceDate, status, reason, req.user.id, new Date().toISOString());
            }
        });

        saveTransaction();
        return res.sendStatus(204);
    } catch (error) {
        if (error.message.includes('do not belong')) {
            return res.status(403).json({ error: error.message });
        }
        console.error('Unable to save attendance records:', error);
        return res.status(500).json({ error: 'Unable to save attendance records.' });
    }
});

// Initialize database, load initial accounts, and start server
initializeDatabase();
loadAdminAccount().catch(error => {
    console.error('Failed to load initial admin account:', error);
});

app.listen(port, () => {
    console.log(`Miracle School server running on port ${port}`);
});