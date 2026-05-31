/**
 * LabFlow 实验计算工具函数
 *
 * 提供常用生化/分子生物学计算，每个函数含单元测试示例注释。
 */

// ════════════════════════════════════════════════════════════
// 计算器 ①：摩尔浓度换算
// ════════════════════════════════════════════════════════════

/**
 * 从溶质质量计算摩尔浓度
 *   C(mol/L) = mass(g) / (MW(g/mol) × V(L))
 *
 * @example
 *   calcMolarity(58.44, 58.44, 1000)  // NaCl: 1M in 1L → 1.000
 *   calcMolarity(5.844, 58.44, 100)   // → 1.000
 */
export function calcMolarity(
  massGram: number,
  molarMass: number,
  volumeML: number
): number {
  if (molarMass <= 0 || volumeML <= 0) return 0;
  const volumeL = volumeML / 1000; // mL → L
  return Number(((massGram / molarMass) / volumeL).toFixed(4));
}

/**
 * 计算配制溶液所需溶质质量
 *   mass(g) = MW(g/mol) × C(mol/L) × V(L)
 *
 * @example
 *   calcSoluteMass(58.44, 1, 0.5)  // → 29.22 (g NaCl 配 0.5L 1M)
 */
export function calcSoluteMass(
  molarMass: number,
  concentration: number,
  volume: number
): number {
  return molarMass * concentration * volume;
}

// ════════════════════════════════════════════════════════════
// 计算器 ②：稀释计算 C₁V₁ = C₂V₂
// ════════════════════════════════════════════════════════════

/**
 * 稀释计算
 *
 * @example
 *   calcDilution(10, 2, 100)  // → { stockVolume: 20, solventVolume: 80 }
 *   calcDilution(100, 25, 200) // → { stockVolume: 50, solventVolume: 150 }
 */
export function calcDilution(
  stockConc: number,
  targetConc: number,
  targetVolume: number
): { stockVolume: number; solventVolume: number } {
  if (stockConc <= 0) return { stockVolume: 0, solventVolume: 0 };
  const stockVolume = (targetConc * targetVolume) / stockConc;
  return {
    stockVolume: Number(stockVolume.toFixed(4)),
    solventVolume: Number((targetVolume - stockVolume).toFixed(4)),
  };
}

// ════════════════════════════════════════════════════════════
// 计算器 ③：PCR 反应体系配置
// ════════════════════════════════════════════════════════════

/** PCR 组分定义 */
export interface PCRComponent {
  name: string;
  stockConc: string;  // 如 "10×", "2.5 mM each", "10 μM"
  targetConc: string; // 如 "1×", "0.2 mM", "0.2 μM"
  ratio: number;      // 体积比例（配制 100 μL 反应时的用量 μL）
  isVariable: boolean; // 是否为可调组分（如 DNA 模板）
}

/** 默认 Taq PCR 组分 (50 μL 反应体系模板) */
export const DEFAULT_PCR_COMPONENTS: PCRComponent[] = [
  { name: "10× Buffer",       stockConc: "10×",        targetConc: "1×",         ratio: 5,   isVariable: false },
  { name: "dNTPs",            stockConc: "2.5 mM each", targetConc: "0.2 mM",     ratio: 4,   isVariable: false },
  { name: "Primer F",         stockConc: "10 μM",       targetConc: "0.2 μM",     ratio: 1,   isVariable: false },
  { name: "Primer R",         stockConc: "10 μM",       targetConc: "0.2 μM",     ratio: 1,   isVariable: false },
  { name: "DNA Template",     stockConc: "—",           targetConc: "—",           ratio: 2,   isVariable: true },
  { name: "DNA Polymerase",   stockConc: "5 U/μL",      targetConc: "0.025 U/μL", ratio: 0.25, isVariable: false },
  { name: "ddH₂O",            stockConc: "—",           targetConc: "—",           ratio: 0,   isVariable: false },
];

/** 单个管计算结果 */
export interface PCRTubeCalc {
  name: string;
  volumePerTube: number; // μL / tube
}

