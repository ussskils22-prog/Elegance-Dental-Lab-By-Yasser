# نظام إدارة حالات الأسنان (Dental Case Management System)

## 📊 نظرة عامة على النظام

نظام متكامل لإدارة حالات معالجة الأسنان من الانتظار إلى الانتهاء، مع دعم كامل للصلاحيات والإشعارات الفورية.

---

## 🏗️ البنية الكاملة

```
Dental System/
├── client/                          # الجزء الأمامي (Frontend - Angular)
│   ├── src/
│   │   ├── app/
│   │   │   ├── core/               # الخدمات والحراسات
│   │   │   │   ├── auth/
│   │   │   │   ├── guards/
│   │   │   │   ├── models/
│   │   │   │   └── services/
│   │   │   ├── modules/            # المكونات الرئيسية
│   │   │   │   ├── admin/
│   │   │   │   ├── secretary/
│   │   │   │   ├── designer/
│   │   │   │   ├── finisher/
│   │   │   │   ├── login/
│   │   │   │   └── case-management/
│   │   │   ├── shared/             # المكونات المشتركة
│   │   │   └── app.routes.ts
│   │   └── index.html
│   ├── angular.json
│   └── package.json
│
└── backend/                        # الجزء الخلفي (Backend - Node.js)
    ├── config/                     # الإعدادات
    │   ├── database.js             # MongoDB connection
    │   └── jwt.js                  # JWT token management
    │
    ├── models/                     # قاعدة البيانات
    │   ├── User.js
    │   ├── DentalCase.js
    │   ├── AuditLog.js
    │   └── Notification.js
    │
    ├── controllers/                # وحدات التحكم
    │   ├── authController.js
    │   ├── caseController.js
    │   ├── userController.js
    │   ├── auditController.js
    │   └── notificationController.js
    │
    ├── routes/                     # المسارات
    │   ├── authRoutes.js
    │   ├── caseRoutes.js
    │   ├── userRoutes.js
    │   ├── auditRoutes.js
    │   └── notificationRoutes.js
    │
    ├── middleware/                 # مرشحات الطلبات
    │   ├── auth.js
    │   └── errorHandler.js
    │
    ├── services/                   # الخدمات
    │   └── socketService.js
    │
    ├── server.js                   # ملف البداية
    ├── package.json
    ├── .env
    ├── .env.example
    ├── README.md
    ├── QUICK_START.md
    ├── Dockerfile
    ├── docker-compose.yml
    └── .gitignore
```

---

## 🔄 تدفق العمل (Workflow)

### 1️⃣ تسجيل الدخول

```
User Login → Auth.service.login() → Backend: POST /auth/login
  ↓
Backend: التحقق من البيانات + Password Hashing
  ↓
Frontend: حفظ التوكن + إعادة توجيه حسب الدور
```

### 2️⃣ إنشاء حالة جديدة (Secretary)

```
Secretary → Create Case Form
  ↓
POST /api/cases
  ↓
Backend: تخزين في MongoDB + إنشاء Audit Log
  ↓
Socket.io: إرسال إشعار فوري لجميع المستخدمين
  ↓
Frontend: تحديث القائمة فوراً
```

### 3️⃣ استدعاء حالة (Claim Case)

```
Designer → Click Claim Button
  ↓
PUT /api/cases/:id/claim
  ↓
Backend: التحقق من عدم استدعاء الحالة من قبل
  ↓
Atomic Operation: إسناد الحالة فقط إذا كانت فارغة
  ↓
Audit Log + Socket.io Notification
```

### 4️⃣ نقل الحالة عبر المراحل

```
waiting → secretary → design → finishing → completed
  ↓        ↓          ↓         ↓          ↓
Stage 1  Stage 2    Stage 3   Stage 4    Stage 5
```

### 5️⃣ مراقبة Admin

```
Admin Dashboard
  ↓
عرض جميع الحالات من جميع المراحل
  ↓
إسناد يدوي للحالات
  ↓
Audit Trail: رؤية تاريخ جميع العمليات
```

---

