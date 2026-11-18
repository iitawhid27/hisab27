import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  db,
  auth,
  googleProvider,
  setDoc,
  doc,
  onSnapshot,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  testConnection,
  User,
} from './firebase';

interface Transaction {
  id: number;
  person: string;
  type: 'take' | 'return';
  amount: number;
  date: string;
  note?: string;
}

interface BinItem {
  bid: number;
  at: number;
  kind: 'tx' | 'cust';
  tx?: Transaction;
  name?: string;
  txs?: Transaction[];
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

const KEY = 'ledger';
const CKEY = 'customers';
const BKEY = 'bin';
const USER_KEY = 'khata_user_email';

const bn = (n: number) => Number(n || 0).toLocaleString('bn-BD', { maximumFractionDigits: 2 });
const money = (n: number) => '৳ ' + bn(n);
const esc = (s: string) => String(s || '');
const sanitizeEmail = (email: string) => (email || '').trim().toLowerCase().replace(/\//g, '_');

const memoryStore: Record<string, string> = {};
const safeStorage = {
  getItem(key: string): string | null {
    try {
      return typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem(key) : (memoryStore[key] ?? null);
    } catch {
      return memoryStore[key] ?? null;
    }
  },
  setItem(key: string, val: string): void {
    memoryStore[key] = val;
    try {
      if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(key, val);
    } catch {
      // ignore WebView storage restrictions
    }
  },
  removeItem(key: string): void {
    delete memoryStore[key];
    try {
      if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

const LIVE_ORIGIN = 'https://ais-pre-bqgulzlt5muonfx2j46szg-564174579344.asia-east1.run.app';
const isPackagedMobile = () => {
  if (typeof window === 'undefined') return false;
  const proto = window.location.protocol;
  const host = window.location.hostname;
  return (
    proto === 'file:' ||
    proto === 'capacitor:' ||
    proto === 'content:' ||
    host === 'appassets.androidplatform.net' ||
    host.endsWith('.androidplatform.net') ||
    host === '127.0.0.1' ||
    (host === 'localhost' && window.location.port !== '3000')
  );
};
const getApiUrl = (path: string) => (isPackagedMobile() ? `${LIVE_ORIGIN}${path}` : path);
const getWsUrl = () => {
  if (isPackagedMobile()) return `${LIVE_ORIGIN.replace(/^http/, 'ws')}/ws`;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
};

export default function App() {
  // Auth state
  const [userEmail, setUserEmail] = useState<string>(() => safeStorage.getItem(USER_KEY) || '');
  const [loginEmailInput, setLoginEmailInput] = useState<string>('');
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);

  // App data state
  const [tx, setTx] = useState<Transaction[]>(() => {
    try { return JSON.parse(safeStorage.getItem(KEY) || '[]'); } catch { return []; }
  });
  const [cust, setCust] = useState<string[]>(() => {
    try { return JSON.parse(safeStorage.getItem(CKEY) || '[]'); } catch { return []; }
  });
  const [bin, setBin] = useState<BinItem[]>(() => {
    try { return JSON.parse(safeStorage.getItem(BKEY) || '[]'); } catch { return []; }
  });

  // UI state
  const [view, setView] = useState<'dash' | 'entry' | 'set'>('dash');
  const [type, setType] = useState<'take' | 'return'>('take');
  const [openName, setOpenName] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [toastMsg, setToastMsg] = useState<string>('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [firebaseConnected, setFirebaseConnected] = useState<boolean>(false);

  // Form state
  const [personInput, setPersonInput] = useState<string>('');
  const [amountInput, setAmountInput] = useState<string>('');
  const [dateInput, setDateInput] = useState<string>(() => new Date().toLocaleDateString('en-CA'));
  const [noteInput, setNoteInput] = useState<string>('');
  const [showSug, setShowSug] = useState<boolean>(false);

  // PDF report state
  const [reportHtml, setReportHtml] = useState<string>('');

  const toastTimerRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToastMsg('');
    }, 2600);
  };

  // Test Firestore Connection on boot
  useEffect(() => {
    testConnection();
  }, []);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setFirebaseUser(currentUser);
      setAuthReady(true);
      if (currentUser && currentUser.email) {
        const email = currentUser.email.toLowerCase();
        setUserEmail(email);
        safeStorage.setItem(USER_KEY, email);
      }
    });
    return () => unsubscribe();
  }, []);

  // Sync data locally, over WebSocket, and to Firebase Firestore
  const syncData = async (newTx: Transaction[], newCust: string[], newBin: BinItem[]) => {
    setTx(newTx);
    setCust(newCust);
    setBin(newBin);
    safeStorage.setItem(KEY, JSON.stringify(newTx));
    safeStorage.setItem(CKEY, JSON.stringify(newCust));
    safeStorage.setItem(BKEY, JSON.stringify(newBin));

    if (userEmail) {
      const cleanEmail = sanitizeEmail(userEmail);
      const payloadData = {
        transactions: newTx,
        customers: newCust,
        bin: newBin,
        updatedAt: Date.now(),
      };

      // 1. WebSocket & Express sync
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'update',
            email: userEmail,
            data: payloadData,
          })
        );
      } else {
        fetch(getApiUrl('/api/ledger'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: userEmail, ...payloadData }),
        }).catch((err) => console.error('REST sync fail:', err));
      }

      // 2. Firebase Firestore sync (only when Firebase Auth user matches verified owner)
      if (
        authReady &&
        firebaseUser &&
        firebaseUser.emailVerified &&
        firebaseUser.email?.toLowerCase() === cleanEmail
      ) {
        try {
          await setDoc(doc(db, 'ledgers', cleanEmail), payloadData);
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `ledgers/${cleanEmail}`);
        }
      }
    }
  };

  // Listen to Firestore real-time document updates for userEmail
  useEffect(() => {
    if (!userEmail || !authReady || !firebaseUser) {
      setFirebaseConnected(false);
      return;
    }

    const cleanEmail = sanitizeEmail(userEmail);
    if (!firebaseUser.emailVerified || firebaseUser.email?.toLowerCase() !== cleanEmail) {
      setFirebaseConnected(false);
      return;
    }

    const docRef = doc(db, 'ledgers', cleanEmail);

    const unsubscribe = onSnapshot(
      docRef,
      (snapshot) => {
        setFirebaseConnected(true);
        if (snapshot.exists()) {
          const data = snapshot.data();
          if (data) {
            const serverTx = Array.isArray(data.transactions) ? data.transactions : [];
            const serverCust = Array.isArray(data.customers) ? data.customers : [];
            const serverBin = Array.isArray(data.bin) ? data.bin : [];

            setTx(serverTx);
            setCust(serverCust);
            setBin(serverBin);

            safeStorage.setItem(KEY, JSON.stringify(serverTx));
            safeStorage.setItem(CKEY, JSON.stringify(serverCust));
            safeStorage.setItem(BKEY, JSON.stringify(serverBin));
          }
        }
      },
      (error) => {
        setFirebaseConnected(false);
        handleFirestoreError(error, OperationType.GET, `ledgers/${cleanEmail}`);
      }
    );

    return () => unsubscribe();
  }, [userEmail, authReady, firebaseUser]);

  // WebSocket & HTTP sync effect
  useEffect(() => {
    if (!userEmail) return;

    fetch(getApiUrl(`/api/ledger?email=${encodeURIComponent(userEmail)}`))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && (Array.isArray(data.transactions) || Array.isArray(data.customers))) {
          const serverTx = Array.isArray(data.transactions) ? data.transactions : [];
          const serverCust = Array.isArray(data.customers) ? data.customers : [];
          const serverBin = Array.isArray(data.bin) ? data.bin : [];
          if (serverTx.length || serverCust.length || serverBin.length) {
            setTx(serverTx);
            setCust(serverCust);
            setBin(serverBin);
            safeStorage.setItem(KEY, JSON.stringify(serverTx));
            safeStorage.setItem(CKEY, JSON.stringify(serverCust));
            safeStorage.setItem(BKEY, JSON.stringify(serverBin));
          }
        }
      })
      .catch(() => {});

    let socket: WebSocket | null = null;
    let reconnectTimeout: any = null;

    const connectWS = () => {
      const wsUrl = getWsUrl();

      socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        setWsConnected(true);
        socket?.send(JSON.stringify({ type: 'auth', email: userEmail }));
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'sync' && msg.data) {
            const { transactions = [], customers = [], bin: serverBin = [] } = msg.data;
            setTx(transactions);
            setCust(customers);
            setBin(serverBin);
            safeStorage.setItem(KEY, JSON.stringify(transactions));
            safeStorage.setItem(CKEY, JSON.stringify(customers));
            safeStorage.setItem(BKEY, JSON.stringify(serverBin));
          }
        } catch (e) {
          console.error('WS parse error:', e);
        }
      };

      socket.onclose = () => {
        setWsConnected(false);
        reconnectTimeout = setTimeout(connectWS, 3000);
      };

      socket.onerror = () => {
        setWsConnected(false);
      };
    };

    connectWS();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (socket) socket.close();
    };
  }, [userEmail]);

  // Handle passwordless Gmail input login
  const handleLogin = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const email = loginEmailInput.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      showToast('সঠিক জিমেইল অ্যাড্রেস দিন');
      return;
    }
    safeStorage.setItem(USER_KEY, email);
    setUserEmail(email);
    showToast('লগইন সফল হয়েছে ✓');
  };

  // Handle Firebase Google Auth popup sign-in
  const handleGoogleSignIn = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      if (result.user && result.user.email) {
        const email = result.user.email.toLowerCase();
        safeStorage.setItem(USER_KEY, email);
        setUserEmail(email);
        showToast('Google দিয়ে লগইন সফল হয়েছে ✓');
      }
    } catch (error) {
      console.error('Google Sign In error:', error);
      showToast('Google সাইন-ইন সম্ভব হয়নি');
    }
  };

  const handleLogout = async () => {
    if (confirm('আপনি কি এই জিমেইল থেকে লগআউট করতে চান?')) {
      try {
        await signOut(auth);
      } catch (e) {
        // ignore
      }
      safeStorage.removeItem(USER_KEY);
      setUserEmail('');
      setLoginEmailInput('');
      showToast('লগআউট করা হয়েছে');
    }
  };

  // Names helper
  const allNames = useMemo(() => {
    const map = new Map<string, string>();
    [...cust, ...tx.map((t) => t.person)].forEach((p) => {
      if (p && p.trim()) {
        const k = p.trim().toLowerCase();
        if (!map.has(k)) map.set(k, p.trim());
      }
    });
    return Array.from(map.values());
  }, [cust, tx]);

  const getCustomerSummary = (name: string) => {
    const rows = tx.filter((t) => t.person.toLowerCase() === name.toLowerCase());
    const taken = rows.filter((t) => t.type === 'take').reduce((s, t) => s + t.amount, 0);
    const ret = rows.filter((t) => t.type === 'return').reduce((s, t) => s + t.amount, 0);
    return { taken, ret, due: taken - ret, rows };
  };

  const totals = useMemo(() => {
    let T = 0;
    let R = 0;
    allNames.forEach((n) => {
      const s = getCustomerSummary(n);
      T += s.taken;
      R += s.ret;
    });
    return { taken: T, ret: R, due: T - R };
  }, [allNames, tx]);

  const addCustomer = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return '';
    const existing = allNames.find((x) => x.toLowerCase() === trimmed.toLowerCase()) || trimmed;
    if (!cust.some((c) => c.toLowerCase() === existing.toLowerCase())) {
      const newCust = [...cust, existing];
      syncData(tx, newCust, bin);
    }
    return existing;
  };

  const resetForm = () => {
    setEditingId(null);
    setPersonInput('');
    setType('take');
    setAmountInput('');
    setNoteInput('');
    setDateInput(new Date().toLocaleDateString('en-CA'));
  };

  const handleSave = () => {
    let person = personInput.trim();
    const amount = Number(amountInput);
    const date = dateInput;

    if (!person || !date || !Number.isFinite(amount) || amount <= 0) {
      showToast('কাস্টমার, তারিখ ও সঠিক টাকা দিন');
      return;
    }

    const ex = allNames.find((n) => n.toLowerCase() === person.toLowerCase());
    if (type === 'return' && !ex) {
      showToast('এই নামে কাস্টমার নেই');
      return;
    }

    person = type === 'return' ? ex! : addCustomer(person);

    const old = editingId ? tx.find((t) => t.id === editingId) : null;
    if (type === 'return') {
      let av = getCustomerSummary(person).due;
      if (old && old.type === 'return' && old.person.toLowerCase() === person.toLowerCase()) {
        av += old.amount;
      }
      if (amount > av) {
        showToast('এত টাকা বাকি নেই। বাকি: ' + money(av));
        return;
      }
    }

    const rec: Transaction = {
      id: editingId || Date.now(),
      person,
      type,
      amount,
      date,
      note: noteInput.trim(),
    };

    let updatedTx: Transaction[];
    if (editingId) {
      updatedTx = tx.map((t) => (t.id === editingId ? rec : t));
    } else {
      updatedTx = [rec, ...tx];
    }

    syncData(updatedTx, cust, bin);
    setOpenName(person);
    resetForm();
    setView('dash');
    showToast('সেভ হয়েছে ✓');
  };

  const handleEdit = (id: number) => {
    const t = tx.find((x) => x.id === id);
    if (!t) return;
    setEditingId(id);
    setType(t.type);
    setPersonInput(t.person);
    setAmountInput(String(t.amount));
    setDateInput(t.date);
    setNoteInput(t.note || '');
    setView('entry');
  };

  const handleDeleteTx = (id: number) => {
    if (confirm('এই লেনদেন ডিলিট করবেন?')) {
      const t = tx.find((x) => x.id === id);
      const newBin: BinItem[] = t ? [{ bid: Date.now() + Math.random(), at: Date.now(), kind: 'tx', tx: t }, ...bin] : bin;
      const newTx = tx.filter((x) => x.id !== id);
      syncData(newTx, cust, newBin);
      showToast('রিসাইকেল বিনে গেছে');
    }
  };

  const handleDeleteCustomer = (name: string) => {
    if (confirm(`${name}-কে ও তার সব লেনদেন ডিলিট করবেন?`)) {
      const custTxs = tx.filter((t) => t.person.toLowerCase() === name.toLowerCase());
      const newBin: BinItem[] = [{ bid: Date.now() + Math.random(), at: Date.now(), kind: 'cust', name, txs: custTxs }, ...bin];
      const newTx = tx.filter((t) => t.person.toLowerCase() !== name.toLowerCase());
      const newCust = cust.filter((c) => c.toLowerCase() !== name.toLowerCase());
      if (openName === name) setOpenName('');
      syncData(newTx, newCust, newBin);
      showToast('রিসাইকেল বিনে গেছে');
    }
  };

  const handleBinRestore = (item: BinItem) => {
    let newTx = [...tx];
    let newCust = [...cust];
    if (item.kind === 'tx' && item.tx) {
      newTx.unshift(item.tx);
    } else if (item.kind === 'cust' && item.name && item.txs) {
      newTx = [...item.txs, ...newTx];
      if (!newCust.some((c) => c.toLowerCase() === item.name!.toLowerCase())) {
        newCust.push(item.name);
      }
    }
    const newBin = bin.filter((x) => x.bid !== item.bid);
    syncData(newTx, newCust, newBin);
    showToast('ফিরিয়ে আনা হয়েছে ✓');
  };

  const handleBinPermanentDelete = (bid: number) => {
    if (confirm('চিরতরে মুছে ফেলবেন?')) {
      const newBin = bin.filter((x) => x.bid !== bid);
      syncData(tx, cust, newBin);
    }
  };

  const handleBinClear = () => {
    if (confirm('বিনের সব চিরতরে মুছে যাবে। চালিয়ে যাবেন?')) {
      syncData(tx, cust, []);
    }
  };

  const handleGeneratePdf = (name?: string) => {
    if (!tx.length) {
      showToast('কোনো হিসাব নেই');
      return;
    }
    const rows = (name ? getCustomerSummary(name).rows : tx)
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

    let h = `<h1>খাতা${name ? ' — ' + esc(name) : ''}</h1><div>তারিখ: ${new Date().toLocaleDateString('bn-BD')}</div>`;
    if (!name) {
      let T = 0;
      let R = 0;
      h +=
        '<table><tr><th>নাম</th><th class="n">নিয়েছে</th><th class="n">ফেরত</th><th class="n">বাকি</th></tr>' +
        allNames
          .map((n) => {
            const s = getCustomerSummary(n);
            T += s.taken;
            R += s.ret;
            return `<tr><td>${esc(n)}</td><td class="n">${money(s.taken)}</td><td class="n">${money(s.ret)}</td><td class="n">${money(s.due)}</td></tr>`;
          })
          .join('') +
        `<tr><th>মোট</th><th class="n">${money(T)}</th><th class="n">${money(R)}</th><th class="n">${money(T - R)}</th></tr></table>`;
    } else {
      const s = getCustomerSummary(name);
      h += `<div>নিয়েছে: ${money(s.taken)} | ফেরত: ${money(s.ret)} | <b>বাকি: ${money(s.due)}</b></div>`;
    }

    let bal = 0;
    h +=
      '<table><tr><th>তারিখ</th>' +
      (name ? '' : '<th>নাম</th>') +
      '<th>বিবরণ</th><th>ধরন</th><th class="n">টাকা</th>' +
      (name ? '<th class="n">বাকি</th>' : '') +
      '</tr>' +
      rows
        .map((t) => {
          bal += t.type === 'take' ? t.amount : -t.amount;
          return `<tr><td>${esc(t.date)}</td>${name ? '' : `<td>${esc(t.person)}</td>`}<td>${esc(
            t.note || '-'
          )}</td><td>${t.type === 'take' ? 'নিয়েছে' : 'ফেরত'}</td><td class="n">${money(t.amount)}</td>${
            name ? `<td class="n">${money(bal)}</td>` : ''
          }</tr>`;
        })
        .join('') +
      '</table>';

    setReportHtml(h);
    setTimeout(() => window.print(), 150);
  };

  const handleBackupDownload = () => {
    const dataStr = JSON.stringify({ transactions: tx, customers: cust }, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `khata-backup-${userEmail || 'data'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      const d = Array.isArray(raw) ? raw : raw.transactions;
      const cs =
        !Array.isArray(raw) && Array.isArray(raw.customers)
          ? raw.customers.filter((c: any) => typeof c === 'string' && c.trim())
          : [];

      if (
        !Array.isArray(d) ||
        !d.every(
          (t) =>
            t &&
            typeof t.person === 'string' &&
            ['take', 'return'].includes(t.type) &&
            Number.isFinite(t.amount) &&
            t.amount > 0 &&
            typeof t.date === 'string'
        )
      ) {
        throw new Error('Invalid backup format');
      }

      if (confirm('বর্তমান হিসাবের জায়গায় ব্যাকআপের হিসাব বসবে। চালিয়ে যাবেন?')) {
        syncData(d, cs, bin);
        setOpenName('');
        showToast('ফিরিয়ে আনা হয়েছে ✓');
      }
    } catch (err) {
      showToast('ভুল ব্যাকআপ ফাইল');
    }
    e.target.value = '';
  };

  // Filtered names for search query
  const filteredNames = useMemo(() => {
    const q = search.toLowerCase().trim();
    return allNames
      .filter((n) => n.toLowerCase().includes(q))
      .sort((a, b) => getCustomerSummary(b).due - getCustomerSummary(a).due);
  }, [allNames, search, tx]);

  // Autocomplete suggestions for entry form
  const suggestions = useMemo(() => {
    if (!personInput.trim()) return [];
    const isReturn = type === 'return';
    const q = personInput.trim().toLowerCase();
    return allNames
      .filter((n) => (!isReturn || getCustomerSummary(n).due > 0) && n.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b, 'bn'));
  }, [allNames, personInput, type, tx]);

  // Clean bin items (keep items for 30 days)
  const activeBin = useMemo(() => {
    const now = Date.now();
    return bin.filter((b) => now - b.at < 30 * 864e5);
  }, [bin]);

  // If not logged in, render Login screen
  if (!userEmail) {
    return (
      <main id="app" className="wrap">
        <div id="login" style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            <img
              src="./logo.png"
              alt="খাতা লোগো"
              style={{ width: '84px', height: '84px', borderRadius: '20px', objectFit: 'cover', boxShadow: '0 8px 24px rgba(10,124,115,0.2)' }}
            />
          </div>
          <h1>খাতা</h1>
          <p>আপনার ডিজিটাল হিসাব খাতা। Firebase ও WebSocket-এর মাধ্যমে অটোমেটিক রিয়েল-টাইম লাইভ সিঙ্ক।</p>

          <button
            type="button"
            className="gbtn"
            onClick={handleGoogleSignIn}
            style={{ marginBottom: '16px' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                fill="#EA4335"
              />
            </svg>
            Google অ্যাকাউন্ট দিয়ে প্রবেশ করুন
          </button>

          <div style={{ textAlign: 'center', color: 'var(--mute)', margin: '8px 0 16px', fontSize: '14px' }}>
            অথবা জিমেইল অ্যাড্রেস লিখুন:
          </div>

          <form onSubmit={handleLogin}>
            <input
              type="email"
              required
              placeholder="উদাহরণ: myaccount@gmail.com"
              value={loginEmailInput}
              onChange={(e) => setLoginEmailInput(e.target.value)}
              style={{ marginBottom: '14px', fontSize: '16px' }}
            />
            <button type="submit" style={{ width: '100%', padding: '13px', background: 'var(--ink)' }}>
              জিমেইল দিয়ে প্রবেশ করুন
            </button>
          </form>
        </div>
        <div id="toast" className={toastMsg ? 'on' : ''}>
          {toastMsg}
        </div>
      </main>
    );
  }

  // Render Dashboard
  const renderDashboard = () => (
    <section id="v-dash" className={view !== 'dash' ? 'hidden' : ''}>
      <div className="hero">
        <div className="lbl">মোট বাকি</div>
        <div className="big" id="totalDue">
          {money(totals.due)}
        </div>
        <div className="bar">
          <i
            id="bar"
            style={{ width: `${totals.taken ? Math.min(100, (totals.ret / totals.taken) * 100) : 0}%` }}
          ></i>
        </div>
        <div className="two">
          <div>
            <span className="dot" style={{ background: '#3fd1c4' }}></span>ফেরত
            <b id="totalPaid">{money(totals.ret)}</b>
          </div>
          <div>
            মোট নিয়েছে<b id="totalTaken">{money(totals.taken)}</b>
          </div>
        </div>
      </div>

      <div className="sec">
        <h2>কার কাছে কত</h2>
        <button
          id="addCust"
          className="ico"
          aria-label="নতুন কাস্টমার"
          title="নতুন কাস্টমার"
          onClick={() => {
            const n = prompt('কাস্টমারের নাম');
            if (n === null || !n.trim()) return;
            const ex = allNames.some((x) => x.toLowerCase() === n.trim().toLowerCase());
            addCustomer(n);
            showToast(ex ? 'এই নামে কাস্টমার আগে থেকেই আছে' : 'কাস্টমার সেভ হয়েছে ✓');
          }}
        >
          <svg viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <input
        id="search"
        placeholder="নাম খুঁজুন"
        style={{ margin: 0 }}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div id="peopleList">
        {filteredNames.length ? (
          filteredNames.map((name) => {
            const s = getCustomerSummary(name);
            const isOpen = name === openName;
            const sortedRows = s.rows.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
            const pct = s.taken ? Math.min(100, (s.ret / s.taken) * 100) : 0;

            return (
              <div key={name} className="p">
                <div className="ph" onClick={() => setOpenName(isOpen ? '' : name)}>
                  <div className="av">{Array.from(name)[0] || '?'}</div>
                  <div className="pn">
                    <b>{name}</b>
                    <div className="mini">
                      <i style={{ width: `${pct}%` }}></i>
                    </div>
                  </div>
                  {s.due > 0 ? (
                    <div className="amt">{money(s.due)}</div>
                  ) : (
                    <div className="amt ok">{s.rows.length ? 'পরিশোধ ✓' : 'এন্ট্রি নেই'}</div>
                  )}
                </div>

                {isOpen && (
                  <div className="pb">
                    {sortedRows.map((t) => (
                      <div key={t.id} className="r">
                        <div className="d">
                          <b>{t.note || (t.type === 'take' ? 'নিয়েছে' : 'ফেরত দিয়েছে')}</b>
                          <small>{t.date}</small>
                        </div>
                        <span className={`m ${t.type === 'take' ? 't' : 'g'}`}>
                          {t.type === 'take' ? '+' : '−'}
                          {money(t.amount)}
                        </span>
                        <button className="ghost sm" onClick={() => handleEdit(t.id)}>
                          এডিট
                        </button>
                        <button className="danger sm" onClick={() => handleDeleteTx(t.id)}>
                          ডিলিট
                        </button>
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                      <button className="sm" onClick={() => handleGeneratePdf(name)}>
                        PDF
                      </button>
                      <button className="danger sm" onClick={() => handleDeleteCustomer(name)}>
                        কাস্টমার মুছুন
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="empty">
            এখনো কোনো হিসাব নেই।<br />নিচে “এন্ট্রি” থেকে শুরু করুন।
          </div>
        )}
      </div>
    </section>
  );

  // Render Entry View
  const renderEntry = () => (
    <section id="v-entry" className={view !== 'entry' ? 'hidden' : ''}>
      <div className="card">
        <h2 id="entryTitle" style={{ fontSize: '26px' }}>
          {editingId ? 'এন্ট্রি এডিট' : 'নতুন এন্ট্রি'}
        </h2>

        <label>লেনদেনের ধরন</label>
        <div className="seg" id="seg">
          <button
            type="button"
            className={type === 'take' ? 'on' : ''}
            data-t="take"
            onClick={() => setType('take')}
          >
            টাকা নিয়েছে
          </button>
          <button
            type="button"
            className={type === 'return' ? 'on' : ''}
            data-t="return"
            onClick={() => setType('return')}
          >
            ফেরত দিয়েছে
          </button>
        </div>

        <label>কাস্টমার</label>
        <input
          id="person"
          autoComplete="off"
          placeholder="নাম লিখুন বা বেছে নিন"
          value={personInput}
          onFocus={() => setShowSug(true)}
          onBlur={() => setTimeout(() => setShowSug(false), 250)}
          onChange={(e) => {
            setPersonInput(e.target.value);
            setShowSug(true);
          }}
        />
        {showSug && suggestions.length > 0 && (
          <div className="sug" onMouseDown={(e) => e.preventDefault()}>
            {suggestions.map((n) => {
              const d = getCustomerSummary(n).due;
              return (
                <div
                  key={n}
                  onClick={() => {
                    setPersonInput(n);
                    setShowSug(false);
                  }}
                >
                  <span>{n}</span>
                  {d > 0 && <small>বাকি {money(d)}</small>}
                </div>
              );
            })}
          </div>
        )}

        <label>টাকার পরিমাণ</label>
        <input
          id="amount"
          type="number"
          inputMode="decimal"
          min="0.01"
          step="0.01"
          placeholder="০"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
        />

        <label>তারিখ</label>
        <input
          id="date"
          type="date"
          value={dateInput}
          onChange={(e) => setDateInput(e.target.value)}
        />

        <label>বিবরণ</label>
        <input
          id="note"
          placeholder="ঐচ্ছিক"
          value={noteInput}
          onChange={(e) => setNoteInput(e.target.value)}
        />

        <button id="saveBtn" onClick={handleSave}>
          {editingId ? 'আপডেট করুন' : 'সেভ করুন'}
        </button>

        {editingId && (
          <button
            type="button"
            className="ghost"
            id="cancelBtn"
            style={{ width: '100%', marginTop: '10px' }}
            onClick={() => {
              resetForm();
              setView('dash');
            }}
          >
            বাতিল
          </button>
        )}
      </div>
    </section>
  );

  // Render Settings View
  const renderSettings = () => (
    <section id="v-set" className={view !== 'set' ? 'hidden' : ''}>
      <div className="card" style={{ marginBottom: '14px' }}>
        <div className="me">
          <div className="av-lg">{Array.from(userEmail)[0]?.toUpperCase() || 'U'}</div>
          <div>
            <b>{userEmail}</b>
            <div style={{ fontSize: '13px', color: 'var(--teal)', fontWeight: 500, marginTop: '2px' }}>
              ✓ Firebase Cloud & WebSocket লাইভ সিঙ্ক সক্রিয়
            </div>
          </div>
        </div>
        <button
          className="ghost sm"
          style={{ width: '100%', marginTop: '14px', borderColor: 'var(--line)' }}
          onClick={handleLogout}
        >
          জিমেইল পরিবর্তন / লগআউট
        </button>
      </div>

      <div className="card">
        <h2 style={{ fontSize: '22px' }}>ব্যাকআপ</h2>
        <p className="mute" style={{ margin: '6px 0 0' }}>
          হিসাব আপনার জিমেইলে ও Firebase Firestore ক্লাউডে লাইভ সেভ থাকে।
        </p>
        <div className="btns">
          <button id="bkPdf" onClick={() => handleGeneratePdf()}>
            PDF রিপোর্ট
          </button>
          <button className="ghost" id="bkDl" onClick={handleBackupDownload}>
            ব্যাকআপ ডাউনলোড
          </button>
          <button className="ghost" id="bkRs" onClick={() => fileInputRef.current?.click()}>
            ফাইল থেকে ফিরিয়ে আনুন
          </button>
          <input
            ref={fileInputRef}
            id="restore"
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleRestoreFile}
          />
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontSize: '22px' }}>রিসাইকেল বিন</h2>
        <p className="mute" style={{ margin: '6px 0 0' }}>
          ডিলিট করা হিসাব ৩০ দিন এখানে থাকে। চাইলে ফিরিয়ে আনতে পারবেন।
        </p>
        <div id="binList">
          {activeBin.length ? (
            activeBin.map((b) => {
              const dd = Math.max(0, 30 - Math.floor((Date.now() - b.at) / 864e5));
              const info =
                b.kind === 'tx' && b.tx ? (
                  <>
                    <b>{b.tx.person}</b>
                    <small>
                      {b.tx.type === 'take' ? 'নিয়েছে' : 'ফেরত'} {money(b.tx.amount)} · {b.tx.date}
                      {b.tx.note ? ' · ' + b.tx.note : ''}
                    </small>
                  </>
                ) : (
                  <>
                    <b>{b.name} (কাস্টমার)</b>
                    <small>{bn(b.txs?.length || 0)}টি লেনদেনসহ</small>
                  </>
                );

              return (
                <div key={b.bid} className="r">
                  <div className="d">
                    {info}
                    <small>আর {bn(dd)} দিন থাকবে</small>
                  </div>
                  <button className="ghost sm" onClick={() => handleBinRestore(b)}>
                    ফিরিয়ে আনুন
                  </button>
                  <button className="danger sm" onClick={() => handleBinPermanentDelete(b.bid)}>
                    মুছুন
                  </button>
                </div>
              );
            })
          ) : (
            <div className="empty">বিন খালি</div>
          )}
        </div>
        {activeBin.length > 0 && (
          <button
            className="danger sm"
            id="binClear"
            style={{ marginTop: '12px' }}
            onClick={handleBinClear}
          >
            বিন খালি করুন
          </button>
        )}
      </div>
    </section>
  );

  return (
    <>
      <main id="app" className="wrap">
        {renderDashboard()}
        {renderEntry()}
        {renderSettings()}
      </main>

      <nav id="nav">
        <div>
          <button
            className={view === 'dash' ? 'on' : ''}
            onClick={() => {
              setView('dash');
              window.scrollTo(0, 0);
            }}
          >
            <svg viewBox="0 0 24 24">
              <rect x="3" y="3" width="7" height="9" rx="1.500" />
              <rect x="14" y="3" width="7" height="5" rx="1.500" />
              <rect x="14" y="12" width="7" height="9" rx="1.500" />
              <rect x="3" y="16" width="7" height="5" rx="1.500" />
            </svg>
            ড্যাশবোর্ড
          </button>
          <button
            className={view === 'entry' ? 'on' : ''}
            onClick={() => {
              setView('entry');
              window.scrollTo(0, 0);
            }}
          >
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v8M8 12h8" />
            </svg>
            এন্ট্রি
          </button>
          <button
            className={view === 'set' ? 'on' : ''}
            onClick={() => {
              setView('set');
              window.scrollTo(0, 0);
            }}
          >
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.400 15a1.700 1.700 0 0 0 .3 1.800l.1.100a2 2 0 1 1-2.800 2.800l-.1-.1a1.700 1.700 0 0 0-1.800-.3 1.700 1.700 0 0 0-1 1.500V21a2 2 0 1 1-4 0v-.1a1.700 1.700 0 0 0-1.100-1.500 1.700 1.700 0 0 0-1.800.3l-.1.100a2 2 0 1 1-2.800-2.800l.1-.1a1.700 1.700 0 0 0 .3-1.800 1.700 1.700 0 0 0-1.500-1H3a2 2 0 1 1 0-4h.1a1.700 1.700 0 0 0 1.500-1.100 1.700 1.700 0 0 0-.3-1.800l-.1-.1a2 2 0 1 1 2.800-2.800l.1.100a1.700 1.700 0 0 0 1.800.3H9a1.700 1.700 0 0 0 1-1.500V3a2 2 0 1 1 4 0v.1a1.700 1.700 0 0 0 1 1.500 1.700 1.700 0 0 0 1.800-.3l.1-.1a2 2 0 1 1 2.800 2.800l-.1.100a1.700 1.700 0 0 0-.3 1.800V9a1.700 1.700 0 0 0 1.500 1H21a2 2 0 1 1 0 4h-.1a1.700 1.700 0 0 0-1.500 1z" />
            </svg>
            সেটিং
          </button>
        </div>
      </nav>

      <div id="report" dangerouslySetInnerHTML={{ __html: reportHtml }} />
      <div id="toast" className={toastMsg ? 'on' : ''}>
        {toastMsg}
      </div>
    </>
  );
}
