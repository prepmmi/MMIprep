// server.js — Multi-vertical backend (Denterview + PrepMMI) on one Railway service
// Denterview keeps its existing Payhip flow untouched.
// PrepMMI is new: Stripe Checkout + its own Firebase project, same repeat-customer logic.

import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import Stripe from 'stripe';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

// ── SHARED ENV VARS ──────────────────────────────────────────────────────
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const PAYHIP_API_KEY = process.env.PAYHIP_API_KEY; // Denterview only
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY; // PrepMMI (and eventually Denterview)
const STRIPE_WEBHOOK_SECRET_PREPMMI = process.env.STRIPE_WEBHOOK_SECRET_PREPMMI;
const GOOGLE_ADS_CONVERSION_ID = process.env.GOOGLE_ADS_CONVERSION_ID || 'AW-17341313917';
const GOOGLE_ADS_CONVERSION_LABEL = process.env.GOOGLE_ADS_CONVERSION_LABEL || 'REPLACE_WITH_YOUR_LABEL';

if (!GOOGLE_API_KEY) {
  console.error('❌ CRITICAL: GOOGLE_API_KEY not set');
  process.exit(1);
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
if (!stripe) console.warn('⚠️  STRIPE_SECRET_KEY not set — PrepMMI checkout webhook will not work yet');

// ── VERTICAL CONFIG ──────────────────────────────────────────────────────
// Add a new product line here later (e.g. a third vertical) without touching
// the route logic below — everything reads from this table.
const VERTICALS = {
  denterview: {
    label: 'Denterview AI',
    emailFrom: process.env.EMAIL_FROM_DENTERVIEW || 'Denterview AI <onboarding@resend.dev>',
    appUrl: 'https://www.denterviewai.com',
    firebaseKeyFile: './firebase-admin-key.json',           // existing file, unchanged
    firebaseKeyEnv: 'FIREBASE_ADMIN_KEY',                    // existing env var, unchanged
    unitLabel: 'interview',
    unitLabelPlural: 'interviews',
  },
  prepmmi: {
    label: 'PrepMMI',
    emailFrom: process.env.EMAIL_FROM_PREPMMI || 'PrepMMI <onboarding@resend.dev>',
    appUrl: 'https://www.prepmmi.com',
    firebaseKeyFile: './firebase-admin-key-prepmmi.json',    // new file — separate Firebase project
    firebaseKeyEnv: 'FIREBASE_ADMIN_KEY_PREPMMI',            // new env var
    unitLabel: 'circuit',
    unitLabelPlural: 'circuits',
  },
};

// Decide which vertical a request belongs to, based on the Host header.
// Falls back to denterview so nothing existing breaks if this ever gets hit
// from an unexpected host.
function getVertical(req) {
  const host = (req.hostname || '').toLowerCase();
  if (host.includes('prepmmi')) return 'prepmmi';
  return 'denterview';
}

// ── FIREBASE ADMIN — ONE APP PER VERTICAL ────────────────────────────────
// firebase-admin supports multiple named apps in one process; we keep a
// { db, auth } pair per vertical in this map.
const firebaseByVertical = {};

async function initFirebaseForVertical(key, config) {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');

  let serviceAccount;
  try {
    const keyFile = readFileSync(config.firebaseKeyFile, 'utf8');
    serviceAccount = JSON.parse(keyFile);
    console.log(`✅ [${key}] Loaded Firebase key from file`);
  } catch (fileError) {
    const envVal = process.env[config.firebaseKeyEnv];
    if (envVal) {
      serviceAccount = JSON.parse(envVal);
      console.log(`✅ [${key}] Loaded Firebase key from ${config.firebaseKeyEnv}`);
    } else {
      console.warn(`⚠️  [${key}] No Firebase key found (checked ${config.firebaseKeyFile} and ${config.firebaseKeyEnv}) — this vertical will not work until configured`);
      return;
    }
  }

  const firebaseApp = initializeApp({ credential: cert(serviceAccount) }, key); // named app = key
  firebaseByVertical[key] = {
    db: getFirestore(firebaseApp),
    auth: getAuth(firebaseApp),
  };
  console.log(`✅ [${key}] Firebase Admin initialized`);
}

for (const [key, config] of Object.entries(VERTICALS)) {
  await initFirebaseForVertical(key, config);
}

if (!firebaseByVertical.denterview) {
  console.error('❌ CRITICAL: Denterview Firebase failed to initialize');
  process.exit(1);
}

// ── EMAIL (Resend — shared across verticals, only the "from" address differs) ──
async function sendEmail(from, to, subject, html, text) {
  if (!RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY not configured - skipping email');
    return { success: false, error: 'Email service not configured' };
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text })
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

// ── STRIPE WEBHOOK (PrepMMI) — MUST be registered before express.json() ──
// Stripe requires the raw request body to verify the signature, so this
// route uses express.raw() and is defined before the global JSON parser
// below touches the request.
app.post('/api/prepmmi/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET_PREPMMI) {
    console.error('❌ Stripe not configured for PrepMMI webhook');
    return res.status(500).send('Stripe not configured');
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET_PREPMMI);
  } catch (err) {
    console.error('❌ Stripe signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Ack immediately so Stripe doesn't retry while we do the slow stuff
  res.status(200).json({ received: true });

  if (event.type !== 'checkout.session.completed') {
    console.log(`⏭️  Ignoring Stripe event type: ${event.type}`);
    return;
  }

  try {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    if (!email) {
      console.error('❌ Stripe session had no customer email');
      return;
    }
    const sanitizedEmail = sanitizeEmail(email);

    // Pull line items to find what was actually purchased
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      expand: ['data.price.product'],
    });
    const item = lineItems.data[0];
    const price = item?.price;
    const product = price?.product;

    // Circuit count comes from Price metadata first (set this when you create
    // each Stripe Price — metadata.circuits = "5" etc.), falling back to a
    // lookup table keyed by Price ID if you forget to set metadata.
    const PRICE_CIRCUIT_FALLBACK = {
      // 'price_XXXXXXXXXXXX': 1,   // Starter
      // 'price_XXXXXXXXXXXX': 3,   // Confidence
      // 'price_XXXXXXXXXXXX': 5,   // Mastery
      // 'price_XXXXXXXXXXXX': 8,   // Expert
      // 'price_XXXXXXXXXXXX': 12,  // Full Prep
      // Fill these in once you've created the Stripe Prices, as a backup
      // in case metadata isn't set on a given price.
    };

    let circuitCount = parseInt(price?.metadata?.circuits, 10);
    if (!circuitCount) {
      circuitCount = PRICE_CIRCUIT_FALLBACK[price?.id] || null;
    }
    if (!circuitCount) {
      console.error(`⚠️  UNKNOWN PREPMMI PRICE — no circuits metadata or fallback for price ${price?.id} (product: ${product?.name}). Defaulting to 1.`);
      console.error(`⚠️  Fix: add metadata.circuits on the Stripe Price, or add it to PRICE_CIRCUIT_FALLBACK in server.js`);
      circuitCount = 1;
    }

    console.log(`📦 [prepmmi] ${sanitizedEmail} bought ${circuitCount} circuits (price: ${price?.id})`);

    const randomPassword = generateUserId().substring(0, 12);
    const result = await createAppUser('prepmmi', sanitizedEmail, randomPassword, circuitCount);

    console.log(result.isNewUser ? `✨ New PrepMMI customer: ${sanitizedEmail}` : `🔄 Returning PrepMMI customer: ${sanitizedEmail}`);

    await sendWelcomeEmail('prepmmi', sanitizedEmail, randomPassword, circuitCount, !result.isNewUser);

    console.log('✅ [prepmmi] Stripe webhook processing complete');
  } catch (err) {
    console.error('❌ [prepmmi] Stripe webhook error:', err);
  }
});