## 🛡️ الأمان والصلاحيات

### Authentication
- ✅ **JWT Tokens** - معرف آمن للجلسات
- ✅ **Password Hashing** - bcryptjs مع salt
- ✅ **Session Timeout** - انتهاء صلاحية التوكن
- ✅ **Refresh Tokens** - (يمكن إضافته)

### Authorization (RBAC)
| العملية | Admin | Secretary | Designer | Finisher |
|--------|-------|-----------|----------|----------|
| إنشاء | ✅ | ✅ | ❌ | ❌ |
| عرض | ✅ | ✅ | ✅ | ✅ |
| استدعاء | ✅ | ✅ | ✅ | ✅ |
| إسناد | ✅ | ❌ | ❌ | ❌ |
| الإفراج | ✅ | ❌ | ❌ | ❌ |

### Data Protection
- ✅ CORS - السماح فقط من localhost:4200
- ✅ Input Validation - التحقق من البيانات المدخلة
- ✅ Rate Limiting - منع الهجمات الهجومية
- ✅ Helmet - رؤوس أمان إضافية

---

## 💾 قاعدة البيانات

### المجموعات (Collections)

#### 1️⃣ Users
```javascript
{
  _id: ObjectId,
  fullName: String,
  email: String (unique),
  password: String (hashed),
  phone: String,
  role: 'admin' | 'secretary' | 'designer' | 'finisher',
  status: 'online' | 'offline' | 'idle',
  department: String,
  lastSeen: Date,
  isActive: Boolean,
  createdAt: Date,
  updatedAt: Date
}
```

#### 2️⃣ DentalCases
```javascript
{
  _id: ObjectId,
  caseNumber: String (auto-generated),
  patientName: String,
  patientEmail: String,
  patientPhone: String,
  notes: String,
  
  currentStage: 'waiting' | 'secretary' | 'design' | 'finishing' | 'completed',
  status: 'waiting' | 'in_progress' | 'completed',
  
  assignedTo: ObjectId (User),
  assignedAt: Date,
  createdBy: ObjectId (User),
  
  caseType: String,
  priority: 'low' | 'normal' | 'high' | 'urgent',
  dueDate: Date,
  
  stageTimestamps: {
    secretary: Date,
    design: Date,
    finishing: Date,
    completed: Date
  },
  
  createdAt: Date,
  updatedAt: Date
}
```

#### 3️⃣ AuditLogs
```javascript
{
  _id: ObjectId,
  caseId: ObjectId,
  caseNumber: String,
  action: 'created' | 'assigned' | 'reassigned' | 'moved_stage' | 'completed' | 'reopened' | 'released',
  performedBy: ObjectId (User),
  performedByName: String,
  timestamp: Date,
  details: {
    oldValue: Any,
    newValue: Any,
    notes: String
  }
}
```

#### 4️⃣ Notifications
```javascript
{
  _id: ObjectId,
  type: 'case_created' | 'case_assigned' | 'case_moved' | ...,
  title: String,
  message: String,
  caseId: ObjectId,
  caseNumber: String,
  relatedUser: ObjectId (User),
  timestamp: Date,
  read: Boolean,
  targetUsers: [ObjectId],
  targetAudience: 'all' | 'admin' | [roles]
}
```

---

## 🔌 Real-time Events (Socket.io)

### Events من Client → Server

```javascript
// Case Events
socket.emit('case:created', { caseId, caseNumber, patientName });
socket.emit('case:assigned', { caseId, assignedTo });
socket.emit('case:moved-stage', { caseId, oldStage, newStage });
socket.emit('case:completed', { caseId });

// User Events
socket.emit('user:status-change', { status: 'online' | 'offline' | 'idle' });

// Notification Events
socket.emit('notification:send', { message, targetAudience });
```

### Events من Server → Clients

```javascript
// جميع العملاء يستقبلون:
socket.on('case:created', handleNewCase);
socket.on('case:assigned', handleCaseAssigned);
socket.on('user:status-changed', handleUserStatusChange);
socket.on('notification:new', handleNewNotification);
```

