import { initializeApp, getApps } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyCuCigFubiGOMHgka4L54gbKTX9PTVqrSo",
  authDomain: "b2-beruf.firebaseapp.com",
  databaseURL: "https://b2-beruf-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "b2-beruf",
  storageBucket: "b2-beruf.firebasestorage.app",
  messagingSenderId: "995920646513",
  appId: "1:995920646513:web:c5e0e4b8d695270906e6d0",
  measurementId: "G-XVX53GE94L"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getDatabase(app);
export default app;