import'dotenv/config';
import { createClient } from '@libsql/client';
const client = createClient({ url: process.env.DATABASE_URL });

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
 await fs.mkdir('/tmp/private', { recursive: true });
import { promisify } from 'node:util';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import nodemailer from 'nodemailer';
import Database from 'better-sqlite3';
import { createResultPdf, normalizeWhatsAppNumber, sendWhatsAppMedia } from './whatsapp.js';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const _dirname = path.dirname(_filename);
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
    const resultColumns = database.pragma('table_info(results)');
    if (!resultColumns.some(column => column.name === 'published_at')) {
        database.exec('ALTER TABLE results ADD COLUMN published_at TEXT');
    }
    const userColumns = database.pragma('table_info(users)');
    if (!userColumns.some(column => column.name === 'username')) {
        database.exec('ALTER TABLE users ADD COLUMN username TEXT');
    }
    if (!userColumns.some(column => column.name === 'class_name')) {
        database.exec('ALTER TABLE users ADD COLUMN class_name TEXT');
    }
    const examColumns = database.pragma('table_info(exams)');
    if (!examColumns.some(column => column.name === 'duration_minutes')) {
        database.exec('ALTER TABLE exams ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 0');
    }
    database.exec('UPDATE exams SET duration_minutes = objective_minutes + theory_minutes WHERE duration_minutes = 0');
    const examAttemptColumns = database.pragma('table_info(exam_attempts)');
    if (!examAttemptColumns.some(column => column.name === 'objective_scores_json')) {
        database.exec("ALTER TABLE exam_attempts ADD COLUMN objective_scores_json TEXT NOT NULL DEFAULT '{}'");
    }
    const studentColumns = database.pragma('table_info(students)');
    if (!studentColumns.some(column => column.name === 'guardian_whatsapp_opt_in')) {
        database.exec('ALTER TABLE students ADD COLUMN guardian_whatsapp_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (guardian_whatsapp_opt_in IN (0, 1))');
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
    res.json({ id: req.user.id, username: req.user.username, email: req.user.email, role: req.user.role, className: req.user.className })
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

app.get('/api/student/exams', requireStudent, (req, res) => {
    const student = database.prepare('SELECT class_name FROM students WHERE student_id = ? AND is_active = 1').get(req.user.studentId);
    if (!student) return res.status(401).json({ error: 'Student account is unavailable.' });
    const now = Date.now();
    const exams = database.prepare('SELECT * FROM exams WHERE lower(class_name) = lower(?) ORDER BY starts_at')
        .all(student.class_name)
        .filter(exam => examEndTime(exam) > now)
        .map(exam => ({
            ...publicExam(exam, now),
            attemptStarted: Boolean(database.prepare('SELECT 1 FROM exam_attempts WHERE exam_id = ? AND student_id = ?').get(exam.id, req.user.studentId))
        }));
    return res.json(exams);
});

app.post('/api/student/exams/:id/start', requireStudent, examCodeLimiter, (req, res) => {
    const examId = Number(req.params.id);
    if (!Number.isSafeInteger(examId) || examId < 1) return res.status(400).json({ error: 'Invalid exam.' });
    const student = database.prepare('SELECT class_name FROM students WHERE student_id = ? AND is_active = 1').get(req.user.studentId);
    const exam = database.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!student || !exam || student.class_name.toLowerCase() !== exam.class_name.toLowerCase()) {
        return res.status(404).json({ error: 'Exam not found for your class.' });
    }
    const now = Date.now();
    if (now < Date.parse(exam.starts_at)) return res.status(403).json({ error: 'This exam is not open yet. Wait until its scheduled start time.' });
    if (now >= examEndTime(exam)) return res.status(410).json({ error: 'This exam has ended and is no longer available.' });

    let attempt = database.prepare('SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?').get(examId, req.user.studentId);
    if (!attempt) {
        const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
        const codeHash = crypto.createHash('sha256').update(code).digest();
        const expectedHash = Buffer.from(exam.access_code_hash, 'hex');
        if (!/^\d{4}$/.test(code) || expectedHash.length !== codeHash.length || !crypto.timingSafeEqual(codeHash, expectedHash)) {
            return res.status(403).json({ error: 'That exam code is not valid.' });
        }
        try {
            const result = database.prepare('INSERT INTO exam_attempts (exam_id, student_id, answers_json, started_at) VALUES (?, ?, ?, ?)')
                .run(examId, req.user.studentId, '{}', new Date(now).toISOString());
            attempt = database.prepare('SELECT * FROM exam_attempts WHERE id = ?').get(result.lastInsertRowid);
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                attempt = database.prepare('SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?').get(examId, req.user.studentId);
            } else {
                console.error('Unable to start student exam:', error);
                return res.status(500).json({ error: 'Unable to start this exam.' });
            }
        }
    }
    return res.status(201).json({ started: true, examId: exam.id });
});

