# Admin Demo — بيئة منفصلة (Uni Shop)

ديمو كامل للأدمن/السكرتارية/الدكاترة على **داتا وهمية فقط**.  
لينك الديمو ≠ الإنتاج. ممنوع ربط نفس `MONGODB_URI` بتاع المعمل.

## حساب الدخول (بعد الـ seed)

| الدور | الإيميل | الباسورد |
|--------|---------|----------|
| **Admin Demo** | `demo-admin@unishop.local` | `Demo@UniShop2026` |
| سكرتارية | `demo-secretary@unishop.local` | `Demo@123456` |
| ديزاين | `demo-designer@unishop.local` | `Demo@123456` |
| فينيش | `demo-finisher@unishop.local` | `Demo@123456` |
| دكتور | `demo-doctor1@unishop.local` | `Demo@123456` (PIN `1234`) |

## ١) Mongo فاضي للديمو

أنشئ قاعدة Mongo جديدة (Atlas أو Railway Mongo).  
**لا تستخدم** connection string بتاع الإنتاج.

## ٢) Railway — خدمة Backend للديمو

1. New Service من نفس الريبو (root = `backend` زي الإنتاج).
2. Environment:

```env
DEMO_MODE=true
MONGODB_URI=<demo-mongo-uri>
JWT_SECRET=<random-string-different-from-prod>
PRINT_AGENT_SECRET=demo-print-secret-not-prod
CORS_ORIGIN=https://elegance-demo.vercel.app
DEMO_FRONTEND_URL=https://elegance-demo.vercel.app
NODE_ENV=production
PORT=5000
```

3. بعد أول deploy، شغّل الـ seed مرة (Railway shell أو من جهازك):

```bash
cd backend
DEMO_MODE=true MONGODB_URI="<demo-mongo-uri>" npm run seed:demo
```

بدون `DEMO_MODE=true` السكربت **يرفض** التشغيل.

4. انسخ URL الخدمة (مثال: `https://elegance-demo-api.up.railway.app`).

## ٣) حدّث الـ URL في الكود قبل Deploy الفرونت

ضع رابط Railway الديمو الحقيقي في:

- [`client/src/app/core/api/api.config.ts`](../client/src/app/core/api/api.config.ts) → `DEMO_RAILWAY_API`
- [`client/vercel.demo.json`](../client/vercel.demo.json) → `rewrites[0].destination`
- اختياري: أضف hostname الديمو في `DEMO_HOSTS` داخل `api.config.ts`

## ٤) Vercel — مشروع Frontend للديمو

1. مشروع Vercel منفصل (أو نفس الريبو بـ Root Directory = `client`).
2. قبل البناء: انسخ إعدادات الديمو:

```bash
cd client
copy vercel.demo.json vercel.json
```

(على Mac/Linux: `cp vercel.demo.json vercel.json`)

3. Domain مقترح: `elegance-demo.vercel.app` (أو أي اسم فيه `demo` على `.vercel.app` — الـ client يوجّه تلقائيًا لـ API الديمو).
4. Deploy.

## ٥) سلّم للدكتور

1. افتح لينك الديمو.
2. لازم يظهر شريط برتقالي: **وضع تجريبي — بيانات وهمية**.
3. ادخل بـ `demo-admin@unishop.local` / `Demo@UniShop2026`.
4. يتفرج على الأدمن، السكرتارية، حسابات الدكاترة، طلب مندوب، إلخ.

## إعادة تصفير الديمو

```bash
DEMO_MODE=true MONGODB_URI="<demo-mongo-uri>" npm run seed:demo
```

يمسح Collections الديمو ويعيد تعبئتها.

## قواعد أمان

- ممنوع نفس `JWT_SECRET` أو `PRINT_AGENT_SECRET` أو `MONGODB_URI` بتاع الإنتاج.
- Print Agent بتاع المعمل ما يتوصلش لـ API الديمو (secret مختلف).
- WhatsApp: سيبه مطفي على خدمة الديمو.

## التحقق السريع

```bash
curl https://<demo-railway>/api/health
```

المتوقع: `"demoMode": true`
