// ============================================================
// BoxDrop Baltimore — QuickBooks OAuth Server
// Deploy to Render.com (free tier)
// ============================================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' })); // Tighten this to your dashboard URL in production

// ── CONFIGURATION ────────────────────────────────────────────
const CONFIG = {
  clientId:     'ABqacg6iLszOKMRm5utdpVal0weXgYc77uCMGfEDgyMMETHGiL',
  clientSecret: 'PrqTq9dx9aVTHN6ixcolJabu5TDji0kvEmHHkn8k',
  redirectUri:  'https://nodejs-production-0b9b.up.railway.app/callback',
  companyId:    'PASTE_YOUR_COMPANY_ID_HERE',   // ← you'll fill this in
  environment:  'sandbox',  // use 'sandbox' for dev keys, 'production' for prod keys
  scopes:       'com.intuit.quickbooks.accounting',
};

// QB API base URL (sandbox vs production)
const QB_BASE = CONFIG.environment === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com/v3/company'
  : 'https://quickbooks.api.intuit.com/v3/company';

// Auth URL
const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// ── TOKEN STORAGE (in-memory — persists as long as server runs) ──
let tokenStore = {
  accessToken:  null,
  refreshToken: null,
  expiresAt:    null,
};

// ── HELPERS ──────────────────────────────────────────────────

// Build Basic auth header for token requests
function basicAuth() {
  return Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
}

// Check if access token is expired (with 60s buffer)
function isExpired() {
  if (!tokenStore.expiresAt) return true;
  return Date.now() >= tokenStore.expiresAt - 60000;
}