app.get('/api/student/exams/:id/attempt', requireStudent, (req, res) => {
    const examId = Number(req.params.id);
    if (!Number.isSafeInteger(examId) || examId < 1) return res.status(400).json({ error: 'Invalid exam.' });
    const student = database.prepare('SELECT class_name FROM students WHERE student_id = ? AND is_active = 1').get(req.user.studentId);
    const exam = database.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!student || !exam || student.class_name.toLowerCase() !== exam.class_name.toLowerCase()) {
        return res.status(404).json({ error: 'Exam not found for your class.' });
    }
    const attempt = database.prepare('SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?').get(examId, req.user.studentId);
    if (!attempt) return res.status(404).json({ error: 'Enter the exam code to start this exam.' });

    const questions = JSON.parse(exam.questions_json);
    const now = Date.now();
    if (!attempt.submitted_at && now >= examEndTime(exam)) {
        finishExamAttempt(attempt, questions, new Date(examEndTime(exam)).toISOString());
        attempt.submitted_at = new Date(examEndTime(exam)).toISOString();
        attempt.objective_score = 0;
        attempt.objective_total = objectiveTotal(questions);
        attempt.objective_scores_json = '{}';
    }
    if (attempt.submitted_at) {
        return res.json({ status: 'submitted', exam: publicExam(exam, now) });
    }
    const examQuestions = questions.map((question, index) => ({ ...question, index }))
        .map(({ index, type, question, options, marks }) => ({ index, type, question, options, marks }));
    return res.json({
        status: 'in_progress',
        phase: 'exam',
        phaseEndsAt: new Date(examEndTime(exam)).toISOString(),
        answers: JSON.parse(attempt.answers_json),
        questions: examQuestions,
        exam: publicExam(exam, now)
    });
});

app.put('/api/student/exams/:id/answer', requireStudent, (req, res) => {
    const examId = Number(req.params.id);
    const questionIndex = req.body?.questionIndex;
    const answer = req.body?.answer;
    if (!Number.isSafeInteger(examId) || examId < 1 || !Number.isSafeInteger(questionIndex) ||
        questionIndex < 0 || typeof answer !== 'string' || answer.length > 5000) {
        return res.status(400).json({ error: 'Invalid exam answer.' });
    }
    const student = database.prepare('SELECT class_name FROM students WHERE student_id = ? AND is_active = 1').get(req.user.studentId);
    const exam = database.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!student || !exam || student.class_name.toLowerCase() !== exam.class_name.toLowerCase()) {
        return res.status(404).json({ error: 'Exam not found for your class.' });
    }
    const attempt = database.prepare('SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?').get(examId, req.user.studentId);
    if (!attempt) return res.status(404).json({ error: 'Start this exam before submitting answers.' });
    const now = Date.now();
    const endTime = examEndTime(exam);
    const questions = JSON.parse(exam.questions_json);
    if (attempt.submitted_at || now >= endTime) {
        if (!attempt.submitted_at) finishExamAttempt(attempt, questions, new Date(endTime).toISOString());
        return res.status(410).json({ error: 'The exam has ended. Your saved answers have been submitted.' });
    }
    const question = questions[questionIndex];
    if (!question) return res.status(400).json({ error: 'Question not found.' });
    if (question.type === 'objective' && !/^[A-D]$/.test(answer)) {
        return res.status(400).json({ error: 'Select one of the four answer options.' });
    }
    const answers = JSON.parse(attempt.answers_json);
    answers[questionIndex] = answer;
    database.prepare('UPDATE exam_attempts SET answers_json = ? WHERE id = ?').run(JSON.stringify(answers), attempt.id);
    return res.sendStatus(204);
});