/** PCR 体系计算结果 */
export interface PCRMixResult {
  reactionVolume: number;    // 每管反应体积 (μL)
  numSamples: number;        // 样品数
  totalTubes: number;        // 总管数 = 样品数 + 1 (额外)
  perTube: PCRTubeCalc[];    // 每管各组分用量
  masterMix: PCRTubeCalc[];  // 预混液各组分总量
  h2oVolume: number;         // 补水量 = 反应体积 - Σ其他组分
}

/**
 * 计算 PCR 反应体系
 *
 * @param reactionVolume  每管反应总体积 (μL)，默认 50
 * @param numSamples      样品数量
 * @param components      组分列表（含 ratio 比例，以 100 μL 为基准）
 *
 * @example
 *   calcPCRMix(50, 8, DEFAULT_PCR_COMPONENTS)
 *   // → perTube: Buffer 5μL, dNTPs 4μL, ... ddH₂O 补足
 *   // → masterMix × 9 管 (8+1)
 */
export function calcPCRMix(
  reactionVolume: number,
  numSamples: number,
  components: PCRComponent[] = DEFAULT_PCR_COMPONENTS
): PCRMixResult {
  const scale = reactionVolume / 100; // 默认 ratio 基于 100 μL
  const totalTubes = numSamples + 1;  // +1 管余量

  // 计算非水组分的总体积
  const nonWaterComponents = components.filter((c) => c.name !== "ddH₂O");
  let fixedVolume = 0;
  const perTube: PCRTubeCalc[] = [];
  const masterMix: PCRTubeCalc[] = [];

  for (const comp of nonWaterComponents) {
    const volPerTube = Number((comp.ratio * scale).toFixed(2));
    perTube.push({ name: comp.name, volumePerTube: volPerTube });
    masterMix.push({
      name: comp.name,
      volumePerTube: Number((volPerTube * totalTubes).toFixed(2)),
    });
    fixedVolume += volPerTube;
  }

  // 补水
  const h2oPerTube = Math.max(0, Number((reactionVolume - fixedVolume).toFixed(1)));
  perTube.push({ name: "ddH₂O", volumePerTube: h2oPerTube });
  masterMix.push({
    name: "ddH₂O",
    volumePerTube: Number((h2oPerTube * totalTubes).toFixed(1)),
  });

  return {
    reactionVolume,
    numSamples,
    totalTubes,
    perTube,
    masterMix,
    h2oVolume: h2oPerTube,
  };
}

// ════════════════════════════════════════════════════════════
// 计算器 ④：DNA/RNA 浓度计算（NanoDrop）
// ════════════════════════════════════════════════════════════

export type NucleicAcidType = "dsDNA" | "ssDNA" | "RNA";

/** 消光系数 (ng·cm/μL) — 即 1 A260 对应的浓度 */
const EXTINCTION_COEFF: Record<NucleicAcidType, number> = {
  dsDNA: 50,  // 双链 DNA: 1 A260 = 50 ng/μL
  ssDNA: 33,  // 单链 DNA: 1 A260 = 33 ng/μL
  RNA:   40,  // RNA:       1 A260 = 40 ng/μL
};

/**
 * NanoDrop 核酸浓度计算
 *   C(ng/μL) = A260 × 消光系数 × 稀释倍数
 *
 * @example
 *   calcNucleicAcidConc(0.5, 100, "dsDNA")  // → 2500 ng/μL
 *   calcNucleicAcidConc(1.2, 50,  "RNA")    // → 2400 ng/μL
 *   calcNucleicAcidConc(2.0, 1,   "ssDNA")  // → 66 ng/μL
 */
export function calcNucleicAcidConc(
  a260: number,
  dilutionFactor: number,
  type: NucleicAcidType = "dsDNA"
): number {
  if (a260 < 0 || dilutionFactor <= 0) return 0;
  const coeff = EXTINCTION_COEFF[type];
  return Number((a260 * coeff * dilutionFactor).toFixed(2));
}

