import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  inMemoryPersistence,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
  Auth,
} from 'firebase/auth';
import {
  initializeFirestore,
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocFromServer,
  onSnapshot,
  Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

let dbInstance: Firestore;
try {
  dbInstance = initializeFirestore(
    app,
    {
      experimentalForceLongPolling: true,
      ignoreUndefinedProperties: true,
    },
    firebaseConfig.firestoreDatabaseId
  );
} catch {
  dbInstance = getFirestore(app, firebaseConfig.firestoreDatabaseId);
}
export const db = dbInstance;

let authInstance: Auth;
try {
  authInstance = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence],
  });
} catch {
  authInstance = getAuth(app);
}
export const auth = authInstance;

export const googleProvider = new GoogleAuthProvider();

export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

export { setDoc, doc, getDoc, onSnapshot, signInWithPopup, signOut, onAuthStateChanged };
export type { User };