// ── STANDARD MIDDLEWARE (everything below this line sees parsed JSON) ────
app.use(cors({
  origin: IS_PRODUCTION ? process.env.ALLOWED_ORIGINS?.split(',') : true,
  credentials: true
}));
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} (${getVertical(req)})`);
  next();
});

// Rate limiting (unchanged, shared across verticals)
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 100;
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  const limit = rateLimits.get(ip);
  if (now > limit.resetTime) {
    limit.count = 1;
    limit.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }
  if (limit.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
  }
  limit.count++;
  next();
}
app.use('/api/', rateLimit);

// ── HELPERS ───────────────────────────────────────────────────────────────
function base64ToPart(base64Data, mimeType) {
  return { inlineData: { data: base64Data, mimeType } };
}

function generateUserId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segments = [4, 4, 4, 4];
  return segments.map(length =>
    Array(length).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('')
  ).join('-');
}

function sanitizeEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    throw new Error('Invalid email format');
  }
  return email.toLowerCase().trim();
}

// Used only by /api/create-user for manual provisioning of Denterview accounts.
// Denterview's Payhip webhook logic uses its own INTERVIEW_PRODUCTS table below.
function getInterviewCountForProduct(productId) {
  const productMap = {
    'starter-pack': 2, 'confidence-pack': 3, 'mastery-pack': 5,
    'expert-pack': 8, 'acceptance-pack': 12,
    'interview-bundle': 3, 'complete-bundle': 3,
    '2-pack': 2, '3-pack': 3, '5-pack': 5, '8-pack': 8, '12-pack': 12,
    'single-interview': 1
  };
  return productMap[productId?.toLowerCase()] || 1;
}

// ── ACCOUNT CREATION / CREDIT MANAGEMENT (vertical-aware) ────────────────
// This is the function that makes repeat customers work correctly no
// matter which payment processor triggered it — it always checks for an
// existing account by email first and ADDS to their balance, rather than
// overwriting. Same logic Denterview already relied on via Payhip; now
// shared by PrepMMI via Stripe too.
async function createAppUser(vertical, email, password, unitCount) {
  const { db, auth } = firebaseByVertical[vertical] || {};
  if (!db || !auth) {
    throw new Error(`Firebase not initialized for vertical: ${vertical}`);
  }

  try {
    const userRecord = await auth.createUser({ email, password, emailVerified: false });
    console.log(`✅ [${vertical}] Created Firebase Auth user: ${userRecord.uid}`);

    const userRef = db.collection('artifacts').doc('default-app-id')
      .collection('public').doc('data').collection('users').doc(userRecord.uid);

    await userRef.set({
      email,
      totalUnits: unitCount,
      unitsRemaining: unitCount,
      completedPools: [],
      currentPoolId: null,
      interviewHistory: [],
      createdAt: new Date().toISOString(),
      lastLogin: null,
      lastPurchaseDate: new Date().toISOString()
    });

    console.log(`✅ [${vertical}] Created Firestore user: ${userRecord.uid} with ${unitCount} units`);
    return { userId: userRecord.uid, isNewUser: true };
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      const userRecord = await auth.getUserByEmail(email);
      const userRef = db.collection('artifacts').doc('default-app-id')
        .collection('public').doc('data').collection('users').doc(userRecord.uid);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        await userRef.set({
          email,
          totalUnits: unitCount,
          unitsRemaining: unitCount,
          completedPools: [],
          currentPoolId: null,
          interviewHistory: [],
          createdAt: new Date().toISOString(),
          lastLogin: null,
          lastPurchaseDate: new Date().toISOString()
        });
        console.log(`✅ [${vertical}] Re-created Firestore data for ${userRecord.uid} — added ${unitCount} units`);
        return { userId: userRecord.uid, isNewUser: true };
      } else {
        const currentData = userDoc.data();
        const newTotal = (currentData.totalUnits || 0) + unitCount;
        const newRemaining = (currentData.unitsRemaining || 0) + unitCount;
        await userRef.update({
          totalUnits: newTotal,
          unitsRemaining: newRemaining,
          lastPurchaseDate: new Date().toISOString()
        });
        console.log(`✅ [${vertical}] Repeat customer ${userRecord.uid} — added ${unitCount} units (now ${newRemaining} remaining)`);
        return { userId: userRecord.uid, isNewUser: false };
      }
    }
    throw error;
  }
}

async function sendWelcomeEmail(vertical, email, password, unitCount, isReturning = false) {
  const config = VERTICALS[vertical];
  const unitWord = unitCount === 1 ? config.unitLabel : config.unitLabelPlural;

  const subject = isReturning
    ? `${config.label} - ${unitCount === 1 ? 'Circuit' : 'Circuits'} Added!`
    : `Welcome to ${config.label}`;

  const welcomeMessage = isReturning
    ? `<p style="font-size: 16px; color: #374151;">Thanks for coming back! We've added <strong>${unitCount} ${unitWord}</strong> to your account.</p>`
    : `<p style="font-size: 16px; color: #374151;">Thanks for your purchase! You now have <strong>${unitCount} ${unitWord}</strong> ready to go.</p>`;

  const credentialsSection = !isReturning ? `
    <div style="background: white; padding: 20px; border-radius: 8px; border: 2px solid #111827; margin: 20px 0;">
      <p style="color: #6b7280; margin: 0 0 10px 0; font-size: 14px;">Your Login Credentials:</p>
      <p style="font-size: 16px; color: #374151; margin: 5px 0;"><strong>Email:</strong> ${email}</p>
      <p style="font-size: 16px; color: #374151; margin: 5px 0;"><strong>Password:</strong> <code style="background: #f3f4f6; padding: 4px 8px; border-radius: 4px; font-family: monospace;">${password}</code></p>
      <p style="color: #ef4444; font-size: 13px; margin-top: 10px;">⚠️ Save these credentials and change your password after logging in.</p>
      <div style="margin-top: 25px; padding: 20px; background: #f0f4ff; border-radius: 8px; text-align: center;">
        <p style="font-size: 16px; color: #374151; margin: 0;">
          Go to <a href="${config.appUrl}/app" style="color: #111827; font-weight: bold; text-decoration: none;">${config.appUrl.replace('https://www.', '')}/app</a> to start.
        </p>
      </div>
    </div>
  ` : '';

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #111827; padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0;">${isReturning ? 'Welcome Back!' : `Welcome to ${config.label}!`}</h1>
      </div>
      <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px;">
        ${welcomeMessage}
        ${credentialsSection}
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
        <p style="color: #9ca3af; font-size: 12px; text-align: center;">Questions? Reply to this email for support.</p>
      </div>
    </div>
  `;

  const textContent = `${isReturning ? 'Welcome Back!' : `Welcome to ${config.label}!`}\n\n` +
    `You now have ${unitCount} ${unitWord}.\n` +
    (!isReturning ? `\nLogin: ${email} / ${password}\n\nGo to ${config.appUrl}/app to start.\n` : '');

  const result = await sendEmail(config.emailFrom, email, subject, htmlContent, textContent);
  if (!result.success) console.error(`❌ Failed to send email to ${email}:`, result.error);
}

// Google Ads conversion (Denterview only for now)
async function sendGoogleAdsConversion(value, currency, transactionId) {
  try {
    if (GOOGLE_ADS_CONVERSION_LABEL === 'REPLACE_WITH_YOUR_LABEL') {
      console.warn('⚠️  Google Ads conversion label not set - skipping conversion hit');
      return;
    }
    const params = new URLSearchParams({
      v: '2', t: 'event', tid: GOOGLE_ADS_CONVERSION_ID, en: 'conversion',
      'epn.value': value.toString(), 'epn.currency': currency, 'epn.transaction_id': transactionId,
      'aw_merchant_id': GOOGLE_ADS_CONVERSION_ID, 'aw_feed_country': 'US', 'aw_feed_language': 'EN',
    });
    const response = await fetch(`https://www.google-analytics.com/g/collect?${params.toString()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (response.ok) console.log(`📊 Google Ads conversion fired (txn: ${transactionId})`);
  } catch (error) {
    console.warn('⚠️  Google Ads conversion hit failed (non-blocking):', error.message);
  }
}