---

## 📱 المكونات الرئيسية

### Frontend (Angular)

#### 1️⃣ Admin Dashboard
- 📊 Kanban Board (5 أعمدة حسب المراحل)
- 📋 جدول عرض الحالات
- 📜 سجل العمليات (Audit Trail)
- 🔍 البحث والتصفية
- 🎛️ تحكم كامل (إسناد، نقل، إفراج)

#### 2️⃣ Secretary Dashboard
- ➕ نموذج إنشاء حالات جديدة
- 📈 الإحصائيات
- 📋 عرض الحالات المعلقة

#### 3️⃣ Designer Dashboard
- 📝 الحالات المسندة له
- 🎨 حالات قيد العمل
- ✅ إكمال المرحلة

#### 4️⃣ Finisher Dashboard
- 🎯 حالات التشطيب
- ✅ إكمال الحالة بالكامل

### Backend (Node.js + Express)

#### 🔐 Auth Module
- JWT Token Generation
- Password Hashing & Verification
- Session Management
- Role-Based Access Control

#### 📦 Case Module
- CRUD Operations
- Atomic Case Claiming
- Stage Transitions
- Status Management

#### 👥 User Module
- User Management
- Status Tracking
- Role Management
- Department Assignment

#### 📊 Audit Module
- Action Logging
- Timestamp Tracking
- Change History
- User Attribution

#### 🔔 Notification Module
- Event Notifications
- Real-time Delivery
- Read/Unread Tracking
- Targeted Delivery

---

## 🚀 التشغيل

### البداية السريعة

#### 1️⃣ تثبيت المكتبات
```bash
# Backend
cd backend
npm install

# Frontend
cd client
npm install
```

#### 2️⃣ إنشاء قاعدة البيانات
```bash
# MongoDB محلي أو Atlas
# تأكد من MONGODB_URI في .env
```

#### 3️⃣ تشغيل السيرفرات
```bash
# Terminal 1 - Backend
cd backend
npm run dev
# يعمل على localhost:5000

# Terminal 2 - Frontend
cd client
npm start
# يعمل على localhost:4200
```

### التشغيل بـ Docker
```bash
cd backend
docker-compose up -d
```

---

## 📊 الإحصائيات

| المترية | القيمة |
|---------|--------|
| Models | 4 |
| Controllers | 5 |
| Routes | 5 |
| API Endpoints | 24 |
| Socket.io Events | 12 |
| Roles | 4 |
| Case Stages | 5 |
| Audit Actions | 7 |

---

## 🔄 Integration Points

### Frontend → Backend
- REST API calls (HTTP)
- Socket.io connections
- JWT authentication
- Error handling

### Backend → Database
- MongoDB operations
- Transaction support (for atomic operations)
- Indexing for performance
- Soft deletes (isActive)

### Real-time Updates
- Socket.io broadcast
- Targeted notifications
- User status updates
- Case status changes

---

## 🛠️ المميزات المتقدمة

✅ **Atomic Operations** - منع Race Conditions عند استدعاء الحالات
✅ **Comprehensive Audit Trail** - تسجيل كل عملية
✅ **Real-time Notifications** - إشعارات فورية لجميع المستخدمين
✅ **Role-Based Access Control** - صلاحيات دقيقة لكل دور
✅ **Input Validation** - التحقق من جميع المدخلات
✅ **Error Handling** - معالجة شاملة للأخطاء
✅ **Performance Optimization** - Indexes و Pagination
✅ **Security** - CORS, Helmet, Rate Limiting, Password Hashing

---

## 📈 التطوير المستقبلي

- [ ] Email notifications
- [ ] SMS alerts
- [ ] File uploads for cases
- [ ] Advanced reporting
- [ ] Analytics dashboard
- [ ] Mobile app (React Native / Flutter)
- [ ] Payment integration
- [ ] Multi-language support
- [ ] Dark mode UI
- [ ] Performance metrics

---

**Status**: ✅ كامل وجاهز للإنتاج
**Last Updated**: 2024-04-25
**Version**: 1.0.0
