const fs = require('fs');
const path = require('path');

const storePath = process.env.TOKEN_STORE_PATH || './data/tokens.json';

function ensureStore() {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(storePath)) {
    fs.writeFileSync(storePath, JSON.stringify({}), 'utf-8');
  }
}

function readStore() {
  ensureStore();
  const raw = fs.readFileSync(storePath, 'utf-8');
  return raw ? JSON.parse(raw) : {};
}

function writeStore(data) {
  ensureStore();
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf-8');
}

function saveTokens(userId, tokens) {
  const store = readStore();
  store[userId] = tokens;
  writeStore(store);
}

function getTokens(userId) {
  const store = readStore();
  return store[userId] || null;
}

function hasTokens(userId) {
  const store = readStore();
  return !!store[userId];
}

module.exports = {
  saveTokens,
  getTokens,
  hasTokens,
};