function verifyPayhipWebhook(req) {
  if (!PAYHIP_API_KEY) {
    console.error('❌ PAYHIP_API_KEY not configured');
    return false;
  }
  const signature = req.body.signature;
  if (!signature) {
    console.error('❌ No signature in webhook');
    return false;
  }
  const hash = crypto.createHash('sha256').update(PAYHIP_API_KEY).digest('hex');
  if (signature !== hash) {
    console.error('❌ INVALID WEBHOOK SIGNATURE - Possible attack!');
    return false;
  }
  return true;
}

// ── STATIC SERVING — pick the right site by Host header ──────────────────
// Put each vertical's frontend in its own folder:
//   public/denterview/  (existing index.html, app assets)
//   public/prepmmi/     (new landing page + app)
app.get('/', (req, res) => {
  const vertical = getVertical(req);
  res.sendFile(`index.html`, { root: `./public/${vertical}` });
});
app.use('/app', (req, res, next) => {
  const vertical = getVertical(req);
  express.static(`./public/${vertical}/app`)(req, res, next);
});
app.use(express.static('./public/shared')); // shared assets (fonts, images) if any

// ── AI ANALYSIS (shared — both apps call this the same way) ──────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { systemInstruction, userPrompt, imageBase64, videoBase64 } = req.body;
    if (!userPrompt || !systemInstruction) {
      return res.status(400).json({ success: false, message: 'Missing required data' });
    }
    if (videoBase64 && videoBase64.length > 100 * 1024 * 1024) {
      return res.status(413).json({ success: false, message: 'Video data too large' });
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_API_KEY}`;
    const contents = [{ text: userPrompt }];
    if (videoBase64) contents.push(base64ToPart(videoBase64, 'video/webm'));
    if (imageBase64) contents.push(base64ToPart(imageBase64, 'image/jpeg'));

    const payload = {
      contents: [{ role: 'user', parts: contents }],
      systemInstruction: { parts: [{ text: systemInstruction }] }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 240 * 1000);
    let gResp;
    try {
      gResp = await fetch(apiUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal,
      });
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') {
        return res.status(504).json({ success: false, message: 'Analysis timed out' });
      }
      throw fetchErr;
    } finally {
      clearTimeout(timeoutId);
    }

    const gBody = await gResp.text();
    if (!gResp.ok) {
      let parsed;
      try { parsed = JSON.parse(gBody); } catch (e) { parsed = { text: gBody }; }
      const errorMessage = IS_PRODUCTION ? 'Analysis service temporarily unavailable' : `Upstream error: ${parsed.message || gResp.statusText}`;
      console.error('❌ Gemini API Error:', parsed);
      return res.status(502).json({ success: false, message: errorMessage });
    }

    let parsedResp;
    try { parsedResp = JSON.parse(gBody); } catch (e) {
      parsedResp = { candidates: [{ content: { parts: [{ text: gBody || "Analysis failed." }] } }] };
    }
    return res.json({ success: true, data: parsedResp });
  } catch (err) {
    console.error('❌ Server error during analysis:', err);
    const errorMessage = IS_PRODUCTION ? 'Internal server error' : err.message;
    return res.status(500).json({ success: false, message: errorMessage });
  }
});

// ── EMAIL SENDING (generic results email, shared) ─────────────────────────
app.post('/api/send-email', async (req, res) => {
  try {
    const { email, content } = req.body;
    if (!email || !content) return res.status(400).json({ success: false, message: 'Missing email or content' });
    const sanitizedEmail = sanitizeEmail(email);
    if (content.length > 500000) return res.status(413).json({ success: false, message: 'Content too large' });

    const vertical = getVertical(req);
    const config = VERTICALS[vertical];

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #111827;">Your ${config.label} Results</h2>
        <p>Here are your detailed results:</p>
        <div style="white-space: pre-wrap; background: #f5f5f5; padding: 20px; border-radius: 8px;">
          ${content.replace(/\n/g, '<br>')}
        </div>
      </div>`;

    const result = await sendEmail(config.emailFrom, sanitizedEmail, `Your ${config.label} Results`, htmlContent, content);
    if (result.success) {
      res.json({ success: true, message: 'Email sent successfully', messageId: result.id });
    } else {
      res.status(500).json({ success: false, message: 'Failed to send email', error: result.error });
    }
  } catch (err) {
    console.error('❌ Email error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send email' });
  }
});

