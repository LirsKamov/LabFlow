/**
 * 数据导出服务
 *
 * 支持：PDF 报告 / Excel 数据表 / ZIP 归档
 */

import * as SQLite from "expo-sqlite";
import * as FileSystem from "expo-file-system";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import type { Experiment, SopStep, Record, Sample, Kit, KitComponent, RecordImage, Annotation } from "../db/schema";

const EXPORT_DIR = `${FileSystem.documentDirectory}exports/`;

async function ensureExportDir() {
  const info = await FileSystem.getInfoAsync(EXPORT_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true });
}

async function imageToBase64(path: string): Promise<string> {
  try {
    return await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.Base64 });
  } catch { return ""; }
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function nowCN(): string {
  return new Date().toLocaleString("zh-CN");
}

// ════════════════════════════════════════════════════════════
// PDF 报告
// ════════════════════════════════════════════════════════════

function buildExperimentHTML(
  exp: Experiment & { project_name?: string; kit_name?: string },
  steps: SopStep[],
  records: Record[],
  images: RecordImage[],
  samples: (Sample & { project_name?: string })[],
  sampleLogs: any[]
): string {
  const statusLabels: Record<string, string> = {
    planned: "已安排", in_progress: "进行中", completed: "已完成",
    paused: "已暂停", cancelled: "已取消",
  };

  // ── Build step rows ──
  const stepRows = steps
    .map(
      (s) => `
    <tr>
      <td style="text-align:center;font-weight:bold;color:#2563eb;">${s.step_num}</td>
      <td style="font-weight:bold;">${s.title}</td>
      <td>${s.description || ""}</td>
      <td style="text-align:center;">${s.duration_min}min</td>
      <td style="text-align:center;color:${s.completed === 1 ? "#10b981" : "#9ca3af"};">
        ${s.completed === 1 ? "✓ 已完成" : "○ 未完成"}
        ${s.completed_at ? `<br/><small>${s.completed_at}</small>` : ""}
      </td>
      <td>${s.notes || ""}</td>
    </tr>`
    )
    .join("\n");

  // ── Build image blocks ──
  const imageBlocks = images
    .map((img) => {
      const annotations: Annotation[] = (() => { try { return JSON.parse(img.annotations_json || "[]"); } catch { return []; } })();
      const hasAnnotation = annotations.length > 0;
      return `
    <div style="margin-bottom:16px;page-break-inside:avoid;">
      <p style="font-size:11px;color:#6b7280;margin-bottom:4px;">${img.caption || "图片"}</p>
      <img src="data:image/jpeg;base64,${"[[IMG_" + img.id + "]]"}" style="max-width:100%;border-radius:8px;" />
      ${hasAnnotation ? `<p style="font-size:10px;color:#f59e0b;margin-top:2px;">🏷 已标注 (${annotations.length} 处)</p>` : ""}
    </div>`;
    })
    .join("\n");

  // ── Build sample table ──
  const sampleRows = samples
    .map(
      (s) => `
    <tr>
      <td>${s.name}</td>
      <td>${s.type}</td>
      <td>${s.volume_ul} μL</td>
      <td>${s.concentration ? s.concentration + " " + s.concentration_unit : "-"}</td>
      <td style="font-size:10px;">${s.location_json || "-"}</td>
    </tr>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @page { size: A4; margin: 20mm; }
  body { font-family: -apple-system, 'Microsoft YaHei', sans-serif; color: #1f2937; font-size: 12px; line-height: 1.6; }
  h1 { font-size: 22px; color: #1e40af; margin-bottom: 4px; }
  h2 { font-size: 16px; color: #374151; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; margin-top: 20px; }
  h3 { font-size: 14px; color: #4b5563; margin-top: 16px; }
  .cover { text-align: center; padding: 60px 0; }
  .cover h1 { font-size: 28px; }
  .cover .subtitle { font-size: 18px; color: #6b7280; margin: 8px 0; }
  .watermark { position: fixed; bottom: 20mm; right: 20mm; font-size: 12px; color: #e5e7eb; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; font-size: 11px; }
  th { background: #f3f4f6; padding: 6px 8px; text-align: left; font-weight: 600; border-bottom: 2px solid #d1d5db; }
  td { padding: 5px 8px; border-bottom: 1px solid #f3f4f6; }
  .footer { position: fixed; bottom: 15mm; right: 20mm; font-size: 10px; color: #9ca3af; }
  .page-break { page-break-before: always; }
</style>
</head>
<body>

<!-- Cover -->
<div class="cover">
  <h1>${exp.name}</h1>
  <p class="subtitle">${exp.project_name ? "项目：" + exp.project_name : ""}</p>
  <p style="color:#9ca3af;">${exp.scheduled_date} · 状态：${statusLabels[exp.status] || exp.status}</p>
</div>

<div class="watermark">LabFlow Report</div>
<div class="footer">页码 <span class="pageNumber"></span> / <span class="totalPages"></span> · 生成于 ${nowCN()}</div>

<div class="page-break"></div>

<!-- Info table -->
<h2>实验信息</h2>
<table>
  <tr><th style="width:120px;">项目</th><td>${exp.project_name || "-"}</td></tr>
  <tr><th>状态</th><td>${statusLabels[exp.status] || exp.status}</td></tr>
  <tr><th>日期</th><td>${exp.scheduled_date}${exp.scheduled_time ? " " + exp.scheduled_time : ""}</td></tr>
  <tr><th>试剂盒</th><td>${exp.kit_name || "无"}</td></tr>
  <tr><th>描述</th><td>${exp.description || "-"}</td></tr>
</table>

<!-- SOP Steps -->
<h2>SOP 执行记录 (${steps.length} 步)</h2>
<table>
  <thead><tr><th style="width:30px;">#</th><th>标题</th><th>描述</th><th style="width:50px;">计划</th><th style="width:80px;">状态</th><th>备注</th></tr></thead>
  <tbody>${stepRows}</tbody>
</table>

<!-- Result records -->
<h2>结果记录</h2>
${records.length === 0 ? '<p style="color:#9ca3af;">无文字记录</p>' : records.map((r) => `<div style="background:#f9fafb;padding:12px;border-radius:8px;margin-bottom:8px;"><p style="font-weight:bold;margin:0;">${r.title || "无标题"}</p><p style="margin:4px 0;white-space:pre-wrap;">${r.content}</p><small style="color:#9ca3af;">${r.created_at}</small></div>`).join("\n")}

<!-- Images -->
${images.length > 0 ? '<h2>图片 (' + images.length + ')</h2>' + imageBlocks : ""}

<!-- Samples -->
${samples.length > 0 ? '<h2>关联样品</h2><table><thead><tr><th>名称</th><th>类型</th><th>量</th><th>浓度</th><th>位置</th></tr></thead><tbody>' + sampleRows + '</tbody></table>' : ""}

</body>
</html>`;
}

export async function generateExperimentReport(
  experimentId: number
): Promise<string> {
  await ensureExportDir();
  const db = await SQLite.openDatabaseAsync("labflow.db");

  // Fetch all data
  const exp = await db.getFirstAsync<any>(
    `SELECT e.*, p.name AS project_name, k.name AS kit_name
     FROM experiments e LEFT JOIN projects p ON e.project_id = p.id LEFT JOIN kits k ON e.kit_id = k.id
     WHERE e.id = ?`, [experimentId]
  );
  if (!exp) throw new Error("实验不存在");

  const steps = await db.getAllAsync<SopStep>(
    "SELECT * FROM sop_steps WHERE experiment_id = ? ORDER BY step_num ASC", [experimentId]
  );
  const records = await db.getAllAsync<Record>(
    "SELECT * FROM records WHERE experiment_id = ? ORDER BY created_at ASC", [experimentId]
  );
  const images = await db.getAllAsync<RecordImage>(
    "SELECT ri.* FROM record_images ri JOIN records r ON ri.record_id = r.id WHERE r.experiment_id = ?", [experimentId]
  );
  const samples = await db.getAllAsync<any>(
    "SELECT s.* FROM samples s WHERE s.source_experiment_id = ?", [experimentId]
  );

  // Build HTML
  let html = buildExperimentHTML(exp, steps, records, images, samples, []);

  // Replace image placeholders with base64
  for (const img of images) {
    const b64 = await imageToBase64(img.original_path);
    html = html.replace(`[[IMG_${img.id}]]`, b64);
  }

  // Print to file
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  const safeName = exp.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "_").slice(0, 40);
  const destPath = `${EXPORT_DIR}report_${safeName}_${todayStr()}.pdf`;
  await FileSystem.moveAsync({ from: uri, to: destPath });

  return destPath;
}

