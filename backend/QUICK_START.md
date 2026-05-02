# تعليمات التشغيل السريعة - Quick Start Guide

## 1️⃣ التثبيت السريع

### Windows

```bash
# افتح PowerShell أو Command Prompt

# تأكد من وجود Node.js
node --version

# انتقل إلى مجلد المشروع
cd "c:\Users\ysrym\Desktop\dental system\backend"

# ثبت المكتبات
npm install
```

### macOS / Linux

```bash
cd ~/dental-system/backend
npm install
```

## 2️⃣ إعداد قاعدة البيانات

### الطريقة 1️⃣: MongoDB محلي

#### Windows:
1. حمل MongoDB من: https://www.mongodb.com/try/download/community
2. ثبتها واتبع التعليمات
3. تأكد من تشغيل الـ MongoDB service
4. قم بتشغيل `mongod` من Command Prompt

#### macOS (مع Homebrew):
```bash
brew tap mongodb/brew
brew install mongodb-community
brew services start mongodb-community
```

#### Linux:
```bash
sudo apt-get install mongodb
sudo systemctl start mongodb
```

### الطريقة 2️⃣: MongoDB Atlas (Cloud)

1. اذهب إلى: https://www.mongodb.com/cloud/atlas
2. أنشئ حساب مجاني
3. أنشئ Cluster جديد
4. انسخ connection string
5. ضعها في `.env`:
```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/dental-system
```

## 3️⃣ تشغيل السيرفر

### Development (مع Auto-reload):
```bash
npm run dev
```

### Production:
```bash
npm start
```

### النتيجة المتوقعة:
```
╔════════════════════════════════════════╗
║   Dental System Backend Server Ready   ║
╠════════════════════════════════════════╣
║   Port: 5000                           
║   Environment: development
║   Database: MongoDB
║   Socket.io: Enabled
╚════════════════════════════════════════╝

MongoDB Connected: localhost
```

## 4️⃣ اختبار الـ API

### استخدام Postman / Insomnia

#### 1. تسجيل الدخول
```
POST http://localhost:5000/api/auth/login
Content-Type: application/json

{
  "email": "admin@example.com",
  "password": "password123"
}
```

**ملاحظة:** ستحتاج لإنشاء مستخدم أولاً في قاعدة البيانات

### استخدام cURL

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "password123"
  }'
```

### اختبار الـ Health Check

```bash
curl http://localhost:5000/health
```

## 5️⃣ إنشاء بيانات تجريبية (Seed Data)

### إنشاء Admin مثال

استخدم MongoDB Compass أو Shell:

```javascript
db.users.insertOne({
  fullName: "Admin User",
  email: "admin@example.com",
  phone: "0123456789",
  password: "$2a$10$...", // hashed password
  role: "admin",
  status: "online",
  department: "Administration",
  isActive: true
})
```

**أو** استخدم Postman لـ POST إلى `/api/auth/register` (بعد تسجيل دخول)

## 6️⃣ اتصال الـ Frontend

### في Angular App

تحديث environment.ts:
```typescript
export const environment = {
  apiUrl: 'http://localhost:5000/api',
  socketUrl: 'http://localhost:5000'
};
```

### في الـ Services

```typescript
constructor(private http: HttpClient) {
  this.apiUrl = environment.apiUrl;
}

login(email: string, password: string) {
  return this.http.post(`${this.apiUrl}/auth/login`, {
    email,
    password
  });
}
```

## 7️⃣ استكشاف الأخطاء

### ❌ خطأ: "Cannot find module"

```bash
# حل:
rm -rf node_modules
npm install
```

### ❌ خطأ: "MongoDB Connection Failed"

```bash
# تحقق من:
# 1. هل MongoDB يعمل؟
# 2. هل الـ MONGODB_URI صحيح في .env؟
# 3. هل firewall يسمح بالاتصال؟
```

### ❌ خطأ: "Port 5000 is already in use"

```bash
# اقتل العملية:
# Windows:
netstat -ano | findstr :5000
taskkill /PID {PID} /F

# macOS/Linux:
lsof -i :5000
kill -9 {PID}
```

### ❌ خطأ: CORS

```bash
# تحقق من .env:
CORS_ORIGIN=http://localhost:4200
```

## 8️⃣ الملفات المهمة

```
backend/
├── .env                 ← متغيرات البيئة (سري)
├── server.js            ← نقطة البداية
├── package.json         ← المكتبات
├── README.md            ← التوثيق الكامل
├── models/              ← قاعدة البيانات
├── controllers/         ← منطق التطبيق
├── routes/              ← المسارات
└── middleware/          ← مرشحات الطلبات
```

## 9️⃣ الخطوات التالية

- [ ] اتصال الـ Frontend مع Backend
- [ ] اختبار الـ Socket.io (Real-time)
- [ ] إنشاء Data Seed Script
- [ ] Testing (Jest)
- [ ] Deployment على الـ Cloud

## 🔟 موارد إضافية

- [Express Documentation](https://expressjs.com/)
- [MongoDB Documentation](https://docs.mongodb.com/)
- [Socket.io Documentation](https://socket.io/docs/)
- [JWT Authentication](https://jwt.io/)

---

**نجاح التشغيل؟** 🎉

تواصل مع فريق التطوير إذا واجهت مشكلة!