app.post('/api/student/exams/:id/submit', requireStudent, (req, res) => {
    const examId = Number(req.params.id);
    if (!Number.isSafeInteger(examId) || examId < 1) return res.status(400).json({ error: 'Invalid exam.' });
    const exam = database.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!exam) return res.status(404).json({ error: 'Exam not found.' });
    const attempt = database.prepare('SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?').get(examId, req.user.studentId);
    if (!attempt) return res.status(404).json({ error: 'Start this exam before submitting.' });
    if (!attempt.submitted_at) finishExamAttempt(attempt, JSON.parse(exam.questions_json));
    return res.sendStatus(204);
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
        SELECT users.id, users.username, users.email, users.class_name AS className, users.is_active AS isActive, users.created_at AS createdAt,
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
    const className = typeof req.body?.className === 'string' ? req.body.className.trim() : '';
    const password = req.body?.password;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
        !className || className.length > 80 || !isValidPassword(password)) {
        return res.status(400).json({ error: 'Enter a username, valid email, class (up to 80 characters), and password of at least 8 characters.' });
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
        const result = database.prepare('INSERT INTO users (username, email, password_hash, role, class_name, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
            .run(username, email, passwordHash, 'teacher', className, new Date().toISOString());
        return res.status(201).json({ id: result.lastInsertRowid, username, email, className, isActive: true });
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
    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: 'Invalid teacher account update.' });
    }
    if (typeof req.body?.className === 'string') {
        const className = req.body.className.trim();
        if (!className || className.length > 80) return res.status(400).json({ error: 'Enter a class name up to 80 characters.' });
        const update = database.prepare("UPDATE users SET class_name = ? WHERE id = ? AND role = 'teacher'").run(className, id);
        if (!update.changes) return res.status(404).json({ error: 'Teacher account was not found.' });
        return res.sendStatus(204);
    }
    const isActive = req.body?.isActive;
    if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'Invalid teacher account update.' });
    const update = database.prepare("UPDATE users SET is_active = ? WHERE id = ? AND role = 'teacher'").run(isActive ? 1 : 0, id);
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

app.get('/api/admin/exams', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const exams = database.prepare('SELECT * FROM exams ORDER BY starts_at DESC').all().map(exam => ({
        ...publicExam(exam),
        questionCount: JSON.parse(exam.questions_json).length,
        attemptCount: database.prepare('SELECT COUNT(*) AS count FROM exam_attempts WHERE exam_id = ?').get(exam.id).count
    }));
    return res.json(exams);
});

app.post('/api/admin/exams', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    const className = typeof req.body?.className === 'string' ? req.body.className.trim() : '';
    const startsAt = typeof req.body?.startsAt === 'string' ? Date.parse(req.body.startsAt) : NaN;
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    const durationHours = req.body?.durationHours;
    const durationMinutes = req.body?.durationMinutes;
    const totalDurationMinutes = durationHours * 60 + durationMinutes;
    if (!title || title.length > 120 || !subject || subject.length > 120 ||
        !className || className.length > 80 || !Number.isFinite(startsAt) ||
        !Number.isSafeInteger(durationHours) || durationHours < 0 || durationHours > 23 ||
        !Number.isSafeInteger(durationMinutes) || durationMinutes < 0 || durationMinutes > 59 ||
        totalDurationMinutes < 1 || totalDurationMinutes > 1439) {
        return res.status(400).json({ error: 'Enter an exam title, subject, class, future start time, and a total duration from 1 minute to 23 hours 59 minutes.' });
    }
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ error: 'Choose a four-digit numeric exam code.' });
    if (startsAt <= Date.now()) return res.status(400).json({ error: 'The exam start time must be in the future.' });
    let questions;
    try {
        questions = parseExamCsv(req.body?.csv);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
    if (!questions.some(question => question.type === 'objective') &&
        !questions.some(question => question.type === 'theory')) {
        return res.status(400).json({ error: 'Add at least one objective or theory question.' });
    }
    try {
        const result = database.prepare(`
            INSERT INTO exams (title, subject, class_name, starts_at, duration_minutes, objective_minutes, theory_minutes, access_code_hash, questions_json, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
        `).run(title, subject, className, new Date(startsAt).toISOString(), totalDurationMinutes,
            crypto.createHash('sha256').update(code).digest('hex'), JSON.stringify(questions), req.user.id, new Date().toISOString());
        return res.status(201).json({ id: result.lastInsertRowid, code, exam: publicExam({
            id: result.lastInsertRowid, title, subject, class_name: className, starts_at: new Date(startsAt).toISOString(),
            duration_minutes: totalDurationMinutes, objective_minutes: 0, theory_minutes: 0
        }) });
    } catch (error) {
        console.error('Unable to create exam:', error);
        return res.status(500).json({ error: 'Unable to create the exam.' });
    }
});

