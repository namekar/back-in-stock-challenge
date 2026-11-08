# Back-in-Stock Alerts

A webhook-driven application that notifies customers when a sold-out product is restocked.

## Tech Stack
- **Backend:** Node.js, Express
- **Database:** SQLite (via `better-sqlite3`)
- **Email:** Resend API (via the Harness proxy)

## Environment Variables
The app requires the following variables:
- `PORT`
- `STOCK_API_URL`
- `STOCK_API_KEY`
- `RESEND_API_KEY`
- `RESEND_BASE_URL`
- `WEBHOOK_SECRET`
- `ADMIN_PASSWORD`

## How to Run

### Local Development
1. Install dependencies:
   ```bash
   npm install
