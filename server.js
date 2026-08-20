// server.js — PrepMMI standalone backend
// Fully independent from Denterview: own repo, own Railway project, own
// Firebase project, own Stripe products. Nothing here references Denterview.

import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import Stripe from 'stripe';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

// ── ENV VARS ──────────────────────────────────────────────────────────────
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'PrepMMI <onboarding@resend.dev>';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const APP_URL = process.env.APP_URL || 'https://www.prepmmi.com';

if (!GOOGLE_API_KEY) {
  console.error('❌ CRITICAL: GOOGLE_API_KEY not set');
  process.exit(1);
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
if (!stripe) console.warn('⚠️  STRIPE_SECRET_KEY not set — checkout webhook will not work yet');

// ── FIREBASE ADMIN (single project — this app's own) ─────────────────────
let db, auth;
try {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(readFileSync('./firebase-admin-key.json', 'utf8'));
    console.log('✅ Loaded Firebase key from file');
  } catch {
    const envVal = process.env.FIREBASE_ADMIN_KEY;
    if (!envVal) throw new Error('No Firebase key found (checked ./firebase-admin-key.json and FIREBASE_ADMIN_KEY env var)');
    serviceAccount = JSON.parse(envVal);
    console.log('✅ Loaded Firebase key from FIREBASE_ADMIN_KEY env var');
  }
  const firebaseApp = initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore(firebaseApp);
  auth = getAuth(firebaseApp);
  console.log('✅ Firebase Admin initialized');
} catch (err) {
  console.error('❌ CRITICAL: Firebase init failed:', err.message);
  process.exit(1);
}

// ── EMAIL (Resend) ─────────────────────────────────────────────────────────
async function sendEmail(to, subject, html, text) {
  if (!RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY not configured - skipping email');
    return { success: false, error: 'Email service not configured' };
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text })
    });
    const data = await response.json();
    if (response.ok) {
      console.log(`📧 Email sent to ${to} (ID: ${data.id})`);
      return { success: true, id: data.id };
    } else {
      console.error('❌ Resend API error:', data);
      return { success: false, error: data.message };
    }
  } catch (error) {
    console.error('❌ Email send failed:', error.message);
    return { success: false, error: error.message };
  }
}

// ── STRIPE WEBHOOK — must be registered before express.json() ────────────
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.error('❌ Stripe not configured');
    return res.status(500).send('Stripe not configured');
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Stripe signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  res.status(200).json({ received: true }); // ack immediately

  if (event.type !== 'checkout.session.completed') {
    console.log(`⏭️  Ignoring Stripe event type: ${event.type}`);
    return;
  }

  try {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    if (!email) { console.error('❌ Stripe session had no customer email'); return; }
    const sanitizedEmail = sanitizeEmail(email);

    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      expand: ['data.price.product'],
    });
    const item = lineItems.data[0];
    const price = item?.price;
    const product = price?.product;

    // Fallback lookup in case metadata.circuits wasn't set on a Price —
    // fill in real price IDs here once you've created them in Stripe.
    const PRICE_CIRCUIT_FALLBACK = {
      // 'price_XXXXXXXXXXXX': 1,   // Starter
      // 'price_XXXXXXXXXXXX': 3,   // Confidence
      // 'price_XXXXXXXXXXXX': 5,   // Mastery
      // 'price_XXXXXXXXXXXX': 8,   // Expert
      // 'price_XXXXXXXXXXXX': 12,  // Full Prep
    };

    let circuitCount = parseInt(price?.metadata?.circuits, 10);
    if (!circuitCount) circuitCount = PRICE_CIRCUIT_FALLBACK[price?.id] || null;
    if (!circuitCount) {
      console.error(`⚠️  UNKNOWN PRICE — no circuits metadata or fallback for price ${price?.id} (product: ${product?.name}). Defaulting to 1.`);
      circuitCount = 1;
    }

    console.log(`📦 ${sanitizedEmail} bought ${circuitCount} circuits (price: ${price?.id})`);

    const randomPassword = generateUserId().substring(0, 12);
    const result = await createAppUser(sanitizedEmail, randomPassword, circuitCount);
    console.log(result.isNewUser ? `✨ New customer: ${sanitizedEmail}` : `🔄 Returning customer: ${sanitizedEmail}`);
    await sendWelcomeEmail(sanitizedEmail, randomPassword, circuitCount, !result.isNewUser);
    console.log('✅ Stripe webhook processing complete');
  } catch (err) {
    console.error('❌ Stripe webhook error:', err);
  }
});

