// ============================================================
// BoxDrop Baltimore — QuickBooks OAuth Server
// Deployed on Railway.app
// ============================================================

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// ── CONFIG FROM ENVIRONMENT VARIABLES ────────────────────────
const CONFIG = {
  clientId:     process.env.QB_CLIENT_ID,
  clientSecret: process.env.QB_CLIENT_SECRET,
  redirectUri:  process.env.QB_REDIRECT_URI || 'https://nodejs-production-0b9b.up.railway.app/callback',
  companyId:    process.env.QB_COMPANY_ID   || null,
  environment:  'sandbox', // dev keys = sandbox
};

const QB_BASE   = 'https://sandbox-quickbooks.api.intuit.com/v3/company';
const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SCOPES    = 'com.intuit.quickbooks.accounting';

// ── TOKEN STORE (in-memory) ───────────────────────────────────
let tokenStore = { accessToken: null, refreshToken: null, expiresAt: null };
let companyId  = CONFIG.companyId;

// ── HELPERS ───────────────────────────────────────────────────
const basicAuth = () =>
  Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');

const isExpired = () =>
  !tokenStore.expiresAt || Date.now() >= tokenStore.expiresAt - 60000;

async function refreshToken() {
  if (!tokenStore.refreshToken) throw new Error('No refresh token — visit /auth');
  const res = await axios.post(TOKEN_URL,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenStore.refreshToken }).toString(),
    { headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  tokenStore.accessToken  = res.data.access_token;
  tokenStore.refreshToken = res.data.refresh_token || tokenStore.refreshToken;
  tokenStore.expiresAt    = Date.now() + res.data.expires_in * 1000;
  console.log('✅ Token refreshed');
}

async function getToken() {
  if (!tokenStore.accessToken) throw new Error('Not authenticated — visit /auth');
  if (isExpired()) await refreshToken();
  return tokenStore.accessToken;
}

async function qbGet(path, params = {}) {
  const token = await getToken();
  const res = await axios.get(`${QB_BASE}/${companyId}/${path}`, {
    params:  { ...params, minorversion: 70 },
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return res.data;
}

async function qbPost(path, body) {
  const token = await getToken();
  const res = await axios.post(`${QB_BASE}/${companyId}/${path}?minorversion=70`, body, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  return res.data;
}

// ── ROUTES ────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({
  status:        '🚀 BoxDrop QB Server running',
  authenticated: !!tokenStore.accessToken,
  companyId:     companyId || 'not set yet',
  tokenExpires:  tokenStore.expiresAt ? new Date(tokenStore.expiresAt).toISOString() : null,
}));

// Step 1: Start QB OAuth flow
app.get('/auth', (req, res) => {
  const url = `${AUTH_BASE}?` + new URLSearchParams({
    client_id:     CONFIG.clientId,
    redirect_uri:  CONFIG.redirectUri,
    response_type: 'code',
    scope:         SCOPES,
    state:         'boxdrop',
  });
  res.redirect(url);
});

// Step 2: QB sends user back here after login
app.get('/callback', async (req, res) => {
  const { code, realmId, error } = req.query;
  if (error) return res.status(400).send(`QB Error: ${error}`);
  if (!code)  return res.status(400).send('No auth code');

  // Capture company ID from OAuth if not already set
  if (realmId) { companyId = realmId; console.log(`✅ Company ID: ${realmId}`); }

  try {
    const r = await axios.post(TOKEN_URL,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CONFIG.redirectUri }).toString(),
      { headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokenStore.accessToken  = r.data.access_token;
    tokenStore.refreshToken = r.data.refresh_token;
    tokenStore.expiresAt    = Date.now() + r.data.expires_in * 1000;
    console.log('✅ QB Connected!');
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#fff;">
        <h1 style="color:#2d9e4e;font-size:48px;">✅</h1>
        <h2 style="color:#2d9e4e;">BoxDrop QB Connected!</h2>
        <p style="color:#888;">QuickBooks is now linked to your dashboard.</p>
        <p style="color:#555;font-size:13px;">Company ID: ${realmId}</p>
        <p style="color:#555;font-size:13px;">You can close this tab.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('Token error:', err.response?.data || err.message);
    res.status(500).send(`Auth failed: ${JSON.stringify(err.response?.data || err.message)}`);
  }
});

// ── DATA ENDPOINTS ────────────────────────────────────────────

