# DigiStore DZ — Chargily Pay Integration

A complete Algerian digital storefront with **Chargily Pay** (CIB / EDAHABIA) payment integration, Firebase Auth, and Firestore for order management.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (Static HTML)                                  │
│  index.html  ·  my-products.html  ·  admin.html         │
│  payment-success.html  ·  payment-failure.html           │
└────────────────┬────────────────────────────────────────┘
                 │ POST /api/checkout
                 ▼
┌─────────────────────────────────────────────────────────┐
│  Backend (Node.js + Express)  — server.js                │
│  • Creates Chargily checkout session                     │
│  • Verifies webhook signatures (HMAC-SHA256)             │
│  • Marks purchases as "paid" in Firestore                │
└──────────┬─────────────────────────┬────────────────────┘
           │                         │
           ▼                         ▼
  Chargily Pay API            Firebase Firestore
  (payment gateway)           (orders / purchases)
```

### Payment Flow

1. User adds products to cart and clicks **Checkout**
2. Frontend sends cart + user info to `POST /api/checkout`
3. Backend creates a Chargily checkout session and returns the `checkout_url`
4. User is redirected to the Chargily hosted payment page
5. User pays with **CIB** or **EDAHABIA**
6. Chargily redirects to `payment-success.html` (paid) or `payment-failure.html` (failed/cancelled)
7. Chargily fires a **webhook** (`POST /api/webhook`) with an HMAC-signed payload
8. Backend verifies the signature and marks all purchased items as `paid` in Firestore
9. User's **My Products** page updates in real time via Firestore `onSnapshot`

---

## Project Structure

```
/
├── backend/
│   └── server.js               # Express backend (NEW)
├── package.json                # Node dependencies
├── .env.example                # Environment variable template
├── .gitignore
│
├── index.html                  # Main storefront (modified — Chargily checkout)
├── my-products.html            # User's purchased products
├── admin.html                  # Admin panel
├── seed.html                   # Database seeder
├── payment-success.html        # Post-payment success page (NEW)
├── payment-failure.html        # Post-payment failure page (NEW)
└── firebase.js                 # Firebase SDK + Cart / DB / Auth helpers
```

---

## Prerequisites

- **Node.js ≥ 18** — [nodejs.org](https://nodejs.org)
- A **Chargily Pay** account — [pay.chargily.net](https://pay.chargily.net)
- A **Firebase** project with Firestore enabled — [console.firebase.google.com](https://console.firebase.google.com)

---

## Installation

```bash
# 1. Clone / download the project
git clone https://github.com/yourname/digistore-dz.git
cd digistore-dz

# 2. Install backend dependencies
npm install

# 3. Create your .env file
cp .env.example .env
```

---

## Configuration

### 1 — Chargily Pay API Keys

1. Log in to [pay.chargily.net/test/dashboard](https://pay.chargily.net/test/dashboard) (test) or [pay.chargily.net/dashboard](https://pay.chargily.net/dashboard) (live)
2. Go to **Developers → API Keys**
3. Copy your **Secret Key** (starts with `test_sk_...` or `live_sk_...`)
4. Paste it into `.env`:

```env
CHARGILY_MODE=test
CHARGILY_SECRET_KEY=test_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> **Test mode** lets you simulate payments without real money. Switch to `live` when ready to accept real payments.

### 2 — Firebase Admin Service Account

The backend needs the Firebase Admin SDK to update Firestore from the webhook.

1. Go to **Firebase Console → Project Settings → Service accounts**
2. Click **Generate new private key** — this downloads a JSON file
3. Either:
   - Set `FIREBASE_SERVICE_ACCOUNT` to the entire JSON content (as one line), **or**
   - Fill in the individual `FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY`, etc. fields

### 3 — App URL

Set `APP_URL` to the public URL your backend is reachable at. Chargily needs this to redirect users back and to send webhooks.

```env
# Development (requires a tunnel like ngrok for webhooks to work)
APP_URL=http://localhost:3001

# Production
APP_URL=https://yourdomain.com
```

### 4 — Frontend Backend URL

In `payment-success.html` and `payment-failure.html`, update the backend URL configuration block at the bottom of each file:

```html
<script>
  window.DIGISTORE_BACKEND_URL = 'https://yourdomain.com'; // ← your backend
</script>
```

In `index.html`, find the `DIGISTORE_BACKEND_URL` constant in the `placeOrder` function and update it the same way.

---