// ── STANDARD MIDDLEWARE ──────────────────────────────────────────────────
app.use(cors({
  origin: IS_PRODUCTION ? process.env.ALLOWED_ORIGINS?.split(',') : true,
  credentials: true
}));
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 100;
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!rateLimits.has(ip)) { rateLimits.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW }); return next(); }
  const limit = rateLimits.get(ip);
  if (now > limit.resetTime) { limit.count = 1; limit.resetTime = now + RATE_LIMIT_WINDOW; return next(); }
  if (limit.count >= RATE_LIMIT_MAX) return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
  limit.count++;
  next();
}
app.use('/api/', rateLimit);

function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return res.status(500).json({ success: false, message: 'Admin panel not configured' });
  if (req.headers['x-admin-key'] !== ADMIN_API_KEY) return res.status(401).json({ success: false, message: 'Unauthorized' });
  next();
}

// ── HELPERS ───────────────────────────────────────────────────────────────
function base64ToPart(base64Data, mimeType) { return { inlineData: { data: base64Data, mimeType } }; }

function generateUserId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [4, 4, 4, 4].map(len =>
    Array(len).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('')
  ).join('-');
}

function sanitizeEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) throw new Error('Invalid email format');
  return email.toLowerCase().trim();
}

// ── ACCOUNT CREATION / CREDIT MANAGEMENT ──────────────────────────────────
// Checks for an existing account by email first and ADDS to their balance
// rather than overwriting — this is what makes repeat customers work.
async function createAppUser(email, password, unitCount) {
  try {
    const userRecord = await auth.createUser({ email, password, emailVerified: false });
    console.log(`✅ Created Firebase Auth user: ${userRecord.uid}`);

    const userRef = db.collection('artifacts').doc('default-app-id')
      .collection('public').doc('data').collection('users').doc(userRecord.uid);

    await userRef.set({
      email, totalUnits: unitCount, unitsRemaining: unitCount,
      seenStationIds: [], interviewHistory: [],
      createdAt: new Date().toISOString(), lastLogin: null,
      lastPurchaseDate: new Date().toISOString()
    });

    console.log(`✅ Created Firestore user: ${userRecord.uid} with ${unitCount} units`);
    return { userId: userRecord.uid, isNewUser: true };
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      const userRecord = await auth.getUserByEmail(email);
      const userRef = db.collection('artifacts').doc('default-app-id')
        .collection('public').doc('data').collection('users').doc(userRecord.uid);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        await userRef.set({
          email, totalUnits: unitCount, unitsRemaining: unitCount,
          seenStationIds: [], interviewHistory: [],
          createdAt: new Date().toISOString(), lastLogin: null,
          lastPurchaseDate: new Date().toISOString()
        });
        console.log(`✅ Re-created Firestore data for ${userRecord.uid} — added ${unitCount} units`);
        return { userId: userRecord.uid, isNewUser: true };
      } else {
        const currentData = userDoc.data();
        const newTotal = (currentData.totalUnits || 0) + unitCount;
        const newRemaining = (currentData.unitsRemaining || 0) + unitCount;
        await userRef.update({ totalUnits: newTotal, unitsRemaining: newRemaining, lastPurchaseDate: new Date().toISOString() });
        console.log(`✅ Repeat customer ${userRecord.uid} — added ${unitCount} units (now ${newRemaining} remaining)`);
        return { userId: userRecord.uid, isNewUser: false };
      }
    }
    throw error;
  }
}

