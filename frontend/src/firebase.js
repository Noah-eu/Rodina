import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth'
import { getStorage } from "firebase/storage"

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const hasFirebaseConfig = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.appId
)

export const app = hasFirebaseConfig ? initializeApp(firebaseConfig) : null
export const db = app ? getFirestore(app) : null
export const storage = app ? getStorage(app) : null
export const auth = app ? getAuth(app) : null

// Funkce, která vrací promise, jež se resolvne po dokončení úvodní autentizace
export const ensureAuth = !auth ? Promise.resolve(null) : new Promise(resolve => {
  const unsubscribe = onAuthStateChanged(auth, user => {
    if (user) {
      console.log('Firebase auth state: signed in anonymously', user.uid)
      resolve(user)
      unsubscribe()
    }
  })

  // Pokusíme se o anonymní přihlášení — pokud je v projektu povolené
  signInAnonymously(auth).catch(err => {
    // Pokud není povoleno, nahlásíme do konzole; aplikace může stále fungovat, pokud upravíte pravidla
    console.warn('Firebase anonymous sign-in failed:', err && err.message)
    // I v případě chyby "resolvneme", aby aplikace nezamrzla
    resolve(null) 
    unsubscribe()
  })
})
