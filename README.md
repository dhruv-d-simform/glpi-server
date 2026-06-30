# glpi-server (POC)

A minimal **proof-of-concept** server that receives hardware/software inventory
from a [GLPI Agent](https://github.com/glpi-project/glpi-agent) over GLPI's
**native JSON protocol** and stores each submission as a JSON file under `db/`.

This is a reference for backend developers — it shows exactly what the agent
sends, how the small handshake works, and what the JSON looks like, so the real
system can be built against it.

---

## What it does

1. A GLPI Agent is pointed at this server (`--server http://localhost:8080/`).
2. The agent performs a tiny handshake, then POSTs its inventory as JSON.
3. The server validates the payload against the official GLPI inventory schema
   and writes it to `db/<deviceid>__<timestamp>.json`.

No database, no auth, no GLPI-specific libraries — just receive → validate → save.

---

## Requirements

- **Node.js >= 18**
- The **GLPI Agent** already installed on the machine (only needed to *send* data;
  the server itself does not depend on it).

---

## Quick start

```bash
# 1. Install POC dependencies
npm install

# 2. Start the server (terminal 1)
npm start
#   -> glpi-server listening on http://localhost:8080

# 3. Send one inventory from this machine (terminal 2)
./run-glpi-agent.sh

# 4. Look at what was stored
ls db/
```

Change the port with `PORT=9000 npm start` (and point the script at it with
`SERVER_URL=http://localhost:9000/ ./run-glpi-agent.sh`).

---

## Project layout

```
glpi-server/
├── server.js              # the POC server (Express)
├── run-glpi-agent.sh      # runs the agent once, isolated, no sudo
├── package.json
├── schema/
│   └── inventory.schema.json   # official GLPI inventory JSON schema (draft-07)
├── db/                    # stored inventories land here (one file per submission)
└── README.md
```

Everything the agent run produces stays **inside this folder** — agent working
state goes to `./.agent-state/` (git-ignored), nothing is written to your home
directory, `/etc`, `/var`, or the system service.

---

## How the agent talks to us (the handshake)

The GLPI Agent only sends inventory as **JSON** once it is convinced the target
is a "GLPI server". It proves that with three POSTs (all handled in `server.js`):

| Step | Agent sends | We answer | Why |
|------|-------------|-----------|-----|
| 1. PROLOG | legacy XML probe | `{"status":"ok","expiration":24}` (JSON) | answering in JSON flips the agent into native JSON mode |
| 2. CONTACT | `{"action":"contact", ...}` | `{"status":"ok","expiration":24,"tasks":{"inventory":{}}}` | accept and advertise the inventory task |
| 3. INVENTORY | `{"action":"inventory","content":{...}}` | `{"status":"ok"}` | **this is the payload** — we validate + save it |

> `expiration` is in hours and must be `> 0`, otherwise the agent rejects the
> handshake.

---

## The JSON schema

`schema/inventory.schema.json` is the **official** GLPI inventory format
(JSON Schema draft-07) from
<https://github.com/glpi-project/inventory_format>.

- Root requires: `deviceid` and `content`.
- `content` requires `versionclient` and holds ~50 sections: `hardware`, `bios`,
  `cpus`, `memories`, `storages`, `drives`, `networks`, `softwares`,
  `operatingsystem`, `monitors`, etc.
- The server validates every inventory against it (using `ajv`) and logs any
  mismatches, but **stores the payload regardless** so nothing is lost during
  development.

---

## Notes for the real backend

This POC is intentionally framework-light. For the production system you do
**not** need any of these specific packages:

- `express` / `ajv` / `ajv-formats` are used here only for brevity. Any stack
  (Spring, Django, .NET, Go, raw Node `http`, …) works — you just need to:
  1. Accept an HTTP **POST**.
  2. Implement the **3-step handshake** above (or run agents in `--local --json`
     mode and ingest the files instead — see below).
  3. Optionally **inflate** the body — the agent compresses with zlib/gzip
     unless run with `--no-compression` (our script uses `--no-compression`, so
     the body is plain JSON). The server still inflates transparently via Node's
     built-in `zlib` if a compressed body arrives.
  4. **Parse the JSON** and store/process `content`.
- Validate against `schema/inventory.schema.json` in whatever validator your
  stack uses — the schema is standard draft-07.

### Alternative: file-based ingestion (no handshake)

If you prefer not to implement the handshake, run the agent in local mode and
ingest the files:

```bash
glpi-agent --config none --vardir ./.agent-state --logger stderr \
  --local ./db --json
```

This writes the same schema-compliant JSON straight to `./db/` with no server
involved — useful for building/validating your parser offline.