// ── BRAND EMAIL SHELL ──────────────────────────────────────────────────
// Shared PrepMMI-branded wrapper (logo, brand colors, footer) used by every
// outbound email so nothing ships with generic gray Denterview-style styling.
const BRAND = { ink: '#12181F', paper: '#F3F5F6', signal: '#FF5A2E', muted: '#5B6670', line: '#D8DEE1' };
const LOGO_URL = `${APP_URL}/assets/logo_master.png`;
const LOGIN_URL = `${APP_URL}/app`;

function brandButton(label, href) {
  return `<div style="text-align:center;margin:26px 0 6px;">
    <a href="${href}" style="display:inline-block;background:${BRAND.signal};color:#ffffff;font-weight:700;font-size:15px;padding:13px 28px;border-radius:9px;text-decoration:none;">${label}</a>
  </div>`;
}

function brandedEmailShell(title, bodyHtml) {
  return `
  <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background:${BRAND.paper}; padding: 24px;">
    <div style="background: ${BRAND.ink}; padding: 28px 30px; border-radius: 14px 14px 0 0; text-align: center;">
      <img src="${LOGO_URL}" alt="PrepMMI" height="32" style="display:inline-block;margin-bottom:6px;">
      <h1 style="color: white; margin: 6px 0 0; font-size: 20px;">${title}</h1>
    </div>
    <div style="background: #ffffff; padding: 30px; border-radius: 0 0 14px 14px; border: 1px solid ${BRAND.line}; border-top: none;">
      ${bodyHtml}
      <hr style="border: none; border-top: 1px solid ${BRAND.line}; margin: 28px 0 16px;">
      <p style="color: ${BRAND.muted}; font-size: 12px; text-align: center; margin:0;">
        PrepMMI &middot; Questions? Just reply to this email.<br>
        <a href="${LOGIN_URL}" style="color:${BRAND.muted};">${LOGIN_URL.replace('https://', '')}</a>
      </p>
    </div>
  </div>`;
}

async function sendWelcomeEmail(email, password, unitCount, isReturning = false) {
  const unitWord = unitCount === 1 ? 'circuit' : 'circuits';
  const subject = isReturning ? `PrepMMI — ${unitCount} ${unitWord} added!` : `Welcome to PrepMMI — you're ready to start`;

  const welcomeMessage = isReturning
    ? `<p style="font-size: 15px; color: #374151;">Thanks for coming back! We've added <strong>${unitCount} ${unitWord}</strong> to your account — <strong>${email}</strong>.</p>
       <p style="font-size: 15px; color: #374151;">Log back in with your existing password to use them. Forgot it? There's a "Forgot password?" link on the login screen.</p>`
    : `<p style="font-size: 15px; color: #374151;">Thanks for your purchase! You now have <strong>${unitCount} ${unitWord}</strong> ready to go.</p>
       <div style="background: ${BRAND.paper}; padding: 18px 20px; border-radius: 10px; border: 1px solid ${BRAND.line}; margin: 18px 0;">
         <p style="color: ${BRAND.muted}; margin: 0 0 8px; font-size: 13px;">Your login credentials</p>
         <p style="font-size: 15px; color: #374151; margin: 4px 0;"><strong>Email:</strong> ${email}</p>
         <p style="font-size: 15px; color: #374151; margin: 4px 0;"><strong>Password:</strong> <code style="background: #eef0f1; padding: 3px 8px; border-radius: 5px; font-family: monospace;">${password}</code></p>
         <p style="color: #B91C1C; font-size: 13px; margin: 10px 0 0;">For security, change this password after your first login (Account menu → Change password).</p>
       </div>
       <p style="font-size: 15px; color: #374151;"><strong>How to start:</strong></p>
       <ol style="font-size: 14px; color: #374151; padding-left: 18px; margin: 0;">
         <li style="margin-bottom:6px;">Click the button below and log in with the email/password above.</li>
         <li style="margin-bottom:6px;">On your dashboard, hit "Start a Circuit."</li>
         <li style="margin-bottom:6px;">Allow camera/mic access — you'll get a prep window, then answer out loud for each of 6 stations.</li>
         <li>Get AI feedback and a score per station right after you finish.</li>
       </ol>`;

  const bodyHtml = `${welcomeMessage}${brandButton(isReturning ? 'Log In' : 'Log In & Start', LOGIN_URL)}`;

  const textContent = `${isReturning ? 'Welcome back to PrepMMI!' : 'Welcome to PrepMMI!'}\n\n` +
    `You now have ${unitCount} ${unitWord}.\n` +
    (!isReturning ? `\nLogin: ${email} / ${password}\n` : '') +
    `\nLog in at ${LOGIN_URL}\n`;

  const result = await sendEmail(email, subject, brandedEmailShell(isReturning ? 'Welcome back!' : 'Welcome to PrepMMI!', bodyHtml), textContent);
  if (!result.success) console.error(`❌ Failed to send email to ${email}:`, result.error);
}