// ════════════════════════════════════════════════════════════
// Excel 导出
// ════════════════════════════════════════════════════════════

export async function generateExcelExport(
  scope: "all" | { projectId: number }
): Promise<string> {
  await ensureExportDir();
  const db = await SQLite.openDatabaseAsync("labflow.db");

  let expFilter = "";
  const params: any[] = [];
  if (typeof scope === "object") {
    expFilter = "WHERE e.project_id = ?";
    params.push(scope.projectId);
  }

  // Sheet 1: Experiments
  const expRows = await db.getAllAsync<any>(
    `SELECT e.id, p.name AS project_name, e.name, e.scheduled_date, e.status, k.name AS kit_name,
            (SELECT COUNT(*) FROM sop_steps s WHERE s.experiment_id = e.id) AS step_count
     FROM experiments e LEFT JOIN projects p ON e.project_id = p.id LEFT JOIN kits k ON e.kit_id = k.id
     ${expFilter} ORDER BY e.scheduled_date DESC`, params
  );

  const wb = XLSX.utils.book_new();

  // Sheet1
  const sheet1Data = [["ID", "项目", "实验名", "日期", "状态", "试剂盒", "步骤数"]];
  expRows.forEach((r: any) => sheet1Data.push([r.id, r.project_name || "", r.name, r.scheduled_date, r.status, r.kit_name || "", r.step_count]));
  const ws1 = XLSX.utils.aoa_to_sheet(sheet1Data);
  XLSX.utils.book_append_sheet(wb, ws1, "实验列表");

  // Sheet 2: Steps
  const allSteps = await db.getAllAsync<any>(
    `SELECT s.experiment_id, s.step_num, s.title, s.duration_min, s.completed_at, s.notes, s.completed
     FROM sop_steps s JOIN experiments e ON s.experiment_id = e.id ${expFilter.replace("e.", "e.")} ORDER BY s.experiment_id, s.step_num`, params
  );
  const sheet2Data = [["实验ID", "步骤号", "标题", "计划时长", "完成时间", "备注", "是否完成"]];
  allSteps.forEach((s: any) => sheet2Data.push([s.experiment_id, s.step_num, s.title, s.duration_min, s.completed_at || "", s.notes || "", s.completed === 1 ? "是" : "否"]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet2Data), "步骤记录");

  // Sheet 3: Samples
  const allSamples = await db.getAllAsync<any>("SELECT * FROM samples ORDER BY created_at DESC");
  const sheet3Data = [["ID", "名称", "类型", "浓度", "剩余量μL", "存储位置", "来源实验", "创建日期", "状态"]];
  allSamples.forEach((s: any) => sheet3Data.push([s.id, s.name, s.type, s.concentration + " " + s.concentration_unit, s.volume_ul, s.location_json, s.source_experiment_id || "", s.created_at, s.status]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet3Data), "样品库");

  // Sheet 4: Kit Inventory
  const kitComps = await db.getAllAsync<any>("SELECT k.name AS kit_name, kc.name, kc.initial_qty, kc.current_qty, kc.unit, kc.low_threshold FROM kit_components kc JOIN kits k ON kc.kit_id = k.id ORDER BY k.name");
  const sheet4Data = [["试剂盒", "组分", "初始量", "当前量", "单位", "低量阈值"]];
  kitComps.forEach((c: any) => sheet4Data.push([c.kit_name, c.name, c.initial_qty, c.current_qty, c.unit, c.low_threshold]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet4Data), "试剂盒库存");

  // Sheet 5: Usage Logs
  const logs = await db.getAllAsync<any>(
    "SELECT ul.used_at, k.name AS kit_name, kc.name AS comp_name, ul.used_qty, e.name AS exp_name FROM usage_logs ul JOIN kit_components kc ON ul.component_id = kc.id JOIN kits k ON ul.kit_id = k.id LEFT JOIN experiments e ON ul.experiment_id = e.id ORDER BY ul.used_at DESC LIMIT 500"
  );
  const sheet5Data = [["日期", "试剂盒", "组分", "消耗量", "关联实验"]];
  logs.forEach((l: any) => sheet5Data.push([l.used_at, l.kit_name, l.comp_name, l.used_qty, l.exp_name || ""]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet5Data), "用量日志");

  // Auto-fit columns
  const autoFit = (ws: XLSX.WorkSheet) => {
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
    for (let c = range.s.c; c <= range.e.c; c++) {
      let maxLen = 10;
      for (let r = range.s.r; r <= range.e.r; r++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell?.v) maxLen = Math.max(maxLen, String(cell.v).length);
      }
      ws["!cols"] = ws["!cols"] || [];
      ws["!cols"][c] = { wch: Math.min(maxLen + 3, 40) };
    }
  };
  [ws1].forEach(autoFit);

  // Freeze first row
  [ws1].forEach((ws) => { ws["!freeze"] = { xsplit: 0, ysplit: 1, topLeftCell: "A2", activePane: "bottomLeft" }; });

  const wbout = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
  const destPath = `${EXPORT_DIR}labflow_export_${todayStr()}.xlsx`;
  await FileSystem.writeAsStringAsync(destPath, wbout, { encoding: FileSystem.EncodingType.Base64 });

  return destPath;
}

