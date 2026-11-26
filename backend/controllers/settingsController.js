const AppSettings = require('../models/AppSettings');
const {
  sendWhatsAppText,
  sendDailyReadySummaries,
  reloadWhatsAppConfig,
  providerConfigured,
} = require('../services/whatsappService');
const {
  startWhatsAppWeb,
  stopWhatsAppWeb,
  getPublicStatus,
} = require('../services/waWebService');
const {
  getOrCreateLabSettings,
  ensureDefaultMaterials,
  buildDefaultPricesFromMaterials,
} = require('../services/labConfigService');
const { setWorkflowConfig } = require('../services/caseWorkflowService');
const Material = require('../models/Material');

async function getOrCreateSettings() {
  return getOrCreateLabSettings();
}

function publicBrandingFrom(doc) {
  const branding = doc.branding || {};
  const labName =
    branding.labName ||
    doc.whatsapp?.labName ||
    'OCCLA Dental Lab';
  return {
    labName,
    logoUrl: branding.logoUrl || '',
    primaryColor: branding.primaryColor || '#2563eb',
  };
}

/** Public branding for login / white-label (no auth). */
exports.getPublicLabSettings = async (_req, res) => {
  try {
    const doc = await getOrCreateLabSettings();
    return res.json({
      success: true,
      branding: publicBrandingFrom(doc),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** Authenticated: branding + workflow + default prices + materials summary. */
exports.getLabSettings = async (_req, res) => {
  try {
    await ensureDefaultMaterials();
    const doc = await getOrCreateLabSettings();
    const materials = await Material.find({ active: true }).sort({ sortOrder: 1 }).lean();
    const defaultPrices = await buildDefaultPricesFromMaterials();
    setWorkflowConfig(doc.workflow);
    return res.json({
      success: true,
      branding: publicBrandingFrom(doc),
      workflow: {
        enabledStages: doc.workflow?.enabledStages || AppSettings.ALL_STAGES,
        allowSkipSecretary: doc.workflow?.allowSkipSecretary !== false,
        allowSkipKhart: doc.workflow?.allowSkipKhart !== false,
        allStages: AppSettings.ALL_STAGES,
      },
      defaultPrices,
      materials,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateLabSettings = async (req, res) => {
  try {
    const body = req.body || {};
    const doc = await getOrCreateLabSettings();

    if (body.branding && typeof body.branding === 'object') {
      if (!doc.branding) doc.branding = {};
      if (body.branding.labName !== undefined) {
        const name = String(body.branding.labName || '').trim();
        doc.branding.labName = name || doc.branding.labName || 'OCCLA Dental Lab';
        if (doc.whatsapp) doc.whatsapp.labName = doc.branding.labName;
      }
      if (body.branding.logoUrl !== undefined) {
        doc.branding.logoUrl = String(body.branding.logoUrl || '').trim();
      }
      if (body.branding.primaryColor !== undefined) {
        doc.branding.primaryColor = String(body.branding.primaryColor || '').trim() || '#2563eb';
      }
    }

    if (body.workflow && typeof body.workflow === 'object') {
      if (!doc.workflow) doc.workflow = {};
      if (Array.isArray(body.workflow.enabledStages)) {
        const allowed = new Set(AppSettings.ALL_STAGES);
        const stages = body.workflow.enabledStages
          .map((s) => String(s).toLowerCase())
          .filter((s) => allowed.has(s));
        if (!stages.includes('waiting')) stages.unshift('waiting');
        if (!stages.includes('completed')) stages.push('completed');
        if (!stages.includes('exited')) stages.push('exited');
        doc.workflow.enabledStages = AppSettings.ALL_STAGES.filter((s) => stages.includes(s));
      }
      if (typeof body.workflow.allowSkipSecretary === 'boolean') {
        doc.workflow.allowSkipSecretary = body.workflow.allowSkipSecretary;
      }
      if (typeof body.workflow.allowSkipKhart === 'boolean') {
        doc.workflow.allowSkipKhart = body.workflow.allowSkipKhart;
      }
    }

    await doc.save();
    setWorkflowConfig(doc.workflow);

    return res.json({
      success: true,
      message: 'تم حفظ إعدادات المعمل',
      branding: publicBrandingFrom(doc),
      workflow: {
        enabledStages: doc.workflow.enabledStages,
        allowSkipSecretary: doc.workflow.allowSkipSecretary !== false,
        allowSkipKhart: doc.workflow.allowSkipKhart !== false,
        allStages: AppSettings.ALL_STAGES,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getWhatsAppSettings = async (req, res) => {
  try {
    const doc = await getOrCreateSettings();
    const wa = doc.whatsapp || {};
    const provider = wa.provider || 'ultramsg';
    let liveConfigured = false;
    try {
      await reloadWhatsAppConfig();
      liveConfigured = providerConfigured();
    } catch {
      liveConfigured = false;
    }
    return res.json({
      success: true,
      settings: {
        enabled: !!wa.enabled,
        provider,
        instanceId: wa.instanceId || '',
        phoneNumberId: wa.phoneNumberId || '',
        dailyHour: wa.dailyHour ?? 18,
        labName: wa.labName || 'OCCLA Dental Lab',
        msgCompleted:
          wa.msgCompleted ||
          '{lab}\nحالة ({patient})\n{workType} — {quantity} قطعة\nجاهزة للاستلام تواصل مع المعمل لاستلام الحالة',
        msgExited:
          wa.msgExited ||
          '{lab}\nحالة ({patient})\n{workType} — {quantity} قطعة\nتم التسليم / خرجت من المعمل',
        msgDaily:
          wa.msgDaily ||
          '{lab} — ملخص يومي\nعندك {count} حالات جاهزة للاستلام.\n{list}',
        alertPhones: wa.alertPhones || '',
        hasToken: !!(wa.token && String(wa.token).trim()),
        liveConfigured,
        web: provider === 'waweb' ? getPublicStatus() : undefined,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateWhatsAppSettings = async (req, res) => {
  try {
    const body = req.body || {};
    const doc = await getOrCreateSettings();
    const wa = doc.whatsapp || {};

    if (typeof body.enabled === 'boolean') wa.enabled = body.enabled;
    if (body.provider !== undefined) wa.provider = String(body.provider || '');
    if (body.instanceId !== undefined) wa.instanceId = String(body.instanceId || '').trim();
    if (body.phoneNumberId !== undefined) wa.phoneNumberId = String(body.phoneNumberId || '').trim();
    if (body.dailyHour !== undefined) {
      const h = Number(body.dailyHour);
      wa.dailyHour = Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 18;
    }
    if (body.labName !== undefined) {
      wa.labName = String(body.labName || '').trim() || 'OCCLA Dental Lab';
      // The same "lab name" box renames the lab everywhere (login, navbar, printouts)
      if (!doc.branding) doc.branding = {};
      doc.branding.labName = wa.labName;
    }
    if (body.msgCompleted !== undefined) {
      wa.msgCompleted = String(body.msgCompleted || '').trim() || wa.msgCompleted;
    }
    if (body.msgExited !== undefined) {
      wa.msgExited = String(body.msgExited || '').trim() || wa.msgExited;
    }
    if (body.msgDaily !== undefined) {
      wa.msgDaily = String(body.msgDaily || '').trim() || wa.msgDaily;
    }
    if (body.alertPhones !== undefined) {
      wa.alertPhones = String(body.alertPhones || '').trim();
    }
    if (typeof body.token === 'string' && body.token.trim()) {
      wa.token = body.token.trim();
    }
    if (body.clearToken === true) {
      wa.token = '';
    }

    doc.whatsapp = wa;
    await doc.save();
    await reloadWhatsAppConfig();

    if (wa.provider === 'waweb' && wa.enabled) {
      startWhatsAppWeb().catch((e) => console.warn('[wa-web] autostart:', e.message));
    }

    return res.json({
      success: true,
      message: 'تم حفظ إعدادات واتساب',
      liveConfigured: providerConfigured(),
      web: wa.provider === 'waweb' ? getPublicStatus() : undefined,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.testWhatsApp = async (req, res) => {
  try {
    await reloadWhatsAppConfig();
    if (!providerConfigured()) {
      return res.status(400).json({
        success: false,
        message:
          'واتساب مش جاهز — لو WhatsApp Web امسح QR واتأكد إنه متصل، أو عبّي إعدادات UltraMsg/Meta',
      });
    }
    const phone = String(req.body?.phone || req.user?.phone || '').trim();
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'اكتب رقم موبايل للاختبار (مثال: 01xxxxxxxxx)',
      });
    }
    const customMessage = String(
      req.body?.message ?? req.body?.text ?? req.body?.body ?? ''
    ).trim();
    const testMessage =
      customMessage ||
      'OCCLA Dental Lab\n✅ تجربة إشعار واتساب من السيستم — لو وصلك الرسالة يبقى الإعداد تمام.';
    const result = await sendWhatsAppText(phone, testMessage);
    if (!result || result.skipped || !result.ok) {
      return res.status(400).json({
        success: false,
        message:
          result?.error ||
          (result?.skipped
            ? 'تم تخطي الإرسال — واتساب مش جاهز/متصل'
            : 'فشل إرسال رسالة الاختبار'),
        detail: {
          to: result?.to || undefined,
          jid: result?.jid || undefined,
          skipped: !!result?.skipped,
          self: !!result?.self,
        },
      });
    }
    return res.json({
      success: true,
      message: 'تم إرسال رسالة الاختبار',
      to: result.to || undefined,
      jid: result.jid || undefined,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.runDailySummaryNow = async (req, res) => {
  try {
    await reloadWhatsAppConfig();
    const doc = await AppSettings.findOne({ key: 'app' }).lean();
    if (String(doc?.whatsapp?.provider || '') === 'waweb') {
      return res.status(400).json({
        success: false,
        message: 'وضع WhatsApp Web يرسل فقط عند انتهاء الحالة — الملخص اليومي متوقف لتقليل خطر الحظر',
      });
    }
    if (!providerConfigured()) {
      return res.status(400).json({ success: false, message: 'واتساب مش مضبوط' });
    }
    await sendDailyReadySummaries();
    return res.json({ success: true, message: 'تم إرسال الملخص اليومي للدكاترة اللي عندهم حالات جاهزة' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getWhatsAppWebStatus = async (_req, res) => {
  try {
    return res.json({ success: true, ...getPublicStatus() });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.startWhatsAppWeb = async (req, res) => {
  try {
    const force = req.body?.force === true;
    const status = await startWhatsAppWeb({ force });
    return res.json({ success: true, ...status });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.logoutWhatsAppWeb = async (_req, res) => {
  try {
    const status = await stopWhatsAppWeb(true);
    return res.json({ success: true, message: 'تم فصل واتساب Web', ...status });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