// ── STATIC SERVING ────────────────────────────────────────────────────────
app.use(express.static('./public'));
app.use('/app', express.static('./public/app'));

// ── AI ANALYSIS ───────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { systemInstruction, userPrompt, imageBase64, videoBase64 } = req.body;
    if (!userPrompt || !systemInstruction) return res.status(400).json({ success: false, message: 'Missing required data' });
    if (videoBase64 && videoBase64.length > 100 * 1024 * 1024) return res.status(413).json({ success: false, message: 'Video data too large' });

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_API_KEY}`;
    const contents = [{ text: userPrompt }];
    if (videoBase64) contents.push(base64ToPart(videoBase64, 'video/webm'));
    if (imageBase64) contents.push(base64ToPart(imageBase64, 'image/jpeg'));

    const payload = { contents: [{ role: 'user', parts: contents }], systemInstruction: { parts: [{ text: systemInstruction }] } };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 240 * 1000);
    let gResp;
    try {
      gResp = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') return res.status(504).json({ success: false, message: 'Analysis timed out' });
      throw fetchErr;
    } finally { clearTimeout(timeoutId); }

    const gBody = await gResp.text();
    if (!gResp.ok) {
      let parsed; try { parsed = JSON.parse(gBody); } catch { parsed = { text: gBody }; }
      console.error('❌ Gemini API Error:', parsed);
      return res.status(502).json({ success: false, message: IS_PRODUCTION ? 'Analysis service temporarily unavailable' : `Upstream error: ${parsed.message || gResp.statusText}` });
    }

    let parsedResp;
    try { parsedResp = JSON.parse(gBody); } catch { parsedResp = { candidates: [{ content: { parts: [{ text: gBody || "Analysis failed." }] } }] }; }
    return res.json({ success: true, data: parsedResp });
  } catch (err) {
    console.error('❌ Server error during analysis:', err);
    return res.status(500).json({ success: false, message: IS_PRODUCTION ? 'Internal server error' : err.message });
  }
});

// ── BUILD A CIRCUIT (6 stations, one per category, no repeats) ───────────
const STATION_CATEGORIES = ['ethics', 'roleplay', 'policy', 'personal', 'teamwork', 'scenario'];

app.post('/api/get-circuit', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'Missing userId' });

    const userRef = db.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const userData = userDoc.data();
    if ((userData.unitsRemaining || 0) < 1) return res.status(403).json({ success: false, message: 'No circuits remaining' });

    const seenIds = new Set(userData.seenStationIds || []);
    const circuit = [];

    for (const category of STATION_CATEGORIES) {
      const snapshot = await db.collection('mmiStations').where('category', '==', category).get();
      const all = snapshot.docs.map(d => d.data());
      if (all.length === 0) { console.error(`⚠️  No stations seeded for category: ${category}`); continue; }
      const unseen = all.filter(s => !seenIds.has(s.id));
      const pool = unseen.length > 0 ? unseen : all;
      const picked = pool[Math.floor(Math.random() * pool.length)];
      circuit.push(picked);
      seenIds.add(picked.id);
    }

    await userRef.update({ seenStationIds: Array.from(seenIds), unitsRemaining: userData.unitsRemaining - 1, lastCircuitStartedAt: new Date().toISOString() });
    res.json({ success: true, circuit, unitsRemaining: userData.unitsRemaining - 1 });
  } catch (err) {
    console.error('❌ get-circuit error:', err);
    res.status(500).json({ success: false, message: 'Failed to build circuit' });
  }
});

// ── EMAIL SENDING (generic results email) ─────────────────────────────────
app.post('/api/send-email', async (req, res) => {
  try {
    const { email, content } = req.body;
    if (!email || !content) return res.status(400).json({ success: false, message: 'Missing email or content' });
    const sanitizedEmail = sanitizeEmail(email);
    if (content.length > 500000) return res.status(413).json({ success: false, message: 'Content too large' });

    const bodyHtml = `
      <p style="font-size:15px;color:#374151;margin:0 0 16px;">Here are your results from today's circuit.</p>
      <div style="white-space: pre-wrap; background: #F3F5F6; padding: 20px; border-radius: 10px; font-size:14px; color:#12181F; line-height:1.6;">${content.replace(/\n/g, '<br>')}</div>`;

    const result = await sendEmail(sanitizedEmail, `Your PrepMMI Results`, brandedEmailShell('Your PrepMMI Results', bodyHtml), content);
    if (result.success) res.json({ success: true, message: 'Email sent successfully', messageId: result.id });
    else res.status(500).json({ success: false, message: 'Failed to send email', error: result.error });
  } catch (err) {
    console.error('❌ Email error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send email' });
  }
});

// ── SAVE CIRCUIT HISTORY (called after AI grading finishes) ──────────────
app.post('/api/save-results', async (req, res) => {
  try {
    const { userId, overallScore, overallSummary, date, stations } = req.body;
    if (!userId || !date) return res.status(400).json({ success: false, message: 'Missing userId or date' });

    const userRef = db.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const entry = {
      date,
      overallScore: overallScore || null,
      overallSummary: (overallSummary || '').slice(0, 4000),
      stations: Array.isArray(stations)
        ? stations.slice(0, 12).map(s => ({
            category: String(s.category || '').slice(0, 100),
            prompt: String(s.prompt || '').slice(0, 2000),
            feedback: String(s.feedback || '').slice(0, 4000)
          }))
        : []
    };

    const existing = userDoc.data().interviewHistory || [];
    // Keep the most recent 25 circuits so the doc doesn't grow unbounded.
    const updated = [...existing, entry].slice(-25);
    await userRef.update({ interviewHistory: updated });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ save-results error:', err);
    res.status(500).json({ success: false, message: 'Failed to save results' });
  }
});

// ── MANUAL USER CREATION (unprotected legacy-style — prefer /api/admin/create-user) ──
app.post('/api/create-user', async (req, res) => {
  try {
    const { email, password, interviewCount } = req.body;
    if (!email || !password || !interviewCount) return res.status(400).json({ success: false, message: 'Missing email, password, or interviewCount' });
    const sanitizedEmail = sanitizeEmail(email);
    if (interviewCount < 1 || interviewCount > 100) return res.status(400).json({ success: false, message: 'Invalid interview count (must be 1-100)' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    const result = await createAppUser(sanitizedEmail, password, interviewCount);
    await sendWelcomeEmail(sanitizedEmail, password, interviewCount, !result.isNewUser);
    res.json({ success: true, userId: result.userId, email: sanitizedEmail, interviewCount, isReturning: !result.isNewUser, message: result.isNewUser ? 'User created' : 'Credits added' });
  } catch (err) {
    console.error('❌ Create user error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to create user' });
  }
});

// ── ADMIN ENDPOINTS (protected) ───────────────────────────────────────────
app.post('/api/admin/create-user', requireAdmin, async (req, res) => {
  try {
    const { email, unitCount } = req.body;
    if (!email || !unitCount) return res.status(400).json({ success: false, message: 'Missing email or unitCount' });
    const sanitizedEmail = sanitizeEmail(email);
    const randomPassword = generateUserId().substring(0, 12);
    const result = await createAppUser(sanitizedEmail, randomPassword, unitCount);
    await sendWelcomeEmail(sanitizedEmail, randomPassword, unitCount, !result.isNewUser);
    res.json({ success: true, userId: result.userId, email: sanitizedEmail, unitCount, isReturning: !result.isNewUser });
  } catch (err) {
    console.error('❌ Admin create-user error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed' });
  }
});

app.get('/api/admin/recent-purchases', requireAdmin, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ success: false, message: 'Stripe not configured' });
    const sessions = await stripe.checkout.sessions.list({ limit: 25, expand: ['data.line_items'] });
    const purchases = sessions.data.filter(s => s.payment_status === 'paid').map(s => ({
      email: s.customer_details?.email || s.customer_email,
      amount: s.amount_total ? (s.amount_total / 100) : null,
      currency: s.currency,
      created: new Date(s.created * 1000).toISOString(),
      item: s.line_items?.data?.[0]?.description || 'Unknown',
    }));
    res.json({ success: true, purchases });
  } catch (err) {
    console.error('❌ Admin recent-purchases error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed' });
  }
});

// ── VIDEO CLEANUP ─────────────────────────────────────────────────────────
app.post('/api/delete-video', async (req, res) => {
  try {
    const { fileName } = req.body;
    if (!fileName) return res.status(400).json({ success: false, message: 'Missing fileName' });
    if (fileName.includes('..') || fileName.includes('//')) return res.status(400).json({ success: false, message: 'Invalid fileName' });
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
    const deleteUrl = `${SUPABASE_URL}/storage/v1/object/videos/${fileName}`;
    const response = await fetch(deleteUrl, { method: 'DELETE', headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } });
    if (response.ok) res.json({ success: true, message: 'Video deleted' });
    else { const errorText = await response.text(); res.json({ success: true, message: 'Deletion attempted', warning: errorText }); }
  } catch (err) {
    res.json({ success: true, message: 'Deletion attempted', error: err.message });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy', timestamp: new Date().toISOString(), environment: NODE_ENV,
    services: { gemini: !!GOOGLE_API_KEY, email: !!RESEND_API_KEY, stripe: !!stripe, firebase: !!db }
  });
});

app.use((req, res) => res.status(404).json({ success: false, message: 'Endpoint not found' }));
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ success: false, message: IS_PRODUCTION ? 'Internal server error' : err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('----------------------------------------------------');
  console.log(`🚀 PrepMMI server running`);
  console.log(`📡 Environment: ${NODE_ENV}`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log('----------------------------------------------------');
  console.log('Endpoints:');
  console.log(`  POST /api/analyze`);
  console.log(`  POST /api/get-circuit`);
  console.log(`  POST /api/send-email`);
  console.log(`  POST /api/stripe-webhook`);
  console.log(`  POST /api/create-user`);
  console.log(`  POST /api/admin/create-user`);
  console.log(`  GET  /api/admin/recent-purchases`);
  console.log(`  POST /api/delete-video`);
  console.log(`  GET  /api/health`);
  console.log('----------------------------------------------------');
});
