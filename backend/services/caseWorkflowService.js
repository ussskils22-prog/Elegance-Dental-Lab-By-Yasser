/**
 * Strict case workflow rules — forward-only stages, exit only after completed.
 * Enabled stages come from AppSettings.workflow (lab-configurable).
 *
 * Scanner1 (reception / منتهية): always completes from any non-exited stage
 * (waiting/new, design, finishing, …). No env flag — lab requirement.
 */

const STAGE_ORDER = [
  'waiting',
  'secretary',
  'design',
  'khart',
  'finishing',
  'completed',
  'exited',
];

/** Always on — reception scan marks case completed from any open stage. */
function scanner1SkipEnabled() {
  return true;
}

let workflowCache = {
  enabledStages: [...STAGE_ORDER],
  allowSkipSecretary: true,
  allowSkipKhart: true,
};

function setWorkflowConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  const enabled = Array.isArray(cfg.enabledStages)
    ? cfg.enabledStages.map((s) => String(s).toLowerCase()).filter((s) => STAGE_ORDER.includes(s))
    : [...STAGE_ORDER];
  // Always keep waiting + exited for system integrity
  const set = new Set(enabled.length ? enabled : STAGE_ORDER);
  set.add('waiting');
  set.add('exited');
  if (!set.has('completed')) set.add('completed');
  workflowCache = {
    enabledStages: STAGE_ORDER.filter((s) => set.has(s)),
    allowSkipSecretary: cfg.allowSkipSecretary !== false,
    allowSkipKhart: cfg.allowSkipKhart !== false,
  };
}

function getWorkflowConfig() {
  return workflowCache;
}

function isStageEnabled(stage) {
  return workflowCache.enabledStages.includes(normalizeStage(stage));
}

function normalizeStage(stage) {
  const s = String(stage || 'waiting').trim().toLowerCase();
  return STAGE_ORDER.includes(s) ? s : 'waiting';
}

function stageIndex(stage) {
  return STAGE_ORDER.indexOf(normalizeStage(stage));
}

function isExitedCase(doc) {
  return (
    String(doc?.status || '') === 'exited' ||
    String(doc?.currentStage || '') === 'exited'
  );
}

function isCompletedCase(doc) {
  return (
    String(doc?.status || '') === 'completed' ||
    String(doc?.currentStage || '') === 'completed'
  );
}

function buildAllowedPairs() {
  const cfg = workflowCache;
  const enabled = new Set(cfg.enabledStages);
  const pairs = new Set();

  const hasSec = enabled.has('secretary');
  const hasDesign = enabled.has('design');
  const hasKhart = enabled.has('khart');
  const hasFin = enabled.has('finishing');
  const hasComp = enabled.has('completed');

  if (hasSec) {
    pairs.add('waiting>secretary');
    pairs.add('secretary>waiting');
  }
  if (hasDesign) {
    if (hasSec && cfg.allowSkipSecretary !== false) {
      pairs.add('waiting>design');
    }
    if (hasSec) pairs.add('secretary>design');
    if (!hasSec) pairs.add('waiting>design');
  }
  if (hasKhart && hasDesign) {
    pairs.add('design>khart');
  }
  if (hasFin) {
    if (hasKhart && cfg.allowSkipKhart !== false && hasDesign) {
      pairs.add('design>finishing');
    }
    if (hasKhart) pairs.add('khart>finishing');
    if (!hasKhart && hasDesign) pairs.add('design>finishing');
    if (!hasDesign && !hasKhart) pairs.add('waiting>finishing');
  }
  if (hasComp && hasFin) {
    pairs.add('finishing>completed');
  } else if (hasComp && !hasFin && hasDesign) {
    pairs.add('design>completed');
  }

  return pairs;
}

/**
 * Allowed forward transitions for move-stage / scan.
 */