/**
 * 计算 A260/A280 纯度比值含义
 */
export function purityAssessment(a260a280: number): {
  label: string;
  color: "green" | "yellow" | "red";
} {
  if (a260a280 >= 1.8 && a260a280 <= 2.0) {
    return { label: "纯度高 ✅", color: "green" };
  } else if (a260a280 >= 1.6 && a260a280 <= 2.2) {
    return { label: "可接受 ⚠️", color: "yellow" };
  }
  return { label: "有污染 ❌", color: "red" };
}

// ════════════════════════════════════════════════════════════
// 保留原有函数（向后兼容）
// ════════════════════════════════════════════════════════════

/** g/L → mol/L */
export function gPerLToMolar(concentrationGL: number, molarMass: number): number {
  return concentrationGL / molarMass;
}

/** mol/L → g/L */
export function molarToGPerL(molarity: number, molarMass: number): number {
  return molarity * molarMass;
}

/** mg/mL → μg/μL (等同) */
export function mgMlToUgUl(value: number): number {
  return value;
}

/** μg/μL → ng/μL */
export function ugUlToNgUl(value: number): number {
  return value * 1000;
}

/** nM → μM */
export function nMToMicroM(value: number): number {
  return value / 1000;
}

// ─── DNA 拷贝数 / Tm / GC ────────────────────────────────────

export function calcCopyNumber(dnaMassNg: number, fragmentLen: number): number {
  return (dnaMassNg * 6.022e23) / (fragmentLen * 660 * 1e9);
}

export function calcTmWallace(sequence: string): number {
  const upper = sequence.toUpperCase();
  const aCount = (upper.match(/A/g) ?? []).length;
  const tCount = (upper.match(/T/g) ?? []).length;
  const gCount = (upper.match(/G/g) ?? []).length;
  const cCount = (upper.match(/C/g) ?? []).length;
  return 2 * (aCount + tCount) + 4 * (gCount + cCount);
}

export function calcGCContent(sequence: string): number {
  const upper = sequence.toUpperCase();
  const gcCount = (upper.match(/[GC]/g) ?? []).length;
  if (upper.length === 0) return 0;
  return Number(((gcCount / upper.length) * 100).toFixed(1));
}

// ─── 细胞培养 ────────────────────────────────────────────────

export function calcCellCount(
  counts: [number, number, number, number],
  dilution: number = 1,
  volumeML: number = 1
): { concentration: number; totalCells: number } {
  const avgCount = counts.reduce((a, b) => a + b, 0) / 4;
  const concentration = avgCount * dilution * 1e4;
  return {
    concentration: Number(concentration.toFixed(0)),
    totalCells: Number((concentration * volumeML).toFixed(0)),
  };
}

export function calcPassage(
  currentConc: number,
  targetConc: number,
  targetVolume: number
): { cellSuspensionML: number; freshMediumML: number } {
  const cellSuspensionML = (targetConc * targetVolume) / currentConc;
  return {
    cellSuspensionML: Number(cellSuspensionML.toFixed(2)),
    freshMediumML: Number((targetVolume - cellSuspensionML).toFixed(2)),
  };
}

// ─── 统计分析 ────────────────────────────────────────────────

export function calcMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function calcStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = calcMean(values);
  const sqDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / (values.length - 1));
}

export function calcCV(values: number[]): number {
  const mean = calcMean(values);
  if (mean === 0) return 0;
  return Number(((calcStdDev(values) / mean) * 100).toFixed(2));
}

export function calcRPD(val1: number, val2: number): number {
  const avg = (val1 + val2) / 2;
  if (avg === 0) return 0;
  return Number(((Math.abs(val1 - val2) / avg) * 100).toFixed(2));
}

// ─── 蛋白质浓度 ──────────────────────────────────────────────

export function calcProteinConc(
  absorbance: number,
  slope: number,
  intercept: number,
  dilution: number = 1
): number {
  return Number((((absorbance - intercept) / slope) * dilution).toFixed(3));
}