// Refresh the access token automatically
async function refreshAccessToken() {
  if (!tokenStore.refreshToken) throw new Error('No refresh token — need to re-authenticate');
  const res = await axios.post(TOKEN_URL,
    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokenStore.refreshToken,
    }).toString(),
    {
      headers: {
        'Authorization': `Basic ${basicAuth()}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    }
  );
  tokenStore.accessToken  = res.data.access_token;
  tokenStore.refreshToken = res.data.refresh_token || tokenStore.refreshToken;
  tokenStore.expiresAt    = Date.now() + res.data.expires_in * 1000;
  console.log('✅ Token refreshed');
}

// Get a valid access token (refresh if needed)
async function getToken() {
  if (!tokenStore.accessToken) throw new Error('Not authenticated — visit /auth to connect');
  if (isExpired()) await refreshAccessToken();
  return tokenStore.accessToken;
}

// Make a QB API GET request
async function qbGet(path, params = {}) {
  const token = await getToken();
  const res = await axios.get(
    `${QB_BASE}/${CONFIG.companyId}/${path}`,
    {
      params:  { ...params, minorversion: 70 },
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
      },
    }
  );
  return res.data;
}

// Make a QB API POST request (for creating records)
async function qbPost(path, body) {
  const token = await getToken();
  const res = await axios.post(
    `${QB_BASE}/${CONFIG.companyId}/${path}?minorversion=70`,
    body,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
        'Content-Type':  'application/json',
      },
    }
  );
  return res.data;
}

// ── ROUTES ────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status:        'BoxDrop QB Server running',
    authenticated: !!tokenStore.accessToken,
    tokenExpires:  tokenStore.expiresAt ? new Date(tokenStore.expiresAt).toISOString() : null,
  });
});

// Step 1: Redirect to QB login
app.get('/auth', (req, res) => {
  const url = `${AUTH_BASE}?` + new URLSearchParams({
    client_id:     CONFIG.clientId,
    redirect_uri:  CONFIG.redirectUri,
    response_type: 'code',
    scope:         CONFIG.scopes,
    state:         'boxdrop_auth',
  }).toString();
  res.redirect(url);
});

// Step 2: QB redirects here after login
app.get('/callback', async (req, res) => {
  const { code, realmId, error } = req.query;
  if (error) return res.status(400).json({ error });
  if (!code)  return res.status(400).json({ error: 'No auth code received' });

  // Update company ID from realmId if not set
  if (realmId && CONFIG.companyId === 'PASTE_YOUR_COMPANY_ID_HERE') {
    CONFIG.companyId = realmId;
    console.log(`✅ Company ID set from OAuth: ${realmId}`);
  }

  try {
    const res2 = await axios.post(TOKEN_URL,
      new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: CONFIG.redirectUri,
      }).toString(),
      {
        headers: {
          'Authorization': `Basic ${basicAuth()}`,
          'Content-Type':  'application/x-www-form-urlencoded',
        },
      }
    );
    tokenStore.accessToken  = res2.data.access_token;
    tokenStore.refreshToken = res2.data.refresh_token;
    tokenStore.expiresAt    = Date.now() + res2.data.expires_in * 1000;
    console.log('✅ Authentication successful');
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#fff;">
        <h1 style="color:#2d9e4e">✅ BoxDrop QB Connected!</h1>
        <p>QuickBooks is now linked to your dashboard.</p>
        <p style="color:#888">You can close this tab and return to your dashboard.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('Token exchange error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Token exchange failed', details: err.response?.data });
  }
});

// ── DATA ENDPOINTS ────────────────────────────────────────────

// GET /sales?startDate=2026-03-01&endDate=2026-06-15
// Returns all sales receipts and invoices in date range
app.get('/sales', async (req, res) => {
  try {
    const { startDate = '2026-01-01', endDate = '2026-12-31' } = req.query;
    const query = `SELECT * FROM SalesReceipt WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`;
    const [receipts, invoices] = await Promise.all([
      qbGet('query', { query }),
      qbGet('query', { query: query.replace('SalesReceipt', 'Invoice') }),
    ]);
    res.json({
      salesReceipts: receipts.QueryResponse?.SalesReceipt || [],
      invoices:      invoices.QueryResponse?.Invoice || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /pnl?startDate=2026-01-01&endDate=2026-06-30
// Returns Profit & Loss report
app.get('/pnl', async (req, res) => {
  try {
    const { startDate = '2026-01-01', endDate = '2026-06-30' } = req.query;
    const token = await getToken();
    const result = await axios.get(
      `${QB_BASE}/${CONFIG.companyId}/reports/ProfitAndLoss`,
      {
        params:  { start_date: startDate, end_date: endDate, minorversion: 70 },
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      }
    );
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /inventory
// Returns all inventory items with quantity on hand
app.get('/inventory', async (req, res) => {
  try {
    const query = `SELECT * FROM Item WHERE Type = 'Inventory' MAXRESULTS 1000`;
    const data  = await qbGet('query', { query });
    const items = (data.QueryResponse?.Item || []).map(item => ({
      id:          item.Id,
      name:        item.Name,
      sku:         item.Sku || '',
      description: item.Description || '',
      unitPrice:   item.UnitPrice || 0,
      cost:        item.PurchaseCost || 0,
      margin:      item.UnitPrice && item.PurchaseCost
                     ? Math.round((item.UnitPrice - item.PurchaseCost) / item.UnitPrice * 100)
                     : null,
      qtyOnHand:   item.QtyOnHand || 0,
      reorderPoint: item.ReorderPoint || 0,
      lowStock:    (item.QtyOnHand || 0) <= (item.ReorderPoint || 0),
    }));
    res.json({
      items,
      lowStockCount: items.filter(i => i.lowStock).length,
      totalItems:    items.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /customers
// Returns all customers
app.get('/customers', async (req, res) => {
  try {
    const query = `SELECT * FROM Customer WHERE Active = true MAXRESULTS 1000`;
    const data  = await qbGet('query', { query });
    res.json(data.QueryResponse?.Customer || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /ar
// Returns open invoices (accounts receivable)
app.get('/ar', async (req, res) => {
  try {
    const query = `SELECT * FROM Invoice WHERE Balance > '0' MAXRESULTS 200`;
    const data  = await qbGet('query', { query });
    const invoices = (data.QueryResponse?.Invoice || []).map(inv => ({
      id:          inv.Id,
      docNum:      inv.DocNumber,
      customer:    inv.CustomerRef?.name,
      date:        inv.TxnDate,
      dueDate:     inv.DueDate,
      total:       inv.TotalAmt,
      balance:     inv.Balance,
      overdue:     inv.DueDate < new Date().toISOString().split('T')[0],
    }));
    res.json({
      invoices,
      totalAR:     invoices.reduce((s, i) => s + i.balance, 0),
      overdueCount: invoices.filter(i => i.overdue).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /invoice — Create a new invoice in QB
// Body: { customerName, items: [{name, qty, price}], dueDate }
app.post('/invoice', async (req, res) => {
  try {
    const { customerName, items, dueDate } = req.body;

    // Look up customer
    const custQuery = `SELECT * FROM Customer WHERE DisplayName = '${customerName}' MAXRESULTS 1`;
    const custData  = await qbGet('query', { query: custQuery });
    const customer  = custData.QueryResponse?.Customer?.[0];
    if (!customer) return res.status(404).json({ error: `Customer "${customerName}" not found` });

    const invoice = {
      CustomerRef: { value: customer.Id },
      DueDate:     dueDate,
      Line:        items.map((item, i) => ({
        LineNum:          i + 1,
        Amount:           item.qty * item.price,
        DetailType:       'SalesItemLineDetail',
        SalesItemLineDetail: {
          Qty:           item.qty,
          UnitPrice:     item.price,
          ItemRef:       { name: item.name },
        },
      })),
    };
    const result = await qbPost('invoice', invoice);
    res.json({ success: true, invoice: result.Invoice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /purchaseorder — Create a PO in QB
// Body: { vendorName, items: [{name, qty, cost}], shipDate }
app.post('/purchaseorder', async (req, res) => {
  try {
    const { vendorName, items, shipDate } = req.body;

    // Look up vendor
    const vendQuery = `SELECT * FROM Vendor WHERE DisplayName = '${vendorName}' MAXRESULTS 1`;
    const vendData  = await qbGet('query', { query: vendQuery });
    const vendor    = vendData.QueryResponse?.Vendor?.[0];
    if (!vendor) return res.status(404).json({ error: `Vendor "${vendorName}" not found` });

    const po = {
      VendorRef:   { value: vendor.Id },
      ShipDate:    shipDate,
      Line:        items.map((item, i) => ({
        LineNum:    i + 1,
        Amount:     item.qty * item.cost,
        DetailType: 'ItemBasedExpenseLineDetail',
        ItemBasedExpenseLineDetail: {
          Qty:      item.qty,
          UnitPrice: item.cost,
          ItemRef:  { name: item.name },
        },
      })),
    };
    const result = await qbPost('purchaseorder', po);
    res.json({ success: true, purchaseOrder: result.PurchaseOrder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /summary — CEO dashboard snapshot
app.get('/summary', async (req, res) => {
  try {
    const today     = new Date();
    const monthStart = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-01`;
    const todayStr  = today.toISOString().split('T')[0];

    const [salesData, arData, inventoryData] = await Promise.all([
      fetch(`http://localhost:${PORT}/sales?startDate=${monthStart}&endDate=${todayStr}`).then(r => r.json()).catch(() => ({})),
      fetch(`http://localhost:${PORT}/ar`).then(r => r.json()).catch(() => ({})),
      fetch(`http://localhost:${PORT}/inventory`).then(r => r.json()).catch(() => ({})),
    ]);

    res.json({
      mtdRevenue:    (salesData.salesReceipts || []).reduce((s, r) => s + r.TotalAmt, 0),
      openAR:        arData.totalAR || 0,
      overdueInvoices: arData.overdueCount || 0,
      lowStockItems: inventoryData.lowStockCount || 0,
      lastUpdated:   new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START SERVER ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BoxDrop QB Server running on port ${PORT}`);
  console.log(`   Visit https://boxdrop-qb.onrender.com/auth to connect QuickBooks`);
});
