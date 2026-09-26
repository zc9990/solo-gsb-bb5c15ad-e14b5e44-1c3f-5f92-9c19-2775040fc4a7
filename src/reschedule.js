'use strict';

const { trace } = require('./trace');

/**
 * 批次改期影响预览（纯试算）
 *
 * 给定一个现有批次与新的批次时间：
 *   1. 计算「原批次时间 → 新批次时间」的分钟差；
 *   2. 该批次所有填写了时间的设备步骤按此分钟差整体平移；
 *      留空步骤不写入时间，推演时继续回退到（新的）批次时间；
 *   3. 其他批次与全部清洗记录保持原样；
 *   4. 复用 trace() 推演引擎分别推演改期前 / 改期后，逐批对比：
 *      新增的交叉污染过敏原、消失的交叉污染过敏原、改期后的最终过敏原集合。
 *
 * 批次“先继承后留渍”、同一分钟清洗先于接触等规则由 trace() 保证，
 * 与主推演完全一致。
 *
 * 本函数不读取也不写入持久化记录：入参会被防御性深拷贝，
 * 改期只发生在这次试算的内存副本上，不落盘、不产生新 ID。
 *
 * @param {{equipment: Array, batches: Array, cleanings: Array}} baseData 原始记录
 * @param {{batchId: string, newTime: string}} input 已规范化的入参
 * @returns {object} 预览结果
 */
function previewReschedule(baseData, input) {
  // 防御性拷贝：保证试算（平移批次与步骤时间）绝不触碰调用方的原始记录。
  const data = structuredClone(baseData);
  const { batchId, newTime } = input;

  // ---- 改期前基线 -------------------------------------------------------

  const before = trace(data);

  // ---- 在内存副本上应用改期 ---------------------------------------------

  const batch = data.batches.find((b) => b.id === batchId);
  const fromTime = batch.time;
  const shiftMinutes = timeToMinutes(newTime) - timeToMinutes(fromTime);
  batch.time = newTime;
  for (const step of batch.steps || []) {
    // 只平移填写了时间的步骤；留空步骤保持 null，推演时回退到新批次时间。
    if (step.time) step.time = shiftTime(step.time, shiftMinutes);
  }

  // ---- 改期后推演 -------------------------------------------------------

  const after = trace(data);
  const afterByBatch = new Map(after.batches.map((b) => [b.batchId, b]));

  // ---- 逐批对比（按改期前的展示顺序列出全部批次） -------------------------

  const batches = before.batches.map((bb) => {
    const ab = afterByBatch.get(bb.batchId);
    const afterInherited = ab ? ab.inheritedAllergens : [];
    const addedInherited = afterInherited.filter(
      (a) => !bb.inheritedAllergens.includes(a)
    );
    const removedInherited = bb.inheritedAllergens.filter(
      (a) => !afterInherited.includes(a)
    );
    return {
      batchId: bb.batchId,
      name: bb.name,
      isRescheduled: bb.batchId === batchId,
      recipeAllergens: bb.recipeAllergens,
      beforeInherited: bb.inheritedAllergens,
      afterInherited,
      addedInherited,
      removedInherited,
      beforeFinal: bb.finalAllergens,
      afterFinal: ab ? ab.finalAllergens : [],
      changed: addedInherited.length > 0 || removedInherited.length > 0,
    };
  });

  return {
    batch: {
      batchId,
      name: batch.name,
      fromTime,
      toTime: newTime,
      shiftMinutes,
    },
    changedCount: batches.filter((b) => b.changed).length,
    batches,
  };
}

/**
 * 'YYYY-MM-DDTHH:MM' → 分钟数。
 * 按 UTC 拼值而非本地时区解析，避免时区 / 夏令时影响两个时间的差值。
 */
function timeToMinutes(t) {
  const [datePart, hm] = t.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) / 60000;
}

/** 分钟数 → 'YYYY-MM-DDTHH:MM'（与 timeToMinutes 互逆）。 */
function minutesToTime(mins) {
  const d = new Date(mins * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

/** 把时间字符串整体平移 delta 分钟（可为负）。 */
function shiftTime(t, deltaMinutes) {
  return minutesToTime(timeToMinutes(t) + deltaMinutes);
}

module.exports = { previewReschedule };
