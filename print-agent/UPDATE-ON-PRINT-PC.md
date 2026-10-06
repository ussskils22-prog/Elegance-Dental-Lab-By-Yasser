# Print Agent على لابتوب الطباعة

الطباعة الصامتة **لازم** تشتغل من جهاز مربوط بالطابعة. السحابة (Vercel / Railway) بتحط الـ job في الطابور؛ الايجنت هو اللي يطبع.

## التشغيل الدائم (موصى به) — خدمة ويندوز

مرة واحدة كـ **Administrator** على جهاز الطباعة:

1. حدّث ملفات `print-agent` (خاصة `agent.js` و `config.json`).
2. تأكد من `config.json`:
   - `SERVER_URL` = عنوان Railway (مثل `…-da7c.up.railway.app`)
   - `PRINT_AGENT_SECRET` = نفس قيمة Railway env
   - `PRINTER_NAME` = اسم الطابعة في ويندوز (مثل `POSPrinter POS80`)
3. من مجلد `print-agent`:
   ```bat
   npm install
   npm run install-service
   ```
   أو شغّل `install-as-service.bat` كـ Administrator.
4. افتح `services.msc` → ابحث عن **ElegancePrintAgent** → Status = Running، Startup = Automatic.

بعد كده مفيش فتح ترمينال يوميًا: الخدمة تشتغل مع الجهاز وتعيد التشغيل لو وقعت.

إلغاء التثبيت:

```bat
npm run uninstall-service
```

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
