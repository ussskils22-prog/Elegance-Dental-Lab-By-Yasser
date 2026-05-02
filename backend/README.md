# Dental Case Management System - Backend

نظام إدارة حالات الأسنان - الجزء الخادم

## المميزات الرئيسية

✅ **Authentication & Authorization** - JWT-based authentication مع Role-Based Access Control
✅ **Case Management** - إنشاء وإدارة ومراقبة حالات الأسنان
✅ **User Management** - إدارة الموظفين والأدوار
✅ **Audit Logging** - تسجيل شامل لجميع العمليات
✅ **Real-time Notifications** - إشعارات فورية بـ Socket.io
✅ **Multi-role Support** - Admin, Secretary, Designer, Finisher

## تنصيب (Installation)

### المتطلبات

- Node.js (v14 أو أعلى)
- MongoDB (محلي أو قاعدة بيانات بعيدة)
- npm أو yarn

### الخطوات

1. **تثبيت المكتبات**
```bash
npm install
```

2. **إنشاء ملف .env**
```bash
cp .env.example .env
```

3. **تعديل متغيرات البيئة**
```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/dental-system
JWT_SECRET=your_secret_key
CORS_ORIGIN=http://localhost:4200
```

4. **تشغيل السيرفر**
```bash
# Development mode (with nodemon)
npm run dev

# Production mode
npm start
```

السيرفر سيعمل على `http://localhost:5000`

## هيكل المشروع

```
backend/
├── config/
│   ├── database.js       # MongoDB connection
│   └── jwt.js            # JWT token generation & verification
├── models/
│   ├── User.js          # User model
│   ├── DentalCase.js    # Case model
│   ├── AuditLog.js      # Audit log model
│   └── Notification.js  # Notification model
├── controllers/
│   ├── authController.js
│   ├── caseController.js
│   ├── userController.js
│   ├── auditController.js
│   └── notificationController.js
├── routes/
│   ├── authRoutes.js
│   ├── caseRoutes.js
│   ├── userRoutes.js
│   ├── auditRoutes.js
│   └── notificationRoutes.js
├── middleware/
│   ├── auth.js          # JWT verification & role check
│   └── errorHandler.js
├── services/
│   └── socketService.js # Socket.io setup
├── server.js            # Main server file
├── .env                 # Environment variables
└── package.json
```

## API Documentation

### Authentication Endpoints

#### تسجيل الدخول
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}

Response:
{
  "success": true,
  "token": "eyJhbGc...",
  "user": {
    "id": "...",
    "fullName": "...",
    "email": "...",
    "role": "admin"
  }
}
```

#### تسجيل مستخدم جديد (Admin فقط)
```http
POST /api/auth/register
Authorization: Bearer {token}
Content-Type: application/json

{
  "fullName": "John Doe",
  "email": "john@example.com",
  "phone": "123456789",
  "password": "password123",
  "role": "secretary",
  "department": "Clinic"
}
```

#### الخروج
```http
POST /api/auth/logout
Authorization: Bearer {token}
```

#### الحصول على بيانات المستخدم الحالي
```http
GET /api/auth/me
Authorization: Bearer {token}
```

### Case Management Endpoints

#### إنشاء حالة جديدة
```http
POST /api/cases
Authorization: Bearer {token}
Content-Type: application/json

{
  "patientName": "أحمد محمد",
  "patientEmail": "ahmed@example.com",
  "patientPhone": "0123456789",
  "caseType": "تسوس",
  "priority": "high",
  "dueDate": "2024-12-31",
  "notes": "ملاحظات عن الحالة"
}
```

#### الحصول على جميع الحالات
```http
GET /api/cases?page=1&limit=10&stage=waiting&priority=high&search=text
Authorization: Bearer {token}

Query Parameters:
- page: رقم الصفحة (افتراضي: 1)
- limit: عدد السجلات (افتراضي: 10)
- stage: مرحلة الحالة (waiting, secretary, design, finishing, completed)
- status: حالة الحالة (waiting, in_progress, completed)
- priority: الأولوية (low, normal, high, urgent)
- search: بحث بالاسم أو رقم الحالة أو البريد الإلكتروني
```

#### الحصول على تفاصيل حالة
```http
GET /api/cases/:id
Authorization: Bearer {token}
```

#### استدعاء حالة (Atomic)
```http
PUT /api/cases/:id/claim
Authorization: Bearer {token}
```

#### إسناد حالة (Admin فقط)
```http
PUT /api/cases/:id/assign
Authorization: Bearer {token}
Content-Type: application/json

{
  "userId": "user_id"
}
```

#### نقل الحالة إلى مرحلة أخرى
```http
PUT /api/cases/:id/move-stage
Authorization: Bearer {token}
Content-Type: application/json

{
  "stage": "design"
}
```

#### إكمال الحالة
```http
PUT /api/cases/:id/complete
Authorization: Bearer {token}
```

#### إفراج عن الحالة (Admin فقط)
```http
PUT /api/cases/:id/release
Authorization: Bearer {token}
```

#### إعادة فتح الحالة (Admin فقط)
```http
PUT /api/cases/:id/reopen
Authorization: Bearer {token}
```

### User Management Endpoints

#### الحصول على جميع المستخدمين (Admin فقط)
```http
GET /api/users?role=secretary&status=online
Authorization: Bearer {token}

Query Parameters:
- role: الدور (admin, secretary, designer, finisher)
- status: الحالة (online, offline, idle)
```

#### الحصول على مستخدمين بدور معين
```http
GET /api/users/role/:role
Authorization: Bearer {token}
```

#### الحصول على بيانات مستخدم
```http
GET /api/users/:id
Authorization: Bearer {token}
```

#### تحديث بيانات مستخدم
```http
PUT /api/users/:id
Authorization: Bearer {token}
Content-Type: application/json

