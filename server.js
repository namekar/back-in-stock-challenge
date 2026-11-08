require('dotenv').config();
const express = require('express');
const db = require('./db');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- GET /embed ----------
app.get('/embed', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{box-sizing:border-box;font-family:system-ui,sans-serif}
body{margin:0;padding:20px;background:#f9f9f9}
.card{max-width:360px;margin:0 auto;background:#fff;padding:24px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.05)}
h2{margin-top:0;font-size:20px;color:#111}
p{font-size:14px;color:#666;margin-bottom:20px}
input{width:100%;padding:12px;margin-bottom:12px;border:1px solid #ddd;border-radius:8px;font-size:14px}
button{width:100%;padding:12px;background:#000;color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer}
button:hover{background:#333}
.msg{margin-top:16px;font-size:13px;text-align:center;color:#2e7d32}
.error{color:#c62828}
</style>
</head>
<body>
<div class="card">
<h2>Get notified</h2>
<p>Enter your email and the product SKU. We'll email you when it's back.</p>
<form id="form">
<input type="email" id="email" placeholder="you@example.com" required>
<input type="text" id="sku" placeholder="SKU (e.g., HOOD-FLC-GRY-M)" required>
<button type="submit">Notify me</button>
</form>
<div id="msg" class="msg"></div>
</div>
<script>
document.getElementById('form').onsubmit = async (e) => {
  e.preventDefault();
  const msg = document.getElementById('msg');
  msg.className = 'msg'; msg.innerText = 'Saving...';
  try {
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        email: document.getElementById('email').value,
        sku: document.getElementById('sku').value
      })
    });
    const data = await res.json();
    msg.innerText = data.message || 'Saved!';
  } catch {
    msg.className = 'msg error'; msg.innerText = 'Something went wrong.';
  }
};
</script>
</body>
</html>`);
});

// ---------- POST /api/requests ----------
app.post('/api/requests', (req, res) => {
  const { email, sku } = req.body;
  if (!email || !sku) return res.status(400).json({ error: 'Email and SKU required' });

  const info = db.prepare(
    `INSERT OR IGNORE INTO requests (email, sku) VALUES (?, ?)`
  ).run(email, sku);

  if (info.changes === 0) {
    console.log(`[API] Duplicate request ignored for ${email} (${sku})`);
    return res.json({ message: 'You are already on the list for this item.' });
  }

  console.log(`[API] New request saved for ${email} (${sku})`);
  res.json({ message: 'Added! We will email you when it is back.' });
});

// ---------- POST /webhooks/stock ----------
app.post('/webhooks/stock', async (req, res) => {
  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    console.log(`[WEBHOOK] Unauthorized attempt`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { event_id, sku } = req.body;
  if (!event_id || !sku) return res.status(400).json({ error: 'Missing event_id or sku' });

  console.log(`[WEBHOOK] Received event ${event_id} for ${sku}`);

  // 1. Idempotency claim — atomic
  const claim = db.prepare(
    `INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)`
  ).run(event_id);
  
  if (claim.changes === 0) {
    console.log(`[WEBHOOK] Duplicate event ignored: ${event_id}`);
    return res.status(200).json({ status: 'duplicate_ignored' });
  }

  try {
    // 2. Verify with the stock API — never trust webhook quantity
    const stockRes = await fetch(`${process.env.STOCK_API_URL}/${encodeURIComponent(sku)}`, {
      headers: { Authorization: `Bearer ${process.env.STOCK_API_KEY}` }
    });
    const stock = await stockRes.json();

    if (!(stock.quantity > 0)) {
      console.log(`[WEBHOOK] Ignored: ${sku} is actually out of stock (quantity ${stock.quantity})`);
      return res.status(200).json({ status: 'no_stock' });
    }

    // 3. Process pending requests
    const pending = db.prepare(
      `SELECT * FROM requests WHERE sku = ? AND status = 'pending'`
    ).all(sku);

    console.log(`[WEBHOOK] Found ${pending.length} pending requests for ${sku}`);

    let failures = 0;
    for (const r of pending) {
      try {
        // Send email via the harness Resend endpoint
        const emailRes = await fetch(`${process.env.RESEND_BASE_URL}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Alerts <alerts@shop.example>',
            to: r.email,
            subject: `Back in stock: ${sku}`,
            html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
              <h1 style="font-size:22px;color:#111;margin:0 0 12px">Good news 🎉</h1>
              <p style="font-size:16px;color:#333;line-height:1.5">
                <strong>${sku}</strong> is back in stock. Quantities are limited.
              </p>
            </div>`
          })
        });
        
        if (!emailRes.ok) throw new Error(`Email failed: ${emailRes.status}`);

        db.prepare(
          `UPDATE requests SET status='notified', notified_at=? WHERE id=?`
        ).run(new Date().toISOString(), r.id);
        
        console.log(`[EMAIL] Successfully sent to ${r.email}`);
      } catch (e) {
        console.error(`[EMAIL] Failed to send to ${r.email}:`, e.message);
        failures++;
      }
    }

    // 4. If any email failed, release the event claim so a retry can happen
    if (failures > 0) {
      db.prepare(`DELETE FROM processed_events WHERE event_id = ?`).run(event_id);
      return res.status(500).json({ error: 'email_failed', failures });
    }

    res.status(200).json({ status: 'ok', notified: pending.length });
  } catch (err) {
    console.error(`[WEBHOOK] Error:`, err);
    db.prepare(`DELETE FROM processed_events WHERE event_id = ?`).run(event_id);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------- GET /admin ----------
app.get('/admin', (req, res) => {
  const expected = 'Basic ' + Buffer.from(`admin:${process.env.ADMIN_PASSWORD}`).toString('base64');
  if (req.headers.authorization !== expected) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Authentication required.');
  }

  const rows = db.prepare('SELECT * FROM requests ORDER BY id DESC').all();
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;font-family:system-ui,sans-serif}
body{padding:20px;background:#f4f4f4}
.container{max-width:900px;margin:0 auto;background:#fff;padding:24px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
table{width:100%;border-collapse:collapse;margin-top:20px;font-size:14px}
th,td{text-align:left;padding:12px;border-bottom:1px solid #eee}
th{background:#f8f8f8;font-weight:600}
.pending{color:#f57c00;font-weight:bold}.notified{color:#2e7d32;font-weight:bold}
</style></head><body><div class="container">
<h1>Back-in-Stock Requests</h1><p>Total: ${rows.length}</p>
<table><tr><th>Email</th><th>SKU</th><th>Status</th><th>Notified At</th></tr>
${rows.map(r => `<tr><td>${r.email}</td><td>${r.sku}</td>
<td class="${r.status}">${r.status}</td><td>${r.notified_at || '—'}</td></tr>`).join('')}
</table></div></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));