app.post('/api/admin/exams/:id/code', requireTeacher, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid exam.' });
    const exam = database.prepare('SELECT * FROM exams WHERE id = ?').get(id);
    if (!exam) return res.status(404).json({ error: 'Exam not found.' });
    if (Date.parse(exam.starts_at) <= Date.now()) return res.status(409).json({ error: 'The access code cannot be changed after the exam starts.' });
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ error: 'Enter a four-digit numeric exam code.' });
    database.prepare('UPDATE exams SET access_code_hash = ? WHERE id = ?')
        .run(crypto.createHash('sha256').update(code).digest('hex'), id);
    return res.json({ code });
});

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
        return res.status(201).json({ id: result.lastInsertRowid, name });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'That student is already on your class attendance list.' });
        }
        console.error('Unable to add attendance student:', error);
        return res.status(500).json({ error: 'Unable to add the student to the attendance list.' });
    }
});

app.delete('/api/teacher/attendance/students/:id', requireTeacher, (req, res) => {
    const className = getTeacherAttendanceClass(req);
    if (!className) return res.status(403).json({ error: 'Ask the administrator to assign your account to a class before removing students.' });
    const studentId = Number(req.params.id);
    if (!Number.isSafeInteger(studentId) || studentId < 1) return res.status(400).json({ error: 'Invalid attendance student.' });
    const result = database.prepare('DELETE FROM attendance_students WHERE id = ? AND class_key = ?')
        .run(studentId, className.toLowerCase());
    if (!result.changes) return res.status(404).json({ error: 'Attendance student not found in your class.' });
    return res.sendStatus(204);
});

