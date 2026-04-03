/**
 * Firestore Admin for AI usage control. Backend is source of truth.
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON (stringified JSON) or GOOGLE_APPLICATION_CREDENTIALS path.
 */
let admin;
let db;

function getAdmin() {
  if (admin) return admin;
  try {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      const key = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (key && key.trim()) {
        const cred = JSON.parse(key);
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
    return admin;
  } catch (e) {
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

module.exports = { getAdmin, getDb };
