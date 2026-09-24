# DevOps & AWS Course — landing page + gated downloads

A small Express app that serves the course landing page (`index.html`), lets buyers
submit UPI payment evidence, and unlocks the course files once the trainer approves
the payment.

## Run locally (Windows PowerShell)

```powershell
cd C:\Users\aasim\Downloads\resume
npm install
Copy-Item .env.example .env   # then edit .env (see below)
npm start
```

Open <http://localhost:3000>.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default `3000`). |
| `ADMIN_KEY` | Secret for the admin endpoints. Empty = admin endpoints disabled. |
| `UPI_ID` | UPI ID buyers pay to. Empty = payment form disabled. |
| `UPI_PAYEE_NAME`, `COURSE_PRICE_INR` | Shown on the page / put in the UPI link. |
| `DEMO_AUTO_APPROVE` | `true` approves every submission **without verification**. Local testing only; refused when `NODE_ENV=production`. |
| `MAX_SCREENSHOT_MB`, `MAX_COURSE_FILE_MB` | Upload size limits. |
| `DATA_DIR` | Where `db.json`, `uploads/`, `screenshots/` live (default: project folder). |
| `TRUST_PROXY` | `true` when behind an HTTPS reverse proxy. |

`.env` is git-ignored. Never commit it.

## How payment works (and what it does *not* do)

1. Buyer clicks **Get Instant Access**. On a phone this opens their UPI app with the
   amount and your `UPI_ID` pre-filled.
2. Buyer submits their email, the UPI transaction ID and (optionally) a screenshot.
   The server stores it as **pending** and gives that browser an access cookie.
3. **You check your bank / UPI app** for that transaction and approve it (below).
4. The buyer's page unlocks and lists the files in `uploads/`.

There is **no automatic payment verification**. Anyone can type a transaction ID; only
your manual check (or a real payment gateway) proves money arrived.

## Admin tasks (PowerShell)

```powershell
$h = @{ "X-Admin-Key" = "<your ADMIN_KEY>" }

# Pending payments
(Invoke-RestMethod http://localhost:3000/api/admin/payments?status=pending -Headers $h).payments

# View a screenshot
Invoke-WebRequest http://localhost:3000/api/admin/screenshots/<screenshot-file> -Headers $h -OutFile shot.png

# Approve / reject
Invoke-RestMethod -Method Post http://localhost:3000/api/admin/payments/<id>/approve -Headers $h
Invoke-RestMethod -Method Post http://localhost:3000/api/admin/payments/<id>/reject  -Headers $h

# Upload course files (field name "files", up to 20 per request)
curl.exe -H "X-Admin-Key: <your ADMIN_KEY>" -F "files=@C:\path\Lab Playbooks.zip" -F "files=@C:\path\Linux Essentials.mp4" http://localhost:3000/api/upload
```

## API

| Method & path | Auth | Description |
|---|---|---|
| `GET /` | — | Landing page |
| `GET /api/health` | — | `{ "status": "ok" }` |
| `GET /api/config` | — | Public payment settings for the page |
| `POST /api/submit-payment` | — | multipart: `email`, `txn`, optional `screenshot` (PNG/JPG/WEBP) |
| `GET /api/list-content` | access cookie | `{ allowed, status, files }` |
| `GET /content/:file` | access cookie (approved) | Download a course file |
| `POST /api/upload` | admin | multipart `files` |
| `GET /api/admin/payments[?status=]` | admin | List submissions |
| `POST /api/admin/payments/:id/approve` \| `reject` | admin | Review a submission |
| `GET /api/admin/screenshots/:file` | admin | Fetch a payment screenshot |

Unknown `/api/*` routes return `404 {"error":"Route not found"}`.

## Docker

```powershell
docker build -t resume .
docker run -d -p 80:3000 --env-file .env -v resume-data:/usr/src/app/data --name resume resume
```