## Running Locally

```bash
# Development (auto-restarts on file change, Node ≥ 18)
npm run dev

# Production
npm start
```

The server starts on `http://localhost:3001` by default.

> **Webhooks in development:** Chargily cannot reach `localhost`. Use [ngrok](https://ngrok.com) or [localtunnel](https://localtunnel.me) to expose your local server:
> ```bash
> ngrok http 3001
> # Copy the https://xxxx.ngrok.io URL and set it as APP_URL in .env
> ```

### Serving the frontend locally

Open `index.html` with a local server (not `file://` — Firebase Auth requires HTTP):

```bash
# Option A: VS Code Live Server extension (simplest)
# Option B: Python
python3 -m http.server 5500
# Option C: npx
npx serve .
```

Make sure `http://localhost:5500` is in `ALLOWED_ORIGINS` in your `.env`.

---

## Chargily Webhook Setup

1. Log in to your Chargily dashboard
2. Go to **Developers → Webhooks**
3. Add your webhook URL: `https://yourdomain.com/api/webhook`
4. The backend automatically verifies every webhook using HMAC-SHA256 with your secret key

---

## Deploying to Production

### Railway (recommended — free tier available)

1. Push your code to GitHub
2. Create a new project on [railway.app](https://railway.app) from your repo
3. Add all variables from `.env.example` under **Variables**
4. Set `APP_URL` to your Railway-assigned domain (e.g. `https://digistore-dz.up.railway.app`)
5. Railway auto-detects Node.js and runs `npm start`

### Render

1. Create a new **Web Service** from your GitHub repo
2. Build command: `npm install`
3. Start command: `npm start`
4. Add all environment variables in the Render dashboard

### VPS (Ubuntu/Debian)

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and install
git clone https://github.com/yourname/digistore-dz.git /var/www/digistore
cd /var/www/digistore
npm install --production

# Set up environment
cp .env.example .env
nano .env   # fill in your real values

# Run with PM2 (keeps server alive)
npm install -g pm2
pm2 start backend/server.js --name digistore
pm2 save
pm2 startup

# Reverse proxy with Nginx (optional but recommended)
# Point your domain to port 3001
```

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check — returns `{ status: "ok", mode: "test\|live" }` |
| `POST` | `/api/checkout` | Create a Chargily checkout session |
| `POST` | `/api/webhook` | Receive Chargily payment events (HMAC-verified) |
| `GET` | `/api/verify-checkout/:id` | Verify a checkout's status by ID |

### POST /api/checkout — Request Body

```json
{
  "items": [
    { "name": "Product Name", "price": 2500, "quantity": 1 }
  ],
  "customer": {
    "name": "Ahmed Benali",
    "email": "ahmed@example.com"
  },
  "userId": "firebase-uid-here",
  "purchaseIds": ["firestore-purchase-doc-id-1", "firestore-purchase-doc-id-2"],
  "locale": "ar"
}
```

### POST /api/checkout — Response

```json
{
  "checkout_url": "https://pay.chargily.net/test/checkouts/xxx",
  "checkout_id": "01xxxxxxxxxxxxxxxxxxxxxx"
}
```

---

## Security Notes

- The Chargily secret key is **only on the server** — never in frontend code
- Webhook payloads are verified with **HMAC-SHA256** before any Firestore writes happen
- The `/api/verify-checkout/:id` endpoint returns only a safe subset of data (id, status, amount)
- CORS is restricted to origins listed in `ALLOWED_ORIGINS`

---

## Troubleshooting

**"Chargily secret key not configured"**
→ Make sure `CHARGILY_SECRET_KEY` is set in your `.env` and the server was restarted.

**Webhook signature mismatch (403)**
→ Ensure `CHARGILY_SECRET_KEY` on the server matches exactly what's in your Chargily dashboard. Also make sure the raw body is captured before `express.json()` parses it — the existing `server.js` handles this correctly.

**Firebase Firestore updates not working**
→ Check `FIREBASE_SERVICE_ACCOUNT` or the individual `FIREBASE_*` variables. The server logs will show `[Firebase] Admin SDK not initialized` if credentials are missing or malformed.

**Purchases stay "pending" after payment**
→ Webhooks are the source of truth. If running locally, use ngrok so Chargily can reach your server. In production, verify the webhook URL is registered in the Chargily dashboard.

**CORS errors in browser console**
→ Add your frontend's origin to `ALLOWED_ORIGINS` in `.env`.