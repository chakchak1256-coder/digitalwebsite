# SlickPay API — Developer Integration Guide
> **Production-tested reference** based on real API calls and responses.  
> Use this as a system prompt or context file when building with the SlickPay API.

---

## 🔐 Authentication

Every request must include:

```
Authorization: Bearer YOUR_PUBLIC_KEY
Content-Type: application/json
Accept: application/json
```

**Environments:**

| Environment | Base URL |
|-------------|----------|
| Sandbox     | `https://devapi.slick-pay.com/api/v2` |
| Production  | `https://prodapi.slick-pay.com/api/v2` |

---

## 💳 Full Payment Flow

```
1. GET  /users/accounts          → pick an account UUID
2. POST /users/invoices          → create invoice → get payment URL
3. Redirect user to payment URL  → user pays on SATIM (CIB card)
4. User redirected back to your  `url`
5. GET  /users/invoices/{id}     → check if completed == 1
   OR receive webhook automatically
```

---

## STEP 1 — Get Your Accounts

### `GET /users/accounts`

Retrieve all bank accounts linked to your merchant profile. Use the `uuid` when creating invoices.

**Request:**
```bash
curl -X GET https://prodapi.slick-pay.com/api/v2/users/accounts \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer YOUR_PUBLIC_KEY"
```

**Response:**
```json
{
  "data": [
    {
      "id": 211,
      "uuid": "60155203-da6e-4db6-86ad-981f9a042251",
      "default": 1,
      "title": "Main RIB",
      "rib": "00799999000000000000",
      "firstname": "John",
      "lastname": "Doe",
      "address": "123 Main Street, Algiers",
      "created_at": "2026-05-19 15:44:13"
    },
    {
      "id": 4,
      "uuid": "b801774e-9860-4dff-8a3b-dfb7506c07d3",
      "default": 0,
      "title": "Secondary Account",
      "rib": "00100703030000146384",
      "firstname": "John",
      "lastname": "Doe",
      "address": "Algiers",
      "created_at": "2023-03-20 17:14:26"
    }
  ]
}
```

**Key fields:**
- `uuid` — use this as `account` when creating invoices
- `default: 1` — this account is used automatically if you don't pass `account`

---

## STEP 2 — Create Invoice

### `POST /users/invoices`

**Request:**
```bash
curl -X POST https://prodapi.slick-pay.com/api/v2/users/invoices \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer YOUR_PUBLIC_KEY" \
  -d '{
    "amount": 10000,
    "account": "3386ec0e-a9fe-4ce0-806d-3abe0101d53f",
    "url": "https://yourwebsite.com/payment-return",
    "fees": 100,
    "items": [
      {
        "name": "Seller product",
        "price": 5000,
        "quantity": 2
      }
    ]
  }'
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `amount` | numeric | ✅ Yes | Total amount in DZD. Must be > 100. |
| `items` | array | ✅ Yes | List of invoice items (see below). |
| `items[].name` | string | ✅ Yes | Item name. |
| `items[].price` | numeric | ✅ Yes | Item unit price. |
| `items[].quantity` | numeric | ✅ Yes | Item quantity. |
| `account` | UUID | ⚠️ Conditional | UUID of your bank account. If omitted, uses default account. If no default exists → required. |
| `url` | string | No | Redirect URL after payment is completed (your return/thank-you page). |
| `fees` | numeric (0–100) | No | Who pays the platform fees. `100` = client pays. `0` = merchant pays. |
| `qrcode` | boolean | No | Set `true` to enable QR/Web-Mob iFrame payment mode. |
| `note` | string | No | Billing note displayed on invoice. |
| `contact` | UUID | No | UUID of a saved contact. If provided, invoice is addressed to them. |
| `firstname` | string | Conditional | Required if no `contact` provided. |
| `lastname` | string | Conditional | Required if no `contact` provided. |
| `phone` | string | Conditional | Required if no `contact` and no `email`. |
| `email` | string | Conditional | Required if no `contact` and no `phone`. |
| `address` | string | Conditional | Required if no `contact`. |
| `webhook_url` | string | No | URL to receive payment status notifications. |
| `webhook_signature` | string | No | Signature key to verify webhook authenticity. |
| `webhook_meta_data` | array/object | No | Custom metadata sent back with the webhook payload. |

### Success Response
```json
{
  "success": 1,
  "message": "Facture créée avec succès.",
  "id": 3140458,
  "invoice": {
    "id": 3140458,
    "completed": 0,
    "status": "Initié",
    "serial": "PAY-0734462TNV37",
    "to": "invoice to",
    "merchant": "Ayoub Menzou",
    "email": "email@email.test",
    "address": " ",
    "amount": "10,190.00",
    "items": [],
    "url": "https://slick-pay.com/invoice/payment/PAY-0734462TNV37/merchant",
    "qrCode": "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=...",
    "slick_qr_code": "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=...",
    "date": "2026-05-21 07:34:46",
    "pay_status": 0,
    "rejection_reason": "Paiement de transfert en attente",
    "transaction": null,
    "meta_data": { "op_type": "api_qrcode" },
    "pay_method": "satim",
    "deeplink": "https://slick-pay.com/invoice/payment/PAY-0734462TNV37/user",
    "receiver_id": null,
    "receiver_type": null
  },
  "url": "https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder=6GvQodO643MM5EASJZZQ&language=fr"
}
```

> ⚠️ **Important:** The `url` at the root level of the response is the SATIM payment page.  
> Redirect your user (browser / WebView) to this URL to complete card payment.

### Error Response (422)
```json
{
  "message": "The amount field is required.",
  "errors": {
    "amount": ["The amount field is required."]
  }
}
```

---

## STEP 3 — Redirect User to Payment

After creating the invoice, take the `url` from the response root:

```
https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder=...
```

- **Web:** Open in browser tab or redirect
- **Mobile:** Open in WebView or in-app browser

The user fills in their CIB/EDAHABIA card details on the SATIM page.  
After completion (success or failure), SATIM redirects back to your `url` parameter.

---

## STEP 4 — Check Payment Status

### `GET /users/invoices/{id}`

Poll this after the user returns to your site, or use a webhook instead.

**Request:**
```bash
curl -X GET https://prodapi.slick-pay.com/api/v2/users/invoices/3140458 \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer YOUR_PUBLIC_KEY"
```

**Response:**
```json
{
  "success": 1,
  "completed": 0,
  "data": {
    "id": 3140458,
    "completed": 0,
    "status": "Initié",
    "serial": "PAY-0734462TNV37",
    "amount": "10,190.00",
    "items": [
      {
        "id": 3182876,
        "name": "Seller product",
        "price": "5,000.00",
        "quantity": "2",
        "total": "10,000.00"
      }
    ],
    "pay_status": 0,
    "rejection_reason": "Opération annulée par l'utilisateur Error code :342034.",
    "transaction": null,
    "pay_method": "satim"
  }
}
```

### Payment Status Logic

| Field | Value | Meaning |
|-------|-------|---------|
| `completed` | `1` | ✅ Payment **succeeded** |
| `completed` | `0` | ❌ Payment **not completed** (pending or failed) |
| `rejection_reason` | string | Reason for failure or current status message |
| `transaction` | object / null | Transaction details when paid, null otherwise |

```javascript
if (response.completed === 1) {
  // ✅ Payment confirmed — fulfill the order
} else {
  // ❌ Not paid — show rejection_reason to user or retry
  console.log(response.data.rejection_reason);
}
```

---

## STEP 5 (Optional) — Webhook

Add these fields when creating the invoice to receive automatic payment status updates:

```json
{
  "webhook_url": "https://yourserver.com/slickpay/webhook",
  "webhook_signature": "your_secret_signature",
  "webhook_meta_data": {
    "order_id": "12345",
    "custom_key": "custom_value"
  }
}
```

SlickPay will POST to your `webhook_url` the same payload as the `GET /invoices/{id}` response when the payment status changes.

**Verify authenticity** using `webhook_signature` — compare it against the signature in the webhook header.

---

## 💡 fees Field — How It Really Works

### The commission rate is NOT fixed — it's set per merchant account in the SlickPay dashboard.

The `fees` parameter in the API does **not** define the commission percentage itself.  
It only controls **who absorbs the commission** — the client or the merchant.

The actual commission rate is configured individually for each merchant by SlickPay (visible in your dashboard profile).

---

### How `fees` works (0–100)

`fees` is a **percentage split** of the commission charge between merchant and client.

| `fees` value | Who pays | Effect on client | Effect on merchant |
|-------------|----------|------------------|--------------------|
| `0`   | Merchant pays 100% | Client pays exact `amount` | Commission deducted from merchant payout |
| `100` | Client pays 100%   | Client pays `amount` + full commission on top | Merchant receives full `amount` |
| `50`  | Split evenly       | Client pays `amount` + 50% of commission | Merchant absorbs other 50% |
| `25`  | Mostly merchant    | Client pays `amount` + 25% of commission | Merchant absorbs 75% |

> Think of it as: **what % of the commission is billed to the client**.  
> `fees: 0` → client pays nothing extra, merchant absorbs all.  
> `fees: 100` → merchant pays nothing extra, client absorbs all.

---

### Real example from production test

```
amount:       10,000 DZD   (your invoice total)
fees:         100           (client pays all commission)
commission:   190 DZD       (this merchant's rate applied to 10,000)
─────────────────────────────
client charged: 10,190 DZD
merchant receives: 10,000 DZD
```

If `fees` had been `0`:
```
client charged:  10,000 DZD
merchant receives: 9,810 DZD  (190 DZD deducted)
```

If `fees` had been `50`:
```
client charged:  10,095 DZD  (95 DZD = 50% of commission)
merchant receives: 9,905 DZD  (95 DZD deducted = other 50%)
```

---

### How to know your commission rate before charging

Use the commission calculator endpoint **before** creating an invoice:

#### `POST /users/invoices/commission`

```bash
curl -X POST https://prodapi.slick-pay.com/api/v2/users/invoices/commission \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer YOUR_PUBLIC_KEY" \
  -d '{ "amount": 10000 }'
```

**Response:**
```json
{
  "success": 1,
  "amount": 10190,
  "commission": 190
}
```

| Field | Description |
|-------|-------------|
| `amount` | Total amount after commission (what client will pay if `fees: 100`) |
| `commission` | The commission amount calculated for this merchant's rate |

> ✅ Use this endpoint to show a price breakdown to the user **before** redirecting them to payment.

---

## 📦 Response Fields Reference

### Invoice Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | numeric | Invoice ID — use for status checks |
| `serial` | string | Human-readable invoice number (e.g. `PAY-XXXXX`) |
| `completed` | 0/1 | 1 = paid, 0 = not paid |
| `status` | string | French status label (e.g. "Initié", "Payé") |
| `amount` | string | Formatted total amount in DZD |
| `items` | array | Line items with name, price, quantity, total |
| `url` | string | SlickPay hosted invoice page (merchant view) |
| `deeplink` | string | SlickPay hosted invoice page (user/client view) |
| `qrCode` | string | QR code image URL for merchant payment link |
| `slick_qr_code` | string | QR code for SlickPay mobile app payment |
| `pay_method` | string | Payment method used (e.g. `satim`) |
| `rejection_reason` | string | Failure reason or pending status message |
| `transaction` | object/null | Transaction details when payment is successful |
| `meta_data` | object | Internal metadata (e.g. `op_type`) |
| `date` | string | Invoice creation datetime |

---

## ⚡ Quick Code Examples

### JavaScript (axios)
```javascript
const axios = require("axios");

// 1. Create invoice
const { data } = await axios.post(
  "https://prodapi.slick-pay.com/api/v2/users/invoices",
  {
    amount: 10000,
    account: "YOUR_ACCOUNT_UUID",
    url: "https://yoursite.com/payment-return",
    fees: 100,
    items: [{ name: "Product", price: 5000, quantity: 2 }],
    webhook_url: "https://yoursite.com/webhook",
    webhook_signature: "your_secret"
  },
  { headers: { Authorization: `Bearer ${process.env.SLICKPAY_KEY}` } }
);

// 2. Redirect user
window.location.href = data.url; // SATIM payment page

// 3. Check status
const status = await axios.get(
  `https://prodapi.slick-pay.com/api/v2/users/invoices/${data.id}`,
  { headers: { Authorization: `Bearer ${process.env.SLICKPAY_KEY}` } }
);

if (status.data.completed === 1) {
  console.log("Payment successful!");
}
```

### Python (requests)
```python
import requests
import os

BASE_URL = "https://prodapi.slick-pay.com/api/v2"
HEADERS = {
    "Authorization": f"Bearer {os.environ['SLICKPAY_KEY']}",
    "Content-Type": "application/json",
    "Accept": "application/json"
}

# 1. Create invoice
res = requests.post(f"{BASE_URL}/users/invoices", json={
    "amount": 10000,
    "account": "YOUR_ACCOUNT_UUID",
    "url": "https://yoursite.com/payment-return",
    "fees": 100,
    "items": [{"name": "Product", "price": 5000, "quantity": 2}]
}, headers=HEADERS)

data = res.json()
payment_url = data["url"]  # redirect user here
invoice_id = data["id"]

# 2. Check status
check = requests.get(f"{BASE_URL}/users/invoices/{invoice_id}", headers=HEADERS)
if check.json()["completed"] == 1:
    print("Payment confirmed!")
```

---

## ⚠️ Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `The amount field is required` | Missing `amount` | Add `amount` > 100 |
| `The items field is required` | Missing `items` array | Add at least 1 item |
| `Account not found` | Wrong account UUID | Use `GET /users/accounts` to get valid UUID |
| `completed: 0` + rejection_reason | User cancelled or card failed | Show error to user, allow retry |

---

## 🔑 Important Notes

- **Never hardcode your API key** — use environment variables
- **Amount is in DZD (Algerian Dinar)** — minimum 100 DZD
- **`fees` is not a fixed rate** — your commission % is set per-account in the SlickPay dashboard; `fees` only controls who pays it (0 = merchant, 100 = client, anything in between = split)
- **Call `/invoices/commission` first** to calculate the exact commission before creating the invoice
- **Always use the `url` from the root** of the create response (SATIM URL), not `invoice.url`
- **`invoice.url`** = SlickPay merchant-facing page (not for payment)
- **`invoice.deeplink`** = SlickPay user-facing page (alternative payment via SlickPay app)
- Use **sandbox** (`devapi`) for testing, **production** (`prodapi`) for live payments