// ════════════════════════════════════════════════════════════
// ZIP 归档
// ════════════════════════════════════════════════════════════

export async function generateZipExport(
  experimentIds: number[],
  includeImages: boolean = true
): Promise<string> {
  await ensureExportDir();
  const zip = new JSZip();

  // 1. PDF reports per experiment
  for (const eid of experimentIds) {
    try {
      const pdfPath = await generateExperimentReport(eid);
      const pdfBase64 = await FileSystem.readAsStringAsync(pdfPath, { encoding: FileSystem.EncodingType.Base64 });
      const exp = await (await SQLite.openDatabaseAsync("labflow.db")).getFirstAsync<{ name: string }>("SELECT name FROM experiments WHERE id = ?", [eid]);
      const safeName = (exp?.name || `experiment_${eid}`).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "_").slice(0, 40);
      zip.file(`reports/${safeName}.pdf`, pdfBase64, { base64: true });
    } catch {}
  }

  // 2. Excel
  try {
    const xlsxPath = await generateExcelExport("all");
    const xlsxBase64 = await FileSystem.readAsStringAsync(xlsxPath, { encoding: FileSystem.EncodingType.Base64 });
    zip.file("data/labflow_data.xlsx", xlsxBase64, { base64: true });
  } catch {}

  // 3. Images (optional)
  if (includeImages) {
    const db = await SQLite.openDatabaseAsync("labflow.db");
    for (const eid of experimentIds) {
      const exp = await db.getFirstAsync<{ name: string }>("SELECT name FROM experiments WHERE id = ?", [eid]);
      const safeExp = (exp?.name || `exp_${eid}`).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "_").slice(0, 30);
      const images = await db.getAllAsync<RecordImage>(
        "SELECT ri.* FROM record_images ri JOIN records r ON ri.record_id = r.id WHERE r.experiment_id = ?", [eid]
      );
      for (const img of images) {
        try {
          const b64 = await imageToBase64(img.original_path);
          zip.file(`images/originals/${safeExp}/${img.id}.jpg`, b64, { base64: true });
          if (img.annotated_path) {
            const ab64 = await imageToBase64(img.annotated_path);
            zip.file(`images/annotated/${safeExp}/${img.id}_annotated.png`, ab64, { base64: true });
          }
        } catch {}
      }
    }
  }

  // 4. Raw JSON
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const rawExps = await db.getAllAsync<any>("SELECT * FROM experiments WHERE id IN (" + experimentIds.join(",") + ")");
  zip.file("raw/experiments.json", JSON.stringify(rawExps, null, 2));

  const zipBase64 = await zip.generateAsync({ type: "base64" });
  const destPath = `${EXPORT_DIR}labflow_${todayStr()}.zip`;
  await FileSystem.writeAsStringAsync(destPath, zipBase64, { encoding: FileSystem.EncodingType.Base64 });

  return destPath;
}

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

/** 分享文件 */
export async function shareFile(filePath: string): Promise<void> {
  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) throw new Error("当前设备不支持分享");
  await Sharing.shareAsync(filePath);
}

/** 列出导出文件 */
export async function listExportedFiles(): Promise<{ name: string; path: string; size: number; date: string }[]> {
  try {
    await ensureExportDir();
    const files = await FileSystem.readDirectoryAsync(EXPORT_DIR);
    const result = [];
    for (const name of files) {
      const path = EXPORT_DIR + name;
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists && 'size' in info) {
        result.push({ name, path, size: info.size || 0, date: info.modificationTime ? new Date(info.modificationTime * 1000).toLocaleString("zh-CN") : "" });
      }
    }
    return result.sort((a, b) => b.date.localeCompare(a.date));
  } catch { return []; }
}

/** 删除导出文件 */
export async function deleteExportedFile(path: string): Promise<void> {
  await FileSystem.deleteAsync(path, { idempotent: true });
}
