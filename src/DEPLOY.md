# 🚀 دليل رفع المشروع على Vercel / Netlify

## المتطلبات الأساسية
- Node.js 18+ مثبت على جهازك
- حساب على [Vercel](https://vercel.com) أو [Netlify](https://netlify.com)
- Firebase Realtime Database مُفعّل (للـ Multiplayer)

---

## الخطوة 1 — إعداد المشروع محلياً

```bash
# إنشاء مشروع Vite جديد (إذا لم يكن لديك مشروع بعد)
npm create vite@latest b2-beruf-app -- --template react
cd b2-beruf-app

# تثبيت Firebase
npm install firebase

# انسخ ملفات مشروعك إلى مجلد src/
# src/App.jsx
# src/ChallengeRoom.jsx
# src/firebase-config.js
# src/questions.json
```

---

## الخطوة 2 — إعداد Firebase

1. افتح https://console.firebase.google.com
2. أنشئ مشروعاً جديداً
3. من القائمة الجانبية: **Build → Realtime Database → Create Database**
   - اختر أقرب منطقة جغرافية (europe-west1 للأوروبا)
   - ابدأ بـ **Test Mode** (تصلح لمدة 30 يوماً، عدّلها لاحقاً)
4. من **Project Settings → Your apps → Add app → Web**
   - انسخ الـ `firebaseConfig` والصقها في `src/firebase-config.js`

---

## الخطوة 3 — تجربة محلية

```bash
npm run dev
# افتح http://localhost:5173
```

---

## الخطوة 4أ — الرفع على Vercel (الأسهل والأسرع)

```bash
# تثبيت Vercel CLI
npm install -g vercel

# تسجيل الدخول
vercel login

# رفع المشروع (من داخل مجلد المشروع)
vercel

# للرفع على production
vercel --prod
```

ستحصل على رابط مثل: `https://b2-beruf-app.vercel.app`

### ملاحظة مهمة لـ Vercel:
أضف ملف `vercel.json` في جذر المشروع:
```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

---

## الخطوة 4ب — الرفع على Netlify

```bash
# بناء المشروع أولاً
npm run build

# تثبيت Netlify CLI
npm install -g netlify-cli

# تسجيل الدخول
netlify login

# رفع المشروع
netlify deploy --prod --dir=dist
```

### ملاحظة مهمة لـ Netlify:
أضف ملف `public/_redirects` يحتوي على:
```
/*    /index.html   200
```

---

## الخطوة 5 — تأمين Firebase (مهم قبل النشر للطلاب)

في Firebase Console → Realtime Database → Rules، غيّر القواعد إلى:

```json
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": true,
        ".write": true,
        ".indexOn": ["status"]
      }
    }
  }
}
```

> ⚠️ هذه القواعد تصلح لبيئة التعلم. في الإنتاج الكامل أضف مصادقة (Authentication).

---

## ملخص الأوامر السريعة

```bash
# تثبيت
npm install firebase

# تطوير
npm run dev

# بناء للنشر
npm run build

# نشر على Vercel
vercel --prod

# نشر على Netlify
netlify deploy --prod --dir=dist
```

---

## هيكل الملفات النهائي

```
b2-beruf-app/
├── src/
│   ├── App.jsx              ← الشاشة الرئيسية
│   ├── ChallengeRoom.jsx    ← غرفة التدريب
│   ├── firebase-config.js   ← إعدادات Firebase ← ضع بياناتك هنا
│   ├── questions.json       ← بنك الأسئلة
│   └── main.jsx             ← نقطة الدخول
├── public/
│   └── _redirects           ← لـ Netlify فقط
├── vercel.json              ← لـ Vercel فقط
├── package.json
└── vite.config.js
```