// ── DENTERVIEW PAYHIP WEBHOOK (unchanged behavior, now calls createAppUser) ──
app.post('/api/payhip-webhook', async (req, res) => {
  try {
    console.log('📥 Received Payhip webhook');
    if (!verifyPayhipWebhook(req)) {
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }
    res.status(200).json({ success: true, message: 'Webhook received' });

    const { type, email, currency, price, items } = req.body;
    if (type !== 'paid') return;
    if (!email || !items || items.length === 0) {
      console.error('❌ Invalid webhook data');
      return;
    }

    const sanitizedEmail = sanitizeEmail(email);
    const product = items[0];
    const productName = product.product_name;
    const productNameLower = productName.toLowerCase().trim();

    const INTERVIEW_PRODUCTS = [
      { match: 'starter', interviews: 2, label: 'Starter Pack (2)' },
      { match: 'confidence', interviews: 3, label: 'Confidence Pack (3)' },
      { match: 'mastery', interviews: 5, label: 'Mastery Pack (5)' },
      { match: 'expert', interviews: 8, label: 'Expert Pack (8)' },
      { match: 'acceptance', interviews: 12, label: 'Acceptance Pack (12)' },
      { match: 'ultimate interview prep bundle', interviews: 3, label: 'Ultimate Interview Prep Bundle (3)' },
      { match: 'complete dental school prep bundle', interviews: 3, label: 'Complete Dental School Prep Bundle (3)' },
    ];
    const SKIP_KEYWORDS = [
      'essential dental school', 'essential questions', 'questions and approach',
      'full package', 'personal statement', 'ps review', 'second round', 'rush 24',
    ];

    if (SKIP_KEYWORDS.some(kw => productNameLower.includes(kw))) {
      console.log(`⏭️  Skipping guide/PS product (no AI interviews): "${productName}"`);
      return;
    }

    const matched = INTERVIEW_PRODUCTS.find(p => productNameLower.includes(p.match));
    let interviewCount;
    if (matched) {
      interviewCount = matched.interviews;
    } else {
      interviewCount = 1;
      console.error(`⚠️  UNKNOWN PRODUCT: "${productName}" — add to INTERVIEW_PRODUCTS or SKIP_KEYWORDS`);
    }

    const randomPassword = generateUserId().substring(0, 12);
    const result = await createAppUser('denterview', sanitizedEmail, randomPassword, interviewCount);

    const transactionId = `payhip-${Date.now()}-${result.userId}`;
    await sendGoogleAdsConversion(parseFloat(price) || 25.0, (currency || 'USD').toUpperCase(), transactionId);
    await sendWelcomeEmail('denterview', sanitizedEmail, randomPassword, interviewCount, !result.isNewUser);

    console.log('✅ Denterview webhook processing complete');
  } catch (err) {
    console.error('❌ Webhook error:', err);
  }
});

