const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const schoolLogoPath = path.join(__dirname, 'image', 'file_00000000db187243a08d3121bacdc848.png');

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

function normalizeWhatsAppNumber(value, defaultCountryCode = '+234') {
    if (typeof value !== 'string' || !value.trim()) return '';
    const countryCode = defaultCountryCode.replace(/[^\d]/g, '');
    if (!countryCode || countryCode.length > 3) return '';

    let number = value.trim().replace(/^whatsapp:/i, '').replace(/[\s().-]/g, '');
    if (number.startsWith('00')) number = `+${number.slice(2)}`;
    if (number.startsWith('+')) {
        return /^\+[1-9]\d{7,14}$/.test(number) ? number : '';
    }
    if (!/^\d+$/.test(number)) return '';

    if (number.startsWith(countryCode)) number = `+${number}`;
    else if (number.startsWith('0')) number = `+${countryCode}${number.slice(1)}`;
    else number = `+${countryCode}${number}`;

    return /^\+[1-9]\d{7,14}$/.test(number) ? number : '';
}

function createResultPdf(result) {
    return new Promise((resolve, reject) => {
        const document = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
        const chunks = [];
        document.on('data', chunk => chunks.push(chunk));
        document.once('error', reject);
        document.once('end', () => resolve(Buffer.concat(chunks)));

        const pageWidth = document.page.width;
        if (fs.existsSync(schoolLogoPath)) {
            document.image(schoolLogoPath, (pageWidth - 76) / 2, 38, { fit: [76, 76] });
        }

        document.moveDown(6);
        document.font('Helvetica-Bold').fontSize(18).text('MIRACLE INTERNATIONAL SCHOOL', { align: 'center' });
        document.font('Helvetica').fontSize(9).text('Kuye Area, Ogbomoso, Oyo State', { align: 'center' });
        document.moveDown(0.8);
        document.font('Helvetica-Bold').fontSize(15).text('OFFICIAL STUDENT RESULT', { align: 'center' });
        document.moveDown(1);

        document.font('Helvetica').fontSize(10);
        document.text(`Student: ${result.name}`);
        document.text(`Student ID: ${result.id}`);
        document.text(`Class: ${result.class}`);
        document.text(`Session / Term: ${result.session}`);
        document.text(`Class size: ${result.classSize || 'Not provided'}`);
        document.moveDown(1);

        document.font('Helvetica-Bold').fontSize(11).text('SUBJECT RESULTS');
        document.moveDown(0.5);
        for (const [subject, score] of Object.entries(result.scores || {})) {
            const test = Number(score.test || 0);
            const exam = Number.isFinite(score.exam) ? score.exam : null;
            const total = test + (exam === null ? 0 : exam);
            const percentage = exam === null ? Number(((test / 30) * 100).toFixed(1)) : total;
            const grade = calculateGrade(percentage);
            const details = exam === null
                ? `${subject}: test ${test}/30; exam pending; ${percentage}%`
                : `${subject}: test ${test}/30; exam ${exam}/70; total ${total}/100 (${percentage}%)`;

            document.font('Helvetica-Bold').fontSize(10).text(details, { continued: true });
            document.font('Helvetica').text(`; grade ${grade} - ${calculateRemark(percentage)}`);
        }

        document.moveDown(1);
        document.font('Helvetica-Bold').fontSize(11)
            .text(`${result.examComplete ? 'Final' : 'Test-stage'} overall: ${result.totalMarks}/${result.maxMarks} (${result.percentage}%)`);
        document.font('Helvetica').fontSize(10).text(`Overall grade: ${result.grade} (${result.remark})`);

        for (const [label, comment] of [
            ["Teacher's comment", result.teacherComment],
            ["Principal's comment", result.principalComment]
        ]) {
            if (!comment) continue;
            document.moveDown(0.8);
            document.font('Helvetica-Bold').fontSize(10).text(label);
            document.font('Helvetica').fontSize(10).text(comment);
        }

        document.moveDown(1.5);
        document.font('Helvetica').fontSize(8).fillColor('#475569')
            .text('This report was released by Miracle International School. Please contact the school with questions.', { align: 'center' });
        document.end();
    });
}

async function sendWhatsAppMedia({ to, mediaUrl, axiosClient = axios }) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_WHATSAPP_FROM;
    const contentSid = process.env.TWILIO_WHATSAPP_CONTENT_SID;
    const recipient = normalizeWhatsAppNumber(to, process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '+234');
    if (!/^AC[a-f\d]{32}$/i.test(accountSid || '') || !authToken || !from || !recipient) {
        throw new Error('WhatsApp is not configured. Set the Twilio account, token, sender, and a valid guardian phone number.');
    }
    if (!/^whatsapp:\+[1-9]\d{7,14}$/.test(from)) {
        throw new Error('TWILIO_WHATSAPP_FROM must use whatsapp:+ followed by the sender number in E.164 format.');
    }
    if (typeof mediaUrl !== 'string' || !mediaUrl.startsWith('https://')) {
        throw new Error('A public HTTPS URL is required to deliver the PDF to WhatsApp.');
    }

    const payload = new URLSearchParams({
        From: from,
        To: `whatsapp:${recipient}`
    });
    if (contentSid) {
        if (!/^HX[a-f\d]{32}$/i.test(contentSid)) {
            throw new Error('TWILIO_WHATSAPP_CONTENT_SID must be a valid Twilio Content SID.');
        }
        payload.set('ContentSid', contentSid);
        payload.set('ContentVariables', JSON.stringify({ 1: mediaUrl }));
    } else {
        payload.set('Body', 'Miracle International School has sent the released student result report as a PDF.');
        payload.set('MediaUrl', mediaUrl);
    }

    const response = await axiosClient.post(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        payload.toString(),
        {
            auth: { username: accountSid, password: authToken },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000
        }
    );
    return { messageSid: response.data.sid };
}

export { createResultPdf, normalizeWhatsAppNumber, sendWhatsAppMedia };