// GET /sales?startDate=2026-01-01&endDate=2026-12-31
app.get('/sales', async (req, res) => {
  try {
    const { startDate = '2026-01-01', endDate = '2026-12-31' } = req.query;
    const [receipts, invoices] = await Promise.all([
      qbGet('query', { query: `SELECT * FROM SalesReceipt WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000` }),
      qbGet('query', { query: `SELECT * FROM Invoice WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000` }),
    ]);
    res.json({
      salesReceipts: receipts.QueryResponse?.SalesReceipt || [],
      invoices:      invoices.QueryResponse?.Invoice      || [],
      total: (receipts.QueryResponse?.SalesReceipt?.length || 0) + (invoices.QueryResponse?.Invoice?.length || 0),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /inventory
app.get('/inventory', async (req, res) => {
  try {
    const data  = await qbGet('query', { query: `SELECT * FROM Item WHERE Type = 'Inventory' MAXRESULTS 1000` });
    const items = (data.QueryResponse?.Item || []).map(item => ({
      id:           item.Id,
      name:         item.Name,
      sku:          item.Sku || '',
      description:  item.Description || '',
      unitPrice:    item.UnitPrice    || 0,
      cost:         item.PurchaseCost || 0,
      margin:       item.UnitPrice && item.PurchaseCost
                      ? Math.round((item.UnitPrice - item.PurchaseCost) / item.UnitPrice * 100)
                      : null,
      qtyOnHand:    item.QtyOnHand    || 0,
      reorderPoint: item.ReorderPoint || 0,
      lowStock:     (item.QtyOnHand || 0) <= (item.ReorderPoint || 2),
    }));
    res.json({ items, lowStockCount: items.filter(i => i.lowStock).length, total: items.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /pnl?startDate=2026-01-01&endDate=2026-06-30
app.get('/pnl', async (req, res) => {
  try {
    const { startDate = '2026-01-01', endDate = '2026-06-30' } = req.query;
    const token = await getToken();
    const result = await axios.get(`${QB_BASE}/${companyId}/reports/ProfitAndLoss`, {
      params:  { start_date: startDate, end_date: endDate, minorversion: 70 },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    res.json(result.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /ar — open invoices
app.get('/ar', async (req, res) => {
  try {
    const data     = await qbGet('query', { query: `SELECT * FROM Invoice WHERE Balance > '0' MAXRESULTS 200` });
    const invoices = (data.QueryResponse?.Invoice || []).map(inv => ({
      id:       inv.Id,
      docNum:   inv.DocNumber,
      customer: inv.CustomerRef?.name,
      date:     inv.TxnDate,
      dueDate:  inv.DueDate,
      total:    inv.TotalAmt,
      balance:  inv.Balance,
      overdue:  inv.DueDate < new Date().toISOString().split('T')[0],
    }));
    res.json({ invoices, totalAR: invoices.reduce((s, i) => s + i.balance, 0), overdueCount: invoices.filter(i => i.overdue).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /customers
app.get('/customers', async (req, res) => {
  try {
    const data = await qbGet('query', { query: `SELECT * FROM Customer WHERE Active = true MAXRESULTS 1000` });
    res.json(data.QueryResponse?.Customer || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /invoice — create invoice in QB
app.post('/invoice', async (req, res) => {
  try {
    const { customerName, items, dueDate } = req.body;
    const custData = await qbGet('query', { query: `SELECT * FROM Customer WHERE DisplayName = '${customerName}' MAXRESULTS 1` });
    const customer = custData.QueryResponse?.Customer?.[0];
    if (!customer) return res.status(404).json({ error: `Customer "${customerName}" not found` });
    const invoice = {
      CustomerRef: { value: customer.Id },
      DueDate: dueDate,
      Line: items.map((item, i) => ({
        LineNum: i + 1,
        Amount:  item.qty * item.price,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: { Qty: item.qty, UnitPrice: item.price, ItemRef: { name: item.name } },
      })),
    };
    const result = await qbPost('invoice', invoice);
    res.json({ success: true, invoice: result.Invoice });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /purchaseorder — create PO in QB
app.post('/purchaseorder', async (req, res) => {
  try {
    const { vendorName, items, shipDate } = req.body;
    const vendData = await qbGet('query', { query: `SELECT * FROM Vendor WHERE DisplayName = '${vendorName}' MAXRESULTS 1` });
    const vendor   = vendData.QueryResponse?.Vendor?.[0];
    if (!vendor) return res.status(404).json({ error: `Vendor "${vendorName}" not found` });
    const po = {
      VendorRef: { value: vendor.Id },
      ShipDate:  shipDate,
      Line: items.map((item, i) => ({
        LineNum:    i + 1,
        Amount:     item.qty * item.cost,
        DetailType: 'ItemBasedExpenseLineDetail',
        ItemBasedExpenseLineDetail: { Qty: item.qty, UnitPrice: item.cost, ItemRef: { name: item.name } },
      })),
    };
    const result = await qbPost('purchaseorder', po);
    res.json({ success: true, purchaseOrder: result.PurchaseOrder });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /summary — CEO snapshot
app.get('/summary', async (req, res) => {
  try {
    const today      = new Date();
    const monthStart = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-01`;
    const todayStr   = today.toISOString().split('T')[0];
    const [salesData, arData, invData] = await Promise.all([
      qbGet('query', { query: `SELECT * FROM SalesReceipt WHERE TxnDate >= '${monthStart}' AND TxnDate <= '${todayStr}' MAXRESULTS 500` }),
      qbGet('query', { query: `SELECT * FROM Invoice WHERE Balance > '0' MAXRESULTS 200` }),
      qbGet('query', { query: `SELECT * FROM Item WHERE Type = 'Inventory' MAXRESULTS 1000` }),
    ]);
    const receipts  = salesData.QueryResponse?.SalesReceipt || [];
    const invoices  = arData.QueryResponse?.Invoice         || [];
    const items     = invData.QueryResponse?.Item           || [];
    res.json({
      mtdRevenue:       receipts.reduce((s, r) => s + (r.TotalAmt || 0), 0),
      mtdTransactions:  receipts.length,
      openAR:           invoices.reduce((s, i) => s + (i.Balance || 0), 0),
      overdueInvoices:  invoices.filter(i => i.DueDate < todayStr).length,
      totalInventory:   items.length,
      lowStockItems:    items.filter(i => (i.QtyOnHand || 0) <= (i.ReorderPoint || 2)).length,
      lastUpdated:      new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BoxDrop QB Server on port ${PORT}`));