// ── MANUAL USER CREATION (both verticals — pass ?vertical=prepmmi or denterview) ──
app.post('/api/create-user', async (req, res) => {
  try {
    const { email, password, interviewCount, vertical } = req.body;
    const v = VERTICALS[vertical] ? vertical : 'denterview';

    if (!email || !password || !interviewCount) {
      return res.status(400).json({ success: false, message: 'Missing email, password, or interviewCount' });
    }
    const sanitizedEmail = sanitizeEmail(email);
    if (interviewCount < 1 || interviewCount > 100) {
      return res.status(400).json({ success: false, message: 'Invalid interview count (must be 1-100)' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const result = await createAppUser(v, sanitizedEmail, password, interviewCount);
    await sendWelcomeEmail(v, sanitizedEmail, password, interviewCount, !result.isNewUser);

    res.json({
      success: true, userId: result.userId, email: sanitizedEmail,
      interviewCount, isReturning: !result.isNewUser,
      message: result.isNewUser ? 'User created' : 'Credits added'
    });
  } catch (err) {
    console.error('❌ Create user error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to create user' });
  }
});

// ── VIDEO CLEANUP (unchanged) ──────────────────────────────────────────────
app.post('/api/delete-video', async (req, res) => {
  try {
    const { fileName } = req.body;
    if (!fileName) return res.status(400).json({ success: false, message: 'Missing fileName' });
    if (fileName.includes('..') || fileName.includes('//')) {
      return res.status(400).json({ success: false, message: 'Invalid fileName' });
    }
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
    const deleteUrl = `${SUPABASE_URL}/storage/v1/object/videos/${fileName}`;
    const response = await fetch(deleteUrl, { method: 'DELETE', headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } });
    if (response.ok) {
      res.json({ success: true, message: 'Video deleted' });
    } else {
      const errorText = await response.text();
      res.json({ success: true, message: 'Deletion attempted', warning: errorText });
    }
  } catch (err) {
    res.json({ success: true, message: 'Deletion attempted', error: err.message });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    verticals: Object.fromEntries(
      Object.keys(VERTICALS).map(v => [v, { firebase: !!firebaseByVertical[v] }])
    ),
    services: {
      gemini: !!GOOGLE_API_KEY,
      email: !!RESEND_API_KEY,
      payhip: !!PAYHIP_API_KEY,
      stripe: !!stripe,
    }
  });
});

app.use((req, res) => res.status(404).json({ success: false, message: 'Endpoint not found' }));
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ success: false, message: IS_PRODUCTION ? 'Internal server error' : err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('----------------------------------------------------');
  console.log(`🚀 Multi-vertical server running (Denterview + PrepMMI)`);
  console.log(`📡 Environment: ${NODE_ENV}`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log('----------------------------------------------------');
  console.log('Endpoints:');
  console.log(`  POST /api/analyze`);
  console.log(`  POST /api/send-email`);
  console.log(`  POST /api/payhip-webhook          (Denterview)`);
  console.log(`  POST /api/prepmmi/stripe-webhook  (PrepMMI)`);
  console.log(`  POST /api/create-user`);
  console.log(`  POST /api/delete-video`);
  console.log(`  GET  /api/health`);
  console.log('----------------------------------------------------');
});