function assertForwardTransition(fromRaw, toRaw) {
  const from = normalizeStage(fromRaw);
  const to = normalizeStage(toRaw);

  if (from === to) {
    return { ok: true, same: true };
  }

  if (to === 'exited') {
    return {
      ok: false,
      message: 'لا يمكن النقل المباشر إلى «خارجة» — استخدم زر/مسار الخروج بعد الإكمال',
    };
  }

  if (from === 'exited') {
    return { ok: false, message: 'الحالة خارجة ولا يمكن نقلها' };
  }

  if (!isStageEnabled(to) && to !== 'waiting') {
    return {
      ok: false,
      message: `مرحلة «${to}» غير مفعّلة في إعدادات هذا المعمل`,
    };
  }

  const pairs = buildAllowedPairs();
  if (pairs.has(`${from}>${to}`)) {
    return { ok: true, same: false };
  }

  return {
    ok: false,
    message: `لا يمكن النقل من «${from}» إلى «${to}» — المراحل للأمام فقط حسب مسار المعمل`,
  };
}

/** Station scan: only advance into the station’s target from allowed prior stages */
function buildStationAllowedFrom() {
  const cfg = workflowCache;
  const enabled = new Set(cfg.enabledStages);
  const designFrom = new Set(['waiting', 'design']);
  if (enabled.has('secretary')) designFrom.add('secretary');

  const finishingFrom = new Set(['finishing']);
  if (enabled.has('design')) finishingFrom.add('design');
  if (enabled.has('khart')) finishingFrom.add('khart');

  const receptionFrom = new Set(['completed']);
  if (enabled.has('finishing')) receptionFrom.add('finishing');

  // Temporary lab mode: scanner1 (منتهية) may complete from any open stage
  if (scanner1SkipEnabled()) {
    for (const s of STAGE_ORDER) {
      if (s !== 'exited') receptionFrom.add(s);
    }
  }

  return {
    design: designFrom,
    finishing: finishingFrom,
    reception: receptionFrom,
  };
}

function assertStationTransition(station, fromRaw, targetStage) {
  const from = normalizeStage(fromRaw);
  if (from === 'exited') {
    return { ok: false, message: 'الحالة خارجة بالفعل ولا يمكن نقلها' };
  }
  const map = buildStationAllowedFrom();
  const allowed = map[station];
  if (!allowed || !allowed.has(from)) {
    return {
      ok: false,
      message: `لا يمكن مسح الحالة من مرحلة «${from}» إلى هذه المحطة`,
    };
  }
  if (from === targetStage) {
    return { ok: true, same: true };
  }

  // Scanner1 temporary skip: jump straight to completed without intermediate gates
  if (
    station === 'reception' &&
    normalizeStage(targetStage) === 'completed' &&
    scanner1SkipEnabled()
  ) {
    return { ok: true, same: false, skipped: true };
  }

  return assertForwardTransition(from, targetStage);
}

function assertCanComplete(doc) {
  if (isExitedCase(doc)) {
    return { ok: false, message: 'الحالة خارجة بالفعل' };
  }
  if (isCompletedCase(doc)) {
    return { ok: true, already: true };
  }
  const stage = normalizeStage(doc?.currentStage);
  const enabled = new Set(workflowCache.enabledStages);
  if (enabled.has('finishing')) {
    if (stage !== 'finishing' && stage !== 'completed') {
      return {
        ok: false,
        message: 'لا يمكن إكمال الحالة إلا بعد مرحلة الفينيش',
      };
    }
  } else if (enabled.has('design') && stage !== 'design' && stage !== 'completed') {
    return {
      ok: false,
      message: 'لا يمكن إكمال الحالة إلا بعد مرحلة الديزاين',
    };
  }
  return { ok: true, already: false };
}

function assertCanExit(doc) {
  if (isExitedCase(doc)) {
    return { ok: false, message: 'الحالة خارجة بالفعل' };
  }
  if (!isCompletedCase(doc)) {
    return {
      ok: false,
      message: 'لا يمكن إخراج الحالة إلا بعد أن تكون منتهية',
    };
  }
  return { ok: true };
}

module.exports = {
  STAGE_ORDER,
  normalizeStage,
  stageIndex,
  isExitedCase,
  isCompletedCase,
  assertForwardTransition,
  assertStationTransition,
  assertCanComplete,
  assertCanExit,
  setWorkflowConfig,
  getWorkflowConfig,
  isStageEnabled,
  scanner1SkipEnabled,
};