{
  "fullName": "New Name",
  "phone": "0987654321",
  "department": "New Department",
  "role": "designer"  // Admin فقط
}
```

#### تحديث حالة المستخدم
```http
PUT /api/users/:id/status
Authorization: Bearer {token}
Content-Type: application/json

{
  "status": "online"  // online, offline, idle
}
```

#### حذف مستخدم (Admin فقط)
```http
DELETE /api/users/:id
Authorization: Bearer {token}
```

### Audit Logging Endpoints

#### الحصول على سجلات العمليات (Admin فقط)
```http
GET /api/audit-logs?page=1&limit=20&caseId=&action=created&userId=
Authorization: Bearer {token}

Query Parameters:
- page: رقم الصفحة
- limit: عدد السجلات
- caseId: معرف الحالة
- action: نوع العملية
- userId: معرف المستخدم
```

#### الحصول على سجلات حالة معينة (Admin فقط)
```http
GET /api/audit-logs/case/:caseId?page=1&limit=50
Authorization: Bearer {token}
```

### Notification Endpoints

#### الحصول على التنبيهات
```http
GET /api/notifications?page=1&limit=20&read=false
Authorization: Bearer {token}

Query Parameters:
- page: رقم الصفحة
- limit: عدد السجلات
- read: true/false
```

#### عدد التنبيهات غير المقروءة
```http
GET /api/notifications/unread/count
Authorization: Bearer {token}
```

#### وضع علامة على التنبيه كمقروء
```http
PUT /api/notifications/:notificationId/read
Authorization: Bearer {token}
```

#### وضع علامة على جميع التنبيهات كمقروءة
```http
PUT /api/notifications/read/all
Authorization: Bearer {token}
```

#### حذف تنبيه
```http
DELETE /api/notifications/:notificationId
Authorization: Bearer {token}
```

## Socket.io Events

### Real-time Events

#### من الـ Client إلى الـ Server

**Case Events:**
- `case:created` - إرسال عند إنشاء حالة جديدة
- `case:assigned` - إرسال عند إسناد حالة
- `case:reassigned` - إرسال عند إعادة إسناد حالة
- `case:moved-stage` - إرسال عند نقل الحالة لمرحلة جديدة
- `case:completed` - إرسال عند إكمال الحالة
- `case:released` - إرسال عند إفراج عن الحالة

**User Events:**
- `user:status-change` - تحديث حالة المستخدم

**Notification Events:**
- `notification:send` - إرسال تنبيه جديد

#### من الـ Server إلى جميع الـ Clients

**Case Events:**
- `case:created` - حالة جديدة تم إنشاؤها
- `case:assigned` - حالة تم إسنادها
- `case:reassigned` - حالة تم إعادة إسنادها
- `case:moved-stage` - حالة تم نقلها لمرحلة
- `case:completed` - حالة تم إكمالها
- `case:released` - حالة تم إفراج عنها

**User Events:**
- `user:status-changed` - تغيير حالة المستخدم

**Notification Events:**
- `notification:new` - تنبيه جديد

## Authentication

جميع الـ endpoints (ماعدا `/auth/login`) تتطلب توكن JWT.

يجب إرسال التوكن في الـ header:
```
Authorization: Bearer {token}
```

## الأدوار والصلاحيات (Roles & Permissions)

| العملية | Admin | Secretary | Designer | Finisher |
|--------|-------|-----------|----------|----------|
| إنشاء حالة | ✅ | ✅ | ❌ | ❌ |
| عرض جميع الحالات | ✅ | ✅ | ✅ | ✅ |
| استدعاء حالة | ✅ | ✅ | ✅ | ✅ |
| إسناد حالة | ✅ | ❌ | ❌ | ❌ |
| نقل المرحلة | ✅ | ✅ | ✅ | ✅ |
| إكمال الحالة | ✅ | ✅ | ✅ | ✅ |
| إفراج عن الحالة | ✅ | ❌ | ❌ | ❌ |
| إعادة فتح الحالة | ✅ | ❌ | ❌ | ❌ |
| عرض سجلات العمليات | ✅ | ❌ | ❌ | ❌ |
| إنشاء مستخدمين | ✅ | ❌ | ❌ | ❌ |

## معالجة الأخطاء

جميع الـ responses تحتوي على حقل `success`:

```json
{
  "success": true/false,
  "message": "...",
  "data": {...},
  "error": "..."
}
```

## الأداء والأمان

- ✅ Password hashing بـ bcryptjs
- ✅ JWT token authentication
- ✅ Role-based access control
- ✅ Input validation و sanitization
- ✅ CORS protection
- ✅ Helmet security headers
- ✅ Rate limiting
- ✅ Comprehensive error handling
- ✅ Database indexes على الحقول الهامة

## التطوير

### إضافة ميزة جديدة

1. أنشئ model جديد في `models/`
2. أنشئ controller في `controllers/`
3. أنشئ routes في `routes/`
4. أضف الـ routes إلى `server.js`

### Test

```bash
npm test
```

## Deployment

### على Heroku

```bash
git init
git add .
git commit -m "Initial commit"
heroku create
git push heroku main
```

### على DigitalOcean / AWS / Azure

1. انسخ الملفات إلى السيرفر
2. ثبت Node.js و MongoDB
3. شغل `npm install`
4. استخدم process manager مثل PM2

```bash
npm install -g pm2
pm2 start server.js
pm2 save
```

## الترخيص

ISC

## التواصل

للمساعدة والأسئلة، تواصل مع فريق التطوير.
