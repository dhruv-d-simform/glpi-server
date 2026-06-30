'use strict';

/*
 * glpi-server — POC inventory receiver
 * ------------------------------------
 * Receives inventory from a GLPI Agent that is pointed at this server with
 * `--server http://<host>:<port>/` and stores each inventory submission as a
 * JSON file under ./db/.
 *
 * The GLPI Agent only sends inventory as JSON once it believes the target is a
 * "GLPI server". It proves this with a small handshake before sending data:
 *
 *   1. PROLOG  — a legacy XML probe. We answer with a JSON status message,
 *                which makes the agent switch into GLPI native (JSON) mode.
 *   2. CONTACT — a JSON `{"action":"contact"}` message. We answer "ok" and
 *                advertise that we accept the inventory task.
 *   3. INVENTORY — a JSON `{"action":"inventory", "content": {...}}` message.
 *                This is the payload we care about. We validate it against the
 *                official GLPI inventory JSON schema and write it to ./db/.
 *
 * For the real backend you do NOT need Express or Ajv — any framework that can
 * accept an HTTP POST, (optionally) inflate the body, and parse JSON will do.
 * Those packages are used here only to keep the POC short and readable.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib'); // Node built-in — no dependency
const express = require('express');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const PORT = process.env.PORT || 8080;
const DB_DIR = path.join(__dirname, 'db');
const SCHEMA_PATH = path.join(__dirname, 'schema', 'inventory.schema.json');

// HTTP Basic Auth — hard-coded dummy credentials for the POC demo.
const AUTH_USER = 'glpi-agent';
const AUTH_PASS = 'inventory-secret';

fs.mkdirSync(DB_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// JSON Schema validation (official GLPI inventory format)
// ---------------------------------------------------------------------------
let validateInventory = null;
try {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  // strict:false — the published schema uses a few non-standard keywords
  // (e.g. "version") that we don't want to hard-fail on.
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  validateInventory = ajv.compile(schema);
  console.log('[schema] loaded GLPI inventory schema for validation');
} catch (err) {
  console.warn('[schema] could not load schema, validation disabled:', err.message);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The agent may compress the body (zlib/gzip) unless run with --no-compression.
// We transparently inflate it so the POC works either way.
function decodeBody(buf, contentType) {
  const type = (contentType || '').toLowerCase();
  try {
    if (type.includes('x-compress-zlib')) return zlib.inflateSync(buf).toString('utf8');
    if (type.includes('x-compress-gzip')) return zlib.gunzipSync(buf).toString('utf8');
  } catch (err) {
    console.warn('[decode] decompression failed, trying raw:', err.message);
  }
  return buf.toString('utf8');
}

function sanitize(name) {
  return String(name || 'unknown-device').replace(/[^A-Za-z0-9._-]/g, '_');
}

// Avoids Date.now collisions and is filename-safe: 2026-06-30T11-12-13-123Z
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function saveInventory(message) {
  const deviceid = sanitize(message.deviceid);
  const file = path.join(DB_DIR, `${deviceid}__${timestamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(message, null, 2));
  return file;
}

// Check the Authorization header against our hard-coded Basic credentials.
// Returns true if the request is authenticated.
function isAuthenticated(req) {
  const header = req.headers['authorization'] || '';
  const [scheme, encoded] = header.split(' ');
  if ((scheme || '').toLowerCase() !== 'basic' || !encoded) return false;

  // "Basic <base64(user:password)>" -> "user:password"
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  return user === AUTH_USER && pass === AUTH_PASS;
}

// Send the 401 challenge that makes the agent retry WITH credentials.
function sendAuthChallenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="glpi-server"');
  return res.status(401).json({ status: 'error', message: 'authentication required' });
}

// A valid GLPI server reply: status + expiration (hours, must be > 0).
function okContact(extra) {
  return Object.assign({ status: 'ok', expiration: 24 }, extra || {});
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const app = express();

// Capture the raw body for every content type — we need to detect XML vs JSON
// and inflate it ourselves.
app.use(express.raw({ type: () => true, limit: '64mb' }));

app.get('/', (_req, res) => {
  res.json({ service: 'glpi-server', status: 'up', hint: 'POST inventory here' });
});

// The agent posts to the server root (or whatever path is in --server). Accept
// any path so configuration mistakes don't break the POC.
app.post('*', (req, res) => {
  const agentId = req.headers['glpi-agent-id'] || '-';

  // HTTP Basic Auth gate. The agent sends NO credentials on its first try, so
  // we answer 401 + WWW-Authenticate; it then retries with the Authorization
  // header and lands here again, this time authenticated.
  if (!isAuthenticated(req)) {
    console.log(`[401]    agent=${agentId} -> challenging for Basic auth`);
    return sendAuthChallenge(res);
  }

  const raw = decodeBody(req.body, req.headers['content-type']);

  // Step 1: legacy PROLOG probe (XML). Reply JSON to flip the agent into
  // GLPI native mode.
  if (raw.trimStart().startsWith('<?xml') || raw.includes('<QUERY>PROLOG')) {
    console.log(`[prolog]  agent=${agentId} -> answering as GLPI server`);
    return res.json(okContact());
  }

  // Otherwise it should be a JSON message.
  let message;
  try {
    message = JSON.parse(raw);
  } catch (err) {
    console.warn('[error]  could not parse body as JSON:', err.message);
    return res.status(400).json({ status: 'error', message: 'invalid JSON' });
  }

  // Step 3: the inventory payload — this is what we store.
  if (message.action === 'inventory') {
    if (validateInventory) {
      const valid = validateInventory(message);
      if (valid) {
        console.log(`[valid]  inventory for ${message.deviceid} passes schema`);
      } else {
        console.warn(
          `[warn]   inventory for ${message.deviceid} has ${validateInventory.errors.length} schema issue(s); ` +
          'storing anyway. First few:'
        );
        validateInventory.errors.slice(0, 5).forEach((e) =>
          console.warn(`           - ${e.instancePath || '/'} ${e.message}`)
        );
      }
    }
    const file = saveInventory(message);
    console.log(`[saved]  ${path.relative(__dirname, file)}`);
    return res.json({ status: 'ok' });
  }

  // Step 2: CONTACT handshake (or anything else) — accept and advertise the
  // inventory task so the agent proceeds to send it.
  console.log(`[contact] agent=${agentId} action=${message.action || '-'}`);
  return res.json(okContact({ tasks: { inventory: {} } }));
});

app.listen(PORT, () => {
  console.log(`glpi-server listening on http://localhost:${PORT}`);
  console.log(`storing inventories in ${DB_DIR}`);
  console.log(`Basic auth required: user="${AUTH_USER}" pass="${AUTH_PASS}"`);
});