app.put('/api/teacher/attendance/students/:id', requireTeacher, (req, res) => {
    const className = getTeacherAttendanceClass(req);
    if (!className) return res.status(403).json({ error: 'Ask the administrator to assign your account to a class before marking attendance.' });
    const studentId = Number(req.params.id);
    const attendanceDate = req.body?.date;
    const status = req.body?.status;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!Number.isSafeInteger(studentId) || studentId < 1 || !isValidAttendanceDate(attendanceDate) ||
        !['present', 'absent'].includes(status) || reason.length > 500 ||
        (status === 'absent' && !reason)) {
        return res.status(400).json({ error: 'Choose present or absent and provide a reason (up to 500 characters) for every absence.' });
    }
    const student = database.prepare('SELECT id FROM attendance_students WHERE id = ? AND class_key = ?')
        .get(studentId, className.toLowerCase());
    if (!student) return res.status(404).json({ error: 'Attendance student not found in your class.' });
    database.prepare(`
        INSERT INTO attendance_records (student_id, attendance_date, status, reason, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(student_id, attendance_date) DO UPDATE SET
            status = excluded.status, reason = excluded.reason,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(studentId, attendanceDate, status, status === 'absent' ? reason : '', req.user.id, new Date().toISOString());
    return res.sendStatus(204);
});

app.get('/api/teacher/exams', requireTeacher, (req, res) => {
    const exams = req.user.role === 'admin'
        ? database.prepare('SELECT * FROM exams ORDER BY starts_at DESC').all()
        : database.prepare('SELECT * FROM exams WHERE lower(class_name) = lower(?) ORDER BY starts_at DESC').all(req.user.className || '');
    return res.json(exams.map(exam => ({
        ...publicExam(exam),
        questionCount: JSON.parse(exam.questions_json).length,
        attemptCount: database.prepare('SELECT COUNT(*) AS count FROM exam_attempts WHERE exam_id = ?').get(exam.id).count
    })));
});

app.get('/api/teacher/exams/:id/report', requireTeacher, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid exam.' });
    const exam = database.prepare('SELECT * FROM exams WHERE id = ?').get(id);
    if (!exam || (req.user.role === 'teacher' && exam.class_name.toLowerCase() !== (req.user.className || '').toLowerCase())) {
        return res.status(404).json({ error: 'Exam report not found for your assigned class.' });
    }
    if (Date.now() < examEndTime(exam)) return res.status(403).json({ error: 'Exam answers and the answer key are available to teachers after the exam ends.' });
    const allQuestions = JSON.parse(exam.questions_json);
    const questions = allQuestions
        .map((question, index) => ({ ...question, index }))
        .filter(question => question.type === 'objective')
        .map(({ index, type, question, options, correctAnswer, marks }) => ({
            index, type, question, options, correctAnswer, marks,
            correctText: options['ABCD'.indexOf(correctAnswer)]
        }));
    database.prepare('SELECT * FROM exam_attempts WHERE exam_id = ? AND submitted_at IS NULL').all(id)
        .forEach(attempt => finishExamAttempt(attempt, allQuestions, new Date(examEndTime(exam)).toISOString()));
    const attempts = database.prepare(`
        SELECT exam_attempts.id, exam_attempts.student_id AS studentId, students.name, students.class_name AS className,
            exam_attempts.answers_json AS answersJson, exam_attempts.objective_score AS objectiveScore,
            exam_attempts.objective_total AS objectiveTotal, exam_attempts.objective_scores_json AS objectiveScoresJson,
            exam_attempts.submitted_at AS submittedAt
        FROM exam_attempts JOIN students ON students.student_id = exam_attempts.student_id
        WHERE exam_attempts.exam_id = ? ORDER BY students.name COLLATE NOCASE
    `).all(id);
    return res.json({
        exam: publicExam(exam),
        questions,
        attempts: attempts.map(attempt => {
            const allAnswers = JSON.parse(attempt.answersJson);
            const answers = Object.fromEntries(questions
                .filter(question => Object.hasOwn(allAnswers, question.index))
                .map(question => [question.index, allAnswers[question.index]]));
            const objectiveScores = JSON.parse(attempt.objectiveScoresJson);
            const objectiveScoreValue = Object.values(objectiveScores).reduce((total, score) => total + score, 0);
            return {
                id: attempt.id,
                studentId: attempt.studentId,
                name: attempt.name,
                className: attempt.className,
                answers,
                objectiveScores,
                objectiveScore: objectiveScoreValue,
                objectiveTotal: objectiveTotal(allQuestions),
                isGraded: questions.length > 0 && questions.every(question => Object.hasOwn(objectiveScores, question.index)),
                submittedAt: attempt.submittedAt
            };
        })
    });
});

app.put('/api/teacher/exams/:id/attempts/:attemptId/score', requireTeacher, (req, res) => {
    const examId = Number(req.params.id);
    const attemptId = Number(req.params.attemptId);
    if (!Number.isSafeInteger(examId) || examId < 1 || !Number.isSafeInteger(attemptId) || attemptId < 1) {
        return res.status(400).json({ error: 'Invalid exam or student attempt.' });
    }
    const exam = database.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!exam || (req.user.role === 'teacher' && exam.class_name.toLowerCase() !== (req.user.className || '').toLowerCase())) {
        return res.status(404).json({ error: 'Exam report not found for your assigned class.' });
    }
    if (Date.now() < examEndTime(exam)) return res.status(403).json({ error: 'Objective scores can be entered after the exam ends.' });
    const questions = JSON.parse(exam.questions_json);
    const objectiveQuestions = questions
        .map((question, index) => ({ ...question, index }))
        .filter(question => question.type === 'objective');
    if (!objectiveQuestions.length) return res.status(409).json({ error: 'This exam has no objective questions to score.' });
    const attempt = database.prepare('SELECT * FROM exam_attempts WHERE id = ? AND exam_id = ?').get(attemptId, examId);
    if (!attempt) return res.status(404).json({ error: 'Student exam attempt not found.' });
    if (!attempt.submitted_at) finishExamAttempt(attempt, questions, new Date(examEndTime(exam)).toISOString());

    const submittedScores = req.body?.scores;
    if (!submittedScores || typeof submittedScores !== 'object' || Array.isArray(submittedScores)) {
        return res.status(400).json({ error: 'Enter a score for every objective question.' });
    }
    const scoreKeys = Object.keys(submittedScores);
    if (scoreKeys.length !== objectiveQuestions.length ||
        objectiveQuestions.some(question => !Object.hasOwn(submittedScores, question.index))) {
        return res.status(400).json({ error: 'Enter a score for every objective question.' });
    }
    const scores = {};
    for (const question of objectiveQuestions) {
        const score = submittedScores[question.index];
        if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > question.marks) {
            return res.status(400).json({ error: `Question ${question.index + 1} score must be from 0 to ${question.marks}.` });
        }
        scores[question.index] = score;
    }
    const totalScore = Object.values(scores).reduce((total, score) => total + score, 0);
    const maxScore = objectiveTotal(questions);
    database.prepare('UPDATE exam_attempts SET objective_scores_json = ?, objective_score = ?, objective_total = ? WHERE id = ?')
        .run(JSON.stringify(scores), totalScore, maxScore, attemptId);
    return res.json({ objectiveScores: scores, objectiveScore: totalScore, objectiveTotal: maxScore, isGraded: true });
});

app.post('/api/admin/students', requireTeacher, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    const studentId = typeof req.body?.studentId === 'string' ? req.body.studentId.trim() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const className = typeof req.body?.className === 'string' ? req.body.className.trim() : '';
    const guardianEmail = typeof req.body?.guardianEmail === 'string' ? req.body.guardianEmail.trim().toLowerCase() : '';
    const guardianPhone = typeof req.body?.guardianPhone === 'string' ? req.body.guardianPhone.trim() : '';
    const guardianWhatsAppOptIn = req.body?.guardianWhatsAppOptIn;
    const password = req.body?.password;
    const studentKey = normalizeStudentKey(studentId);
    if (!studentId || studentId.length > 80 || !name || name.length > 120 ||
        !className || className.length > 80 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail) || guardianEmail.length > 254 ||
        guardianPhone.length > 30 ||
        (guardianWhatsAppOptIn !== undefined && typeof guardianWhatsAppOptIn !== 'boolean') ||
        (guardianWhatsAppOptIn === true &&
            !normalizeWhatsAppNumber(guardianPhone, process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '+234')) ||
        !isValidPassword(password)) {
        return res.status(400).json({ error: 'Enter a student ID, name, class, valid guardian email, and password of at least 8 characters. WhatsApp consent requires a valid guardian phone number.' });
    }
    try {
        const passwordHash = await hashPassword(password);
        database.prepare(`
            INSERT INTO students (student_id, name, class_name, guardian_email, guardian_phone, guardian_whatsapp_opt_in, password_hash, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(studentKey, name, className, guardianEmail, guardianPhone, guardianWhatsAppOptIn === true ? 1 : 0,
            passwordHash, new Date().toISOString());
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
        const guardianWhatsAppOptIn = student.guardianWhatsAppOptIn ?? null;
        const password = student.password;
        const studentKey = normalizeStudentKey(studentId);
        if (!studentId || studentId.length > 80 || !name || name.length > 120 ||
            !className || className.length > 80 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail) || guardianEmail.length > 254 ||
            guardianPhone.length > 30 ||
            (guardianWhatsAppOptIn !== null && typeof guardianWhatsAppOptIn !== 'boolean') ||
            (guardianWhatsAppOptIn === true &&
                !normalizeWhatsAppNumber(guardianPhone, process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '+234')) ||
            (password !== undefined && password !== '' && !isValidPassword(password)) ||
            seenIds.has(studentKey)) {
            return res.status(400).json({ error: 'Each CSV row needs a unique studentId, name, class, and valid guardianEmail. WhatsApp consent requires a guardian phone number; passwords must be at least 8 characters when provided.' });
        }
        seenIds.add(studentKey);
        normalizedStudents.push({ studentId, studentKey, name, className, guardianEmail, guardianPhone, guardianWhatsAppOptIn, password });
    }

    try {
        for (const student of normalizedStudents) {
            student.passwordHash = student.password ? await hashPassword(student.password) : null;
            delete student.password;
        }
        const importStudents = database.transaction(() => {
            const insert = database.prepare(`
                INSERT INTO students (student_id, name, class_name, guardian_email, guardian_phone, guardian_whatsapp_opt_in, password_hash, is_active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT(student_id) DO UPDATE SET name = excluded.name, class_name = excluded.class_name,
                    guardian_email = excluded.guardian_email, guardian_phone = excluded.guardian_phone,
                    guardian_whatsapp_opt_in = CASE WHEN ? IS NULL THEN students.guardian_whatsapp_opt_in ELSE excluded.guardian_whatsapp_opt_in END,
                    password_hash = COALESCE(excluded.password_hash, students.password_hash), is_active = 1
            `);
            for (const student of normalizedStudents) {
                insert.run(student.studentKey, student.name, student.className, student.guardianEmail,
                    student.guardianPhone, student.guardianWhatsAppOptIn ?? 0, student.passwordHash,
                    new Date().toISOString(), student.guardianWhatsAppOptIn);
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

app.post('/api/results/whatsapp-parent', requireTeacher, whatsappSendLimiter, async (req, res) => {
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
        return res.status(409).json({ error: 'The admin must release this result before it can be sent.' });
    }

    const finance = getStudentFinance(studentId, session);
    if (!finance?.feeConfigured || finance.balanceKobo !== 0) {
        return res.status(409).json({ error: 'This result is no longer available because the full fee is not confirmed as paid.' });
    }
    const guardian = database.prepare(`
        SELECT guardian_phone, guardian_whatsapp_opt_in AS whatsappOptIn
        FROM students WHERE student_id = ? AND is_active = 1
    `).get(studentId);
    if (!guardian) return res.status(404).json({ error: 'No active student record was found.' });
    if (!guardian.whatsappOptIn) {
        return res.status(409).json({ error: 'The parent must opt in to WhatsApp result messages before the school can send this report.' });
    }
    if (!normalizeWhatsAppNumber(guardian.guardian_phone, process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '+234')) {
        return res.status(409).json({ error: 'Add a valid WhatsApp number to the student roster before sending this report.' });
    }

    const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
    let baseUrl;
    try {
        const parsedUrl = new URL(publicBaseUrl);
        if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
            throw new Error('A public HTTPS base URL is required.');
        }
        baseUrl = parsedUrl.origin;
    } catch (error) {
        return res.status(503).json({ error: 'Set PUBLIC_BASE_URL to the public HTTPS address of this Node server so Twilio can retrieve the PDF.' });
    }

    let token;
    try {
        const result = JSON.parse(resultRow.record_json);
        const pdfBuffer = await createResultPdf(result);
        if (pdfBuffer.length > 10 * 1024 * 1024) {
            return res.status(413).json({ error: 'The generated result PDF is too large to send through WhatsApp.' });
        }
        pruneWhatsAppPdfs();
        while (pendingWhatsAppPdfs.size >= 100) {
            pendingWhatsAppPdfs.delete(pendingWhatsAppPdfs.keys().next().value);
        }

        token = crypto.randomBytes(32).toString('hex');
        const fileName = `result_${studentId}_${session}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) + '.pdf';
        pendingWhatsAppPdfs.set(token, {
            buffer: pdfBuffer,
            fileName,
            expiresAt: Date.now() + whatsappPdfLifetimeMs
        });

        const { messageSid } = await sendWhatsAppMedia({
            to: guardian.guardian_phone,
            mediaUrl: `${baseUrl}/api/whatsapp-media/${token}`
        });
        return res.json({ sent: true, messageSid });
    } catch (error) {
        if (token) pendingWhatsAppPdfs.delete(token);
        const status = error.response?.status;
        const providerCode = error.response?.data?.code;
        console.error('Unable to send released result via WhatsApp:', status ? `HTTP ${status}, provider code ${providerCode || 'unknown'}` : error.code || error.message);
        if (!status && /WhatsApp is not configured|TWILIO_WHATSAPP_FROM|TWILIO_WHATSAPP_CONTENT_SID/.test(error.message)) {
            return res.status(503).json({ error: error.message });
        }
        return res.status(503).json({
            error: status
                ? `Twilio rejected the WhatsApp request (HTTP ${status}). Check the sender, guardian opt-in, recipient, and approved template settings.`
                : 'WhatsApp delivery failed. Check the Twilio configuration and server network, then try again.'
        });
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
