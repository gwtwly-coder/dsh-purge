/**
 * [dsh-purge] reasoning loop guard
 *
 * 模型（尤其 flash 档）在长任务里会陷入"推理死循环"：reasoning 里反复生成
 * 同一两句话（"好。""做。""我停止空转，直接做。"），直到把 max_tokens 烧完。
 * 宿主对 reasoning 长度没有任何上限，表现就是"一直在想、永远不输出"。
 *
 * 实测数据（118,011 字符的真实死循环 vs 正常推理）：
 *   指标                 死循环    正常中文   正常英文
 *   末尾 4000 字唯一字符    14        120        ~45
 *   平均句长              6.2       15.8        ~14
 *   最高频 2 字串次数      215        16         高（"th"/"e " 天生高频）
 *
 * 结论：字符 n-gram 判据只对中文有效；英文必须用「整句完全重复」判据，否则
 * 任何英文推理都会被当成死循环。所以先按 CJK 占比分流。
 */

/** 触发检查的最小 reasoning 长度。 */
const MIN_TOTAL_CHARS = 6000;

/** 只看末尾这么多字符。 */
const TAIL_CHARS = 4000;

/** 中文判据：末尾唯一字符数上限（正常中文 4000 字通常 400+）。 */
const MAX_UNIQUE_CHARS = 60;

/** 中文判据：最高频 2–4 字短串出现次数下限。 */
const MIN_GRAM_REPEATS = 60;

/** 英文判据：整句完全相同的次数下限。 */
const MIN_SENTENCE_REPEATS = 8;

/** tail 里中文字符占比达到这个值，就走中文判据。 */
const CJK_RATIO_THRESHOLD = 0.35;

/**
 * 判断累积的 reasoning 文本是否已陷入死循环。
 * @param {string} text 累积的 reasoning 文本。
 * @returns {boolean} true 表示已陷入死循环。
 */
export function isReasoningLoop(text) {
  if (typeof text !== "string" || text.length < MIN_TOTAL_CHARS) return false;

  const tail = text.slice(-TAIL_CHARS);
  if (tail.length < 2000) return false;

  const cjk = (tail.match(/[\u4e00-\u9fff]/g) ?? []).length / tail.length;

  if (cjk < CJK_RATIO_THRESHOLD) return isSentenceLoop(tail);
  return isGramLoop(tail);
}

/** 英文为主的文本：整句完全相同太多次才算循环。 */
function isSentenceLoop(tail) {
  const sentences = tail
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  if (sentences.length < 20) return false;

  const freq = new Map();
  let max = 0;
  for (const s of sentences) {
    const next = (freq.get(s) ?? 0) + 1;
    freq.set(s, next);
    if (next > max) max = next;
  }
  return max >= MIN_SENTENCE_REPEATS;
}

/** 中文为主的文本：字符集塌缩 + 短串高频同时成立。 */
function isGramLoop(tail) {
  if (new Set(tail).size > MAX_UNIQUE_CHARS) return false;

  let maxCount = 0;
  for (let len = 2; len <= 4; len += 1) {
    const counts = new Map();
    for (let i = 0; i + len <= tail.length; i += 1) {
      const gram = tail.slice(i, i + len);
      const next = (counts.get(gram) ?? 0) + 1;
      counts.set(gram, next);
      if (next > maxCount) maxCount = next;
    }
    if (maxCount >= MIN_GRAM_REPEATS * 2) return true;
  }
  return maxCount >= MIN_GRAM_REPEATS;
}

/**
 * 把判定函数挂到 globalThis，供补丁在 llm 适配层调用。重复安装幂等。
 */
export function installReasoningGuard() {
  globalThis.__dshPurgeIsLooping = isReasoningLoop;
  return {
    installed: true,
    minTotalChars: MIN_TOTAL_CHARS,
    maxUniqueChars: MAX_UNIQUE_CHARS,
    minGramRepeats: MIN_GRAM_REPEATS,
    minSentenceRepeats: MIN_SENTENCE_REPEATS,
  };
}
