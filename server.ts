import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'ledgers.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

interface UserLedger {
  transactions: any[];
  customers: string[];
  bin: any[];
  updatedAt: number;
}

let db: Record<string, UserLedger> = {};

if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    db = JSON.parse(raw);
  } catch (err) {
    console.error('Error reading db file:', err);
    db = {};
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('Error saving db file:', err);
  }
}

function sanitizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// REST endpoints for data sync & backup fallback
app.get('/api/ledger', (req, res) => {
  const email = sanitizeEmail(req.query.email as string);
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }
  const userLedger = db[email] || { transactions: [], customers: [], bin: [], updatedAt: Date.now() };
  res.json(userLedger);
});

app.post('/api/ledger', (req, res) => {
  const email = sanitizeEmail(req.body.email);
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  const { transactions = [], customers = [], bin = [] } = req.body;
  const ledgerData: UserLedger = {
    transactions,
    customers,
    bin,
    updatedAt: Date.now(),
  };

  db[email] = ledgerData;
  saveDb();

  // Broadcast to all active ws connections for this email
  broadcastToUser(email, {
    type: 'sync',
    email,
    data: ledgerData,
  });

  res.json({ success: true, updatedAt: ledgerData.updatedAt });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

interface ExtendedWebSocket extends WebSocket {
  userEmail?: string;
  isAlive?: boolean;
}

const userSockets = new Map<string, Set<ExtendedWebSocket>>();

function broadcastToUser(email: string, payload: any, senderWs?: WebSocket) {
  const sockets = userSockets.get(email);
  if (!sockets) return;
  const msgStr = JSON.stringify(payload);
  for (const client of sockets) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(msgStr);
    }
  }
}

wss.on('connection', (ws: ExtendedWebSocket) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'auth') {
        const email = sanitizeEmail(data.email);
        if (email) {
          // Unregister previous if needed
          if (ws.userEmail && userSockets.has(ws.userEmail)) {
            userSockets.get(ws.userEmail)?.delete(ws);
          }
          ws.userEmail = email;
          if (!userSockets.has(email)) {
            userSockets.set(email, new Set());
          }
          userSockets.get(email)!.add(ws);

          // Send back current state
          const current = db[email] || { transactions: [], customers: [], bin: [], updatedAt: Date.now() };
          ws.send(
            JSON.stringify({
              type: 'sync',
              email,
              data: current,
            })
          );
        }
      } else if (data.type === 'update') {
        const email = sanitizeEmail(data.email || ws.userEmail);
        if (email) {
          const { transactions = [], customers = [], bin = [] } = data.data || {};
          const ledgerData: UserLedger = {
            transactions,
            customers,
            bin,
            updatedAt: Date.now(),
          };
          db[email] = ledgerData;
          saveDb();

          // Broadcast to other devices logged into same email
          broadcastToUser(email, { type: 'sync', email, data: ledgerData }, ws);
        }
      } else if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (err) {
      console.error('Error handling WS message:', err);
    }
  });

  ws.on('close', () => {
    if (ws.userEmail && userSockets.has(ws.userEmail)) {
      userSockets.get(ws.userEmail)?.delete(ws);
      if (userSockets.get(ws.userEmail)?.size === 0) {
        userSockets.delete(ws.userEmail);
      }
    }
  });
});

const interval = setInterval(() => {
  wss.clients.forEach((ws: ExtendedWebSocket) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

// Vite or Static Server Setup
async function setupFrontend() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
    });
    app.use(vite.middlewares);
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist/index.html'));
    });
  }
}

setupFrontend().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
});
