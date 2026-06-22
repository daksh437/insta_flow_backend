/**
 * Firestore Admin for AI usage control. Backend is source of truth.
 *
 * Auth (one of):
 * - FIREBASE_SERVICE_ACCOUNT_JSON — stringified service account JSON in .env
 * - GOOGLE_APPLICATION_CREDENTIALS — path to service account JSON file
 *
 * Project:
 * - FIREBASE_PROJECT_ID or GCLOUD_PROJECT (default: instaflow-f65a0)
 */
let admin;
let db;
let initError = null;

const DEFAULT_PROJECT_ID = 'instaflow-f65a0';

function resolveProjectId(cred) {
  return (
    cred?.project_id ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    DEFAULT_PROJECT_ID
  );
}

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

function hasCredentialEnv() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return (typeof json === 'string' && json.trim().length > 0) ||
    (typeof credPath === 'string' && credPath.trim().length > 0);
}

function getAdmin() {
  if (admin) return admin;
  try {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      const key = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      const projectId = resolveProjectId();

      if (key && key.trim()) {
        const cred = normalizeServiceAccount(key);
        admin.initializeApp({
          credential: admin.credential.cert(cred),
          projectId: resolveProjectId(cred),
        });
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({ projectId });
      } else {
        throw new Error(
          'Missing Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON in backend/.env ' +
          'or GOOGLE_APPLICATION_CREDENTIALS pointing to a service account JSON file. ' +
          `Download from Firebase Console → Project Settings → Service accounts → Generate new private key (${DEFAULT_PROJECT_ID}).`,
        );
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
  if (!a) return null;
  db = a.firestore();
  return db;
}

function getInitStatus() {
  const serviceAccountPresent =
    typeof process.env.FIREBASE_SERVICE_ACCOUNT_JSON === 'string' &&
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim().length > 0;
  const applicationCredentialsPresent =
    typeof process.env.GOOGLE_APPLICATION_CREDENTIALS === 'string' &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.trim().length > 0;
  return {
    firestoreReady: !!getDb(),
    serviceAccountPresent,
    applicationCredentialsPresent,
    hasCredentialEnv: hasCredentialEnv(),
    projectId: resolveProjectId(),
    initError: initError ? String(initError.message || initError) : null,
  };
}

module.exports = { getAdmin, getDb, getInitStatus, DEFAULT_PROJECT_ID };
