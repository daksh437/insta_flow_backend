/**
 * Firestore Admin for AI usage control. Backend is source of truth.
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON (stringified JSON) or GOOGLE_APPLICATION_CREDENTIALS path.
 */
let admin;
let db;
let initError = null;

function normalizeServiceAccount(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must be a valid JSON object');
  }
  if (!parsed.project_id) {
    throw new Error('Service account missing project_id');
  }
  if (!parsed.client_email) {
    throw new Error('Service account missing client_email');
  }
  if (!parsed.private_key) {
    throw new Error('Service account missing private_key');
  }
  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  return parsed;
}

function getAdmin() {
  if (admin) return admin;
  try {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      const key = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (key && key.trim()) {
        const cred = normalizeServiceAccount(key);
        const projectId = cred.project_id || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
        admin.initializeApp({
          credential: admin.credential.cert(cred),
          ...(projectId && { projectId }),
        });
      } else {
        const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
        admin.initializeApp({
          ...(projectId && { projectId }),
        });
      }
    }
    initError = null;
    return admin;
  } catch (e) {
    initError = e;
    console.warn('[FirestoreAdmin] init failed:', e.message);
    return null;
  }
}

function getDb() {
  if (db) return db;
  const a = getAdmin();
  db = a ? a.firestore() : null;
  return db;
}

function getInitStatus() {
  const serviceAccountPresent =
    typeof process.env.FIREBASE_SERVICE_ACCOUNT_JSON === 'string' &&
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim().length > 0;
  return {
    firestoreReady: !!getDb(),
    serviceAccountPresent,
    initError: initError ? String(initError.message || initError) : null,
  };
}

module.exports = { getAdmin, getDb, getInitStatus };
