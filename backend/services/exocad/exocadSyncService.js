const DentalCase = require('../../models/DentalCase');
const ExocadDoctorMapping = require('../../models/ExocadDoctorMapping');
const ExocadIngest = require('../../models/ExocadIngest');
const { parseDentalProjectXml } = require('./parseDentalProject');
const {
  namesLooselyEqual,
  normalizeName,
  requestedUnitsFromCase,
  requestedTeethFromCase,
  isExitedCase,
  applyDesignedSheetToDoc,
  parseNotesMeta,
  expandToken,
} = require('./exocadMatchHelpers');

function basenameOnly(p) {
  return String(p || '').split(/[/\\]/).pop() || '';
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function summarizeCase(c) {
  return {
    id: String(c._id),
    caseNumber: c.caseNumber,
    patientName: c.patientName,
    referringDoctor: c.referringDoctor,
    currentStage: c.currentStage,
    requestedUnits: requestedUnitsFromCase(c),
  };
}

async function resolveInternalDoctorNames(exocadPracticeName) {
  const practice = String(exocadPracticeName || '').trim();
  if (!practice) return [];
  const mappings = await ExocadDoctorMapping.find({ active: true }).lean();
  const hits = [];
  for (const m of mappings) {
    const aliases = [m.internalDoctorName, ...(m.exocadNames || [])];
    if (
      aliases.some(
        (a) => namesLooselyEqual(a, practice) || normalizeName(a) === normalizeName(practice)
      )
    ) {
      hits.push(m.internalDoctorName);
    }
  }
  // Built-in nickname match (e.g. الجندي ↔ DR/MOHAMED_ALJENDY) even without saved mapping
  if (namesLooselyEqual(practice, 'الجندي')) {
    hits.push('الجندي');
  }
  return [...new Set(hits)];
}

function doctorMatchesPractice(referringDoctor, practiceName, mappedNames) {
  const doc = String(referringDoctor || '').trim();
  const practice = String(practiceName || '').trim();
  if (!doc || !practice) return false;
  if (namesLooselyEqual(doc, practice)) return true;
  if (mappedNames.some((d) => namesLooselyEqual(d, doc))) return true;
  return false;
}

function caseDoctorName(doc) {
  const meta = parseNotesMeta(doc.notes || '');
  return String(doc.referringDoctor || meta.doctor || meta.doctorName || '').trim();
}

function casePatientName(doc) {
  const meta = parseNotesMeta(doc.notes || '');
  return String(doc.patientName || meta.patient || meta.patientName || '').trim();
}

/** True if ingest patient/folder/source looks like this case patient (AR↔EN). */
function ingestMatchesPatient(ing, patient) {
  const p = String(patient || '').trim();
  if (!p) return false;
  if (namesLooselyEqual(ing.patientName, p)) return true;
  const hay = normalizeName(
    `${ing.patientName || ''} ${ing.projectFolder || ''} ${ing.sourceFile || ''}`
  );
  if (!hay) return false;
  const tokens = normalizeName(p)
    .split(' ')
    .filter((t) => t.length > 1);
  for (const t of tokens) {
    for (const alias of expandToken(t)) {
      const a = normalizeName(alias);
      if (a.length >= 3 && hay.includes(a)) return true;
    }
  }
  return false;
}

function matchSelfTest() {
  return {
    layla: namesLooselyEqual('ليلى', 'layla'),
    marwan: namesLooselyEqual('مروان النادي', 'DR / MARWAN ELNADY'),
  };
}

/** Non-exited cases only. */
async function findCandidateCases(payload) {
  const doctorNames = await resolveInternalDoctorNames(payload.practiceName);
  const patient = String(payload.patientName || '').trim();
  const practice = String(payload.practiceName || '').trim();

  // Always scan recent active cases; filter in JS with AR↔EN-aware matching
  const cases = await DentalCase.find({
    currentStage: { $ne: 'exited' },
    status: { $ne: 'exited' },
  })
    .sort({ createdAt: -1 })
    .limit(800)
    .lean();

  const patientHits = cases.filter((c) => namesLooselyEqual(casePatientName(c), patient));
  const both = patientHits.filter((c) =>
    doctorMatchesPractice(caseDoctorName(c), practice, doctorNames)
  );

  if (both.length) {
    return { candidates: both, doctorMapped: true };
  }
  // Patient matched but doctor weak → still return for NEEDS_REVIEW (never auto-apply)
  if (patientHits.length) {
    return { candidates: patientHits, doctorMapped: false };
  }
  return {
    candidates: [],
    doctorMapped: doctorNames.length > 0,
    matchSelfTest: matchSelfTest(),
  };
}

function buildExocadFields(payload, dentalCase, syncStatus, extra = {}) {
  const requested = requestedUnitsFromCase(dentalCase);
  const actual = Number(payload.designedUnits) || 0;
  return {
    caseId: payload.exocadCaseId,
    doctorName: payload.practiceName || '',
    patientName: payload.patientName || '',
    sourceFile: basenameOnly(payload.sourceFile),
    actualDesignedUnits: actual,
    actualDesignedTeeth: payload.designedTeeth || [],
    unitsDifference: actual - requested,
    syncStatus,
    lastSyncedAt: syncStatus === 'SYNCED' ? new Date() : dentalCase.exocad?.lastSyncedAt || null,
    lastSyncError: extra.lastSyncError || '',
    matchCandidateIds: (extra.matchCandidateIds || []).map(String),
  };
}

async function applyToCase(caseId, payload, syncStatus = 'SYNCED', extra = {}) {
  const doc = await DentalCase.findById(caseId);
  if (!doc) return { ok: false, error: 'CASE_NOT_FOUND' };
  if (isExitedCase(doc)) return { ok: false, error: 'CASE_EXITED_LOCKED' };

  // Merge payload with any teeth already on the case (agent annotate / prior sync).
  const mergedPayload = {
    ...payload,
    designedTeeth:
      Array.isArray(payload?.designedTeeth) && payload.designedTeeth.length
        ? payload.designedTeeth
        : Array.isArray(doc.exocad?.actualDesignedTeeth)
          ? doc.exocad.actualDesignedTeeth
          : [],
    designedUnits:
      Number(payload?.designedUnits) ||
      Number(doc.exocad?.actualDesignedUnits) ||
      0,
  };

  const requestedBeforeSheet = requestedUnitsFromCase(doc);
  let sheet = null;
  if (syncStatus === 'SYNCED') {
    sheet = applyDesignedSheetToDoc(doc, mergedPayload);
  }

  doc.exocad = buildExocadFields(mergedPayload, doc, syncStatus, extra);
  if (syncStatus === 'SYNCED') {
    const actual =
      Number(mergedPayload.designedUnits) ||
      (mergedPayload.designedTeeth || []).length ||
      0;
    doc.exocad.unitsDifference = actual - requestedBeforeSheet;
    doc.exocad.lastSyncedAt = new Date();
    doc.exocad.lastSyncError = sheet?.applied
      ? ''
      : sheet?.reason || doc.exocad.lastSyncError || '';
    if (typeof doc.markModified === 'function') doc.markModified('exocad');
  }
  await doc.save();
  return {
    ok: true,
    case: doc,
    sheet,
    requestedUnits: requestedUnitsFromCase(doc),
    requestedTeeth: requestedTeethFromCase(doc),
  };
}

async function annotateCandidates(candidates, payload, status, errorMsg) {
  const ids = candidates.map((c) => String(c._id));
  for (const c of candidates.slice(0, 10)) {
    if (isExitedCase(c)) continue;
    await DentalCase.updateOne(
      { _id: c._id, currentStage: { $ne: 'exited' }, status: { $ne: 'exited' } },
      {
        $set: {
          'exocad.syncStatus': status,
          'exocad.caseId': payload.exocadCaseId,
          'exocad.doctorName': payload.practiceName || '',
          'exocad.patientName': payload.patientName || '',
          'exocad.sourceFile': basenameOnly(payload.sourceFile),
          'exocad.actualDesignedUnits': payload.designedUnits || 0,
          'exocad.actualDesignedTeeth': payload.designedTeeth || [],
          'exocad.unitsDifference': (payload.designedUnits || 0) - requestedUnitsFromCase(c),
          'exocad.matchCandidateIds': ids,
          'exocad.lastSyncError': errorMsg || '',
        },
      }
    );
  }
}

function normalizePayload(raw) {
  let payload = raw;
  if (raw?.xmlContent) {
    payload = parseDentalProjectXml(raw.xmlContent, {
      sourceFile: raw.sourceFile,
      projectFolder: raw.projectFolder,
    });
  }
  return {
    exocadCaseId: payload.exocadCaseId,
    practiceName: payload.practiceName || '',
    practiceId: payload.practiceId || '',
    patientName: payload.patientName || '',
    patientId: payload.patientId || '',
    designedTeeth: payload.designedTeeth || [],
    designedUnits: payload.designedUnits ?? (payload.designedTeeth || []).length,
    reconstructionTypes: payload.reconstructionTypes || [],
    sourceFile: basenameOnly(payload.sourceFile),
    projectFolder: payload.projectFolder || '',
    projectDateTime: payload.projectDateTime || null,
    rawToothCount: payload.rawToothCount || 0,
  };
}

async function ingestAndMatch(rawPayload) {
  const payload = normalizePayload(rawPayload);
  if (!payload.exocadCaseId) throw new Error('Missing exocadCaseId');

  const ingest = await ExocadIngest.findOneAndUpdate(
    { exocadCaseId: payload.exocadCaseId },
    {
      $set: {
        practiceName: payload.practiceName,
        patientName: payload.patientName,
        patientId: payload.patientId,
        practiceId: payload.practiceId,
        designedTeeth: payload.designedTeeth,
        designedUnits: payload.designedUnits,
        reconstructionTypes: payload.reconstructionTypes,
        sourceFile: payload.sourceFile,
        projectFolder: payload.projectFolder,
        projectDateTime: payload.projectDateTime,
        rawToothCount: payload.rawToothCount,
        lastIngestedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (ingest.matchedCaseId && ingest.syncStatus === 'SYNCED') {
    const existing = await DentalCase.findById(ingest.matchedCaseId);
    if (existing && !isExitedCase(existing)) {
      const applied = await applyToCase(existing._id, payload, 'SYNCED');
      return {
        ingest,
        status: 'SYNCED',
        applied,
        message: 'Already linked — refreshed designed units/teeth',
      };
    }
  }

  const { candidates, doctorMapped } = await findCandidateCases(payload);

  if (!candidates.length) {
    ingest.syncStatus = 'NO_MATCH';
    ingest.matchedCaseId = null;
    ingest.lastError = 'No active (non-exited) case matched';
    await ingest.save();
    return { ingest, status: 'NO_MATCH',
    matchSelfTest: matchSelfTest(),
    candidates: [], doctorMapped };
  }

  if (candidates.length > 1 || !doctorMapped) {
    const status = candidates.length > 1 ? 'MULTIPLE_MATCHES' : 'NEEDS_REVIEW';
    const err =
      status === 'MULTIPLE_MATCHES'
        ? 'Multiple possible cases — manual confirmation required'
        : 'Doctor mapping missing or weak — manual confirmation required';
    ingest.syncStatus = status;
    ingest.matchedCaseId = null;
    ingest.lastError = err;
    await ingest.save();
    await annotateCandidates(candidates, payload, status, err);
    return {
      ingest,
      status,
      candidates: candidates.map(summarizeCase),
      doctorMapped,
    };
  }

  const target = candidates[0];
  const applied = await applyToCase(target._id, payload, 'SYNCED');
  if (!applied.ok) {
    ingest.syncStatus = 'SYNC_ERROR';
    ingest.lastError = applied.error || 'Apply failed';
    await ingest.save();
    return { ingest, status: 'SYNC_ERROR', error: applied.error };
  }

  ingest.syncStatus = 'SYNCED';
  ingest.matchedCaseId = target._id;
  ingest.lastError = '';
  await ingest.save();

  return {
    ingest,
    status: 'SYNCED',
    applied,
    candidates: [summarizeCase(target)],
    doctorMapped: true,
  };
}

async function confirmMatch(caseId, exocadCaseId) {
  const ingest = await ExocadIngest.findOne({ exocadCaseId });
  if (!ingest) return { ok: false, error: 'INGEST_NOT_FOUND' };

  const payload = {
    exocadCaseId: ingest.exocadCaseId,
    practiceName: ingest.practiceName,
    patientName: ingest.patientName,
    designedTeeth: ingest.designedTeeth,
    designedUnits: ingest.designedUnits,
    sourceFile: ingest.sourceFile,
  };

  const applied = await applyToCase(caseId, payload, 'SYNCED');
  if (!applied.ok) return applied;

  ingest.syncStatus = 'SYNCED';
  ingest.matchedCaseId = caseId;
  ingest.lastError = '';
  await ingest.save();
  // Flatten so controllers can read result.sheet directly
  return { ok: true, ingest, sheet: applied.sheet, applied };
}

async function syncCaseById(caseId) {
  const doc = await DentalCase.findById(caseId);
  if (!doc) return { ok: false, error: 'CASE_NOT_FOUND' };
  if (isExitedCase(doc)) return { ok: false, error: 'CASE_EXITED_LOCKED' };

  if (doc.exocad?.caseId) {
    const ingest = await ExocadIngest.findOne({ exocadCaseId: doc.exocad.caseId });
    if (ingest) {
      const payload = {
        exocadCaseId: ingest.exocadCaseId,
        practiceName: ingest.practiceName,
        patientName: ingest.patientName,
        designedTeeth: ingest.designedTeeth,
        designedUnits: ingest.designedUnits,
        sourceFile: ingest.sourceFile,
      };
      const applied = await applyToCase(caseId, payload, 'SYNCED');
      if (applied.ok) {
        ingest.syncStatus = 'SYNCED';
        ingest.matchedCaseId = doc._id;
        ingest.lastError = '';
        await ingest.save();
      }
      return applied;
    }
  }

  // Do not filter by syncStatus — SYNC_ERROR / older rows must still be matchable.
  const recent = await ExocadIngest.find({})
    .sort({ lastIngestedAt: -1 })
    .limit(500)
    .lean();

  const patient = casePatientName(doc);
  const doctor = caseDoctorName(doc);
  let hits = recent.filter((ing) => ingestMatchesPatient(ing, patient));

  if (!hits.length) {
    const sample = recent
      .slice(0, 5)
      .map((r) => `${r.patientName || '?'} / ${r.practiceName || '?'}`)
      .join(' | ');
    const probe = matchSelfTest();
    doc.set('exocad.syncStatus', 'NO_MATCH');
    doc.set(
      'exocad.lastSyncError',
      recent.length
        ? `لا يوجد مشروع Exocad مطابق للمريض "${patient}" (probe layla=${probe.layla}, marwan=${probe.marwan}; آخر وصول: ${sample})`
        : 'مفيش أي مشاريع واصلة من الـ Exocad Agent — تأكد إن الـ agent شغال ومتصل بالسيرفر'
    );
    await doc.save();
    return { ok: false, error: 'NO_MATCH', matchSelfTest: probe };
  }

  // Prefer projects whose Exocad practice matches this case's doctor
  // (e.g. الجندي ↔ DR/MOHAMED_ALJENDY) so "ahmed khaled" under another doctor is ignored.
  const doctorHits = [];
  for (const ing of hits) {
    const mapped = await resolveInternalDoctorNames(ing.practiceName);
    if (doctorMatchesPractice(doctor, ing.practiceName, mapped)) {
      doctorHits.push(ing);
    }
  }
  const narrowed = doctorHits.length ? doctorHits : hits;

  if (narrowed.length === 1) {
    return confirmMatch(caseId, narrowed[0].exocadCaseId);
  }

  doc.set('exocad.syncStatus', 'MULTIPLE_MATCHES');
  doc.set('exocad.lastSyncError', 'Multiple Exocad projects — pick one to confirm');
  await doc.save();
  return {
    ok: false,
    error: 'MULTIPLE_MATCHES',
    ingests: narrowed.map((h) => ({
      exocadCaseId: h.exocadCaseId,
      patientName: h.patientName,
      practiceName: h.practiceName,
      designedUnits: h.designedUnits,
      designedTeeth: h.designedTeeth,
    })),
  };
}

async function getCaseExocadView(caseId) {
  const doc = await DentalCase.findById(caseId).lean();
  if (!doc) return null;
  const requestedUnits = requestedUnitsFromCase(doc);
  const requestedTeeth = requestedTeethFromCase(doc);
  const ex = doc.exocad || {};
  return {
    caseId: String(doc._id),
    caseNumber: doc.caseNumber,
    exited: isExitedCase(doc),
    doctor: doc.referringDoctor || '',
    patient: doc.patientName || '',
    requestedUnits,
    requestedTeeth,
    actualDesignedUnits: ex.actualDesignedUnits ?? null,
    actualDesignedTeeth: ex.actualDesignedTeeth || [],
    unitsDifference:
      ex.unitsDifference != null
        ? ex.unitsDifference
        : ex.actualDesignedUnits != null
          ? Number(ex.actualDesignedUnits) - requestedUnits
          : null,
    syncStatus: ex.syncStatus || '',
    lastSyncedAt: ex.lastSyncedAt || null,
    lastSyncError: ex.lastSyncError || '',
    exocadCaseId: ex.caseId || '',
    exocadDoctorName: ex.doctorName || '',
    exocadPatientName: ex.patientName || '',
    sourceFile: ex.sourceFile || '',
    matchCandidateIds: ex.matchCandidateIds || [],
  };
}

module.exports = {
  ingestAndMatch,
  confirmMatch,
  syncCaseById,
  applyToCase,
  findCandidateCases,
  getCaseExocadView,
  parseDentalProjectXml, // re-export for agent preview
};
