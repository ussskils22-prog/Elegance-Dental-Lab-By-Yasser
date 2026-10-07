# Print Agent على لابتوب الطباعة

الطباعة الصامتة **لازم** تشتغل من جهاز مربوط بالطابعة. السحابة (Vercel / Railway) بتحط الـ job في الطابور؛ الايجنت هو اللي يطبع.

## التشغيل الدائم في الخلفية (موصى به) — من غير فتح نافذة

طابعات **USB** (مثل HP P1102) **ما بتطبعش** من خدمة `LocalSystem`. الحل: Task Scheduler بحساب المستخدم، يشتغل **مخفي** عند الـ login.

مرة واحدة: كليك يمين على **`install-background.bat`** → **Run as administrator**.

بعد كده:
- مفيش نافذة تفتح يوميًا
- الايجنت يشتغل لوحده بعد ما تسجّل دخول ويندوز
- اللوجات: `daemon\user-agent.out.log` و `daemon\agent-live.log`

`config.json` لازم فيه:
- `SERVER_URL` = Railway
- `PRINT_AGENT_SECRET` = نفس env السيرفر
- `PRINTER_NAME` = `HP LaserJet Professional P1102`

> **متستخدمش** `install-as-service.bat` — ده LocalSystem وبيكسر طباعة الـ USB.

## تشغيل يدوي (اختبار فقط)

```bat
cd print-agent
node agent.js
```

## تحديث الشيت / الـ agent

1. انسخ `agent.js` (وأي ملفات تانية اتغيرت) مكان القديم.
2. أعد تشغيل الخدمة من `services.msc` (Restart) — أو لو شغال يدوي: أوقف وأعد `node agent.js`.
3. اطبع ريكويست جديد للتأكد.

**مهم:** Vercel وحده مش بيحدّث الـ agent على جهاز الطباعة.
