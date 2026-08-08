/**
 * 123pan OpenAPI mirror script — 离线下载模式
 * - Auth via CLIENT_ID + CLIENT_SECRET → access_token
 * - 通过 Cloudflare 代理让 123 云盘服务器能访问 archive.org
 * - 提交离线下载任务 → 轮询完成 → 查找文件 → 分享 → 更新 index.json
 *
 * Required env vars:
 *   PAN123_CLIENT_ID     - 123pan OpenAPI client ID
 *   PAN123_CLIENT_SECRET - 123pan OpenAPI client secret
 *
 * Optional env vars:
 *   PAN123_DRY_RUN       - set to "1" to skip actual upload (test mode)
 *   PROXY_PREFIX         - Cloudflare proxy prefix (default: https://xz.zyt163.com/)
 *   OFFLINE_POLL_TIMEOUT - max poll time in minutes (default: 120)
 */

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE = "https://open-api.123pan.com";
const DRY_RUN = process.env.PAN123_DRY_RUN === "1";
const SHARES_FILE = "public/.shares.json";
const INDEX_FILE = "public/index.json";
const TARGET_FOLDER_NAME = "rmx3031刷机包";
const PROXY_PREFIX = (process.env.PROXY_PREFIX || "https://xz.zyt163.com/").replace(/\/+$/, "");
const POLL_TIMEOUT_MIN = parseInt(process.env.OFFLINE_POLL_TIMEOUT || "120", 10);
const MAX_RETRIES = 3;

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[offline] ${msg}`);
}

function warn(msg) {
  console.warn(`[offline:WARN] ${msg}`);
}

function error_(msg) {
  console.error(`[offline:ERROR] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── OpenAPI client ──────────────────────────────────────────────────────────

let accessToken = null;

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    Platform: "open_platform",
  };
}

async function apiPostRaw(path, body) {
  const url = API_BASE + path;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function apiPost(path, body) {
  const json = await apiPostRaw(path, body);
  if (json.code !== 0) {
    throw new Error(`API error ${path}: code=${json.code} message=${json.message || ""}`);
  }
  return json.data;
}

async function apiGet(path, params = {}) {
  const u = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  const res = await fetch(u.toString(), { headers: authHeaders() });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`API error ${path}: code=${json.code} message=${json.message || ""}`);
  }
  return json.data;
}

// ── Auth ────────────────────────────────────────────────────────────────────

async function login() {
  const clientId = process.env.PAN123_CLIENT_ID;
  const clientSecret = process.env.PAN123_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "请设置 PAN123_CLIENT_ID 和 PAN123_CLIENT_SECRET 环境变量。\n" +
      "在 https://www.123pan.com/open/ 注册开发者应用获取。"
    );
  }

  log("获取 access_token...");
  const res = await fetch(`${API_BASE}/api/v1/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Platform: "open_platform",
    },
    body: JSON.stringify({
      clientID: clientId,
      clientSecret: clientSecret,
    }),
  });

  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`获取token失败: code=${json.code} message=${json.message || ""}`);
  }

  accessToken = json.data.accessToken;
  log("access_token 获取成功");
}

// ── Folder management ───────────────────────────────────────────────────────

async function findOrCreateFolder() {
  const res = await apiGet("/api/v2/file/list", { parentFileId: 0, limit: 100 });
  const fileList = res.fileList || res.file_list || [];
  for (const item of fileList) {
    const name = item.filename || item.fileName || "";
    if (name === TARGET_FOLDER_NAME && (item.type === 1 || item.fileType === 1)) {
      log(`找到文件夹: "${TARGET_FOLDER_NAME}", id=${item.fileId || item.fileID}`);
      return item.fileId || item.fileID;
    }
  }

  log(`创建文件夹 "${TARGET_FOLDER_NAME}"...`);
  const data = await apiPost("/upload/v1/file/mkdir", {
    name: TARGET_FOLDER_NAME,
    parentID: 0,
  });
  log(`文件夹创建成功, id=${data.dirID}`);
  return data.dirID;
}

/** 在文件夹中查找文件 */
async function findFileInFolder(fileName, parentFileId) {
  const res = await apiGet("/api/v2/file/list", {
    parentFileId,
    limit: 100,
    searchData: fileName,
    searchMode: 1,
  });
  const fileList = res.fileList || res.file_list || [];
  for (const item of fileList) {
    const name = item.filename || item.fileName || "";
    if (name === fileName) {
      const id = item.fileId || item.fileID;
      if (id) return id;
    }
  }

  // fallback: 遍历列表
  const allRes = await apiGet("/api/v2/file/list", { parentFileId, limit: 100 });
  const allFiles = allRes.fileList || allRes.file_list || [];
  for (const item of allFiles) {
    const name = item.filename || item.fileName || "";
    if (name === fileName) {
      const id = item.fileId || item.fileID;
      if (id) return id;
    }
  }

  return null;
}

// ── Offline Download ────────────────────────────────────────────────────────

/**
 * 提交离线下载任务
 * 离线下载状态: 0=等待中, 1=下载中, 2=下载完成, 3=下载失败, 4=已取消
 */
async function submitOfflineDownload(url, fileName, folderId) {
  log(`  提交离线下载: ${fileName}`);
  const data = await apiPost("/api/v1/offline/download", {
    url: url,
    fileName: fileName,
    dirID: folderId,
  });
  log(`  离线任务已创建, taskID=${data.taskID}`);
  return data.taskID;
}

/**
 * 查询离线下载进度
 * Returns: { process: number(0-100), status: number }
 */
async function getOfflineProgress(taskID) {
  return await apiGet("/api/v1/offline/download/process", { taskID });
}

/**
 * 轮询等待离线下载完成
 */
async function waitForOfflineDownload(taskID, fileName) {
  const startTime = Date.now();
  const timeoutMs = POLL_TIMEOUT_MIN * 60 * 1000;
  let lastPct = -1;

  while (true) {
    const elapsed = (Date.now() - startTime) / 1000;

    if (elapsed * 1000 > timeoutMs) {
      throw new Error(`离线下载超时 (${POLL_TIMEOUT_MIN}分钟)`);
    }

    let progress;
    try {
      progress = await getOfflineProgress(taskID);
    } catch (err) {
      warn(`  查询进度失败: ${err.message}，5秒后重试...`);
      await sleep(5000);
      continue;
    }

    const pct = Math.round(progress.process || 0);

    // 只在进度变化时打印
    if (pct !== lastPct) {
      const statusNames = { 0: "等待中", 1: "下载中", 2: "已完成", 3: "失败", 4: "已取消" };
      const statusName = statusNames[progress.status] || `未知(${progress.status})`;
      const elapsedMin = Math.floor(elapsed / 60);
      const elapsedSec = Math.floor(elapsed % 60);
      log(`  离线进度: ${pct}% (${statusName}), 已等待 ${elapsedMin}分${elapsedSec}秒`);
      lastPct = pct;
    }

    // 状态 2 = 完成
    if (progress.status === 2) {
      log(`  离线下载完成!`);
      return;
    }

    // 状态 3 = 失败
    if (progress.status === 3) {
      throw new Error("离线下载失败");
    }

    // 状态 4 = 已取消
    if (progress.status === 4) {
      throw new Error("离线下载已取消");
    }

    // 大文件等待更久，小文件等待短一些
    await sleep(10000);
  }
}

async function waitForFileToAppear(fileName, folderId) {
  // 离线下载完成后文件可能不会立即可见，等待并搜索
  for (let attempt = 1; attempt <= 12; attempt++) {
    const fileId = await findFileInFolder(fileName, folderId);
    if (fileId) {
      return fileId;
    }
    log(`  等待文件出现... (${attempt}/12)`);
    await sleep(5000);
  }
  return null;
}

// ── Share ────────────────────────────────────────────────────────────────────

async function createShare(fileId, fileName) {
  if (DRY_RUN) {
    return { shareUrl: `https://www.123pan.com/s/dry_run`, shareKey: "dry_run" };
  }

  log(`  创建分享: fileId=${fileId}`);
  const data = await apiPost("/api/v1/share/create", {
    shareName: fileName,
    shareExpire: 0,
    fileIDList: String(fileId),
    sharePwd: "",
  });

  const shareUrl = data.shareUrl || data.share_url || `https://www.123pan.com/s/${data.shareKey || data.share_key}`;
  const shareKey = data.shareKey || data.share_key || "";
  return { shareUrl, shareKey };
}

// ── State ────────────────────────────────────────────────────────────────────

async function loadShares() {
  try { return JSON.parse(await readFile(SHARES_FILE, "utf8")); } catch { return {}; }
}

async function saveShares(data) {
  await mkdir("public", { recursive: true });
  await writeFile(SHARES_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function loadIndex() {
  return JSON.parse(await readFile(INDEX_FILE, "utf8"));
}

async function saveIndex(data) {
  await writeFile(INDEX_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ── Main ─────────────────────────────────────────────────────────────────────

function extractFilenameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop());
  } catch {
    return null;
  }
}

function flattenIndexEntries(indexData) {
  const result = [];
  for (const [category, value] of Object.entries(indexData)) {
    if (category.startsWith("_") || !Array.isArray(value)) continue;
    for (let i = 0; i < value.length; i++) {
      if (value[i] && value[i].url) {
        result.push({ entry: value[i], category, index: i });
      }
    }
  }
  return result;
}

async function main() {
  log("=== 123pan 离线下载 Mirror Script (批量模式) ===");
  log(`代理前缀: ${PROXY_PREFIX}`);
  log(`轮询超时: ${POLL_TIMEOUT_MIN} 分钟`);

  // 1. Auth
  await login();

  // 2. Find/create folder
  const folderId = await findOrCreateFolder();

  // 3. Load state
  const indexData = await loadIndex();
  const shares = await loadShares();
  const entries = flattenIndexEntries(indexData);

  log(`index.json: ${entries.length} 个文件`);
  log(`已处理: ${Object.keys(shares).length} 个\n`);

  // 4. Find pending files
  const pending = [];
  for (const { entry, category, index } of entries) {
    const filename = extractFilenameFromUrl(entry.url);
    if (!filename) continue;
    if (entry.url_123pan) continue;
    pending.push({ entry, category, index, filename });
  }

  if (pending.length === 0) {
    log("所有文件都已处理完毕！");
    return;
  }

  log(`待处理: ${pending.length} 个文件`);
  log("");

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1: 批量提交所有离线下载任务
  // ═══════════════════════════════════════════════════════════════════════════
  log("━━━ Phase 1: 批量提交离线下载 ━━━");

  const tasks = []; // { taskID, filename, entry, category, index, proxyUrl }

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const proxyUrl = `${PROXY_PREFIX}/${item.entry.url}`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 1) await sleep(3000);

        // 先检查是否已存在
        const existingId = await findFileInFolder(item.filename, folderId);
        if (existingId) {
          log(`[${i + 1}/${pending.length}] ${item.entry.name || item.filename} — 已存在云端, id=${existingId}`);
          tasks.push({ taskID: null, filename: item.filename, entry: item.entry, category: item.category, index: item.index, proxyUrl, fileId: existingId });
          break;
        }

        const taskID = await submitOfflineDownload(proxyUrl, item.filename, folderId);
        log(`[${i + 1}/${pending.length}] ${item.entry.name || item.filename} → taskID=${taskID}`);
        tasks.push({ taskID, filename: item.filename, entry: item.entry, category: item.category, index: item.index, proxyUrl });
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          error_(`[${i + 1}/${pending.length}] ✗ 提交失败: ${err.message}`);
          tasks.push({ taskID: null, filename: item.filename, entry: item.entry, category: item.category, index: item.index, proxyUrl, error: err.message });
        }
      }
    }
    await sleep(3000); // 间隔 3 秒
  }

  log(`\n已提交 ${tasks.filter(t => t.taskID || t.fileId).length}/${tasks.length} 个任务\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2: 等待全部下载完成
  // ═══════════════════════════════════════════════════════════════════════════
  log("━━━ Phase 2: 等待全部下载完成 ━━━");

  const activeTasks = tasks.filter(t => t.taskID && !t.fileId); // 只等真正需要下载的
  const startTime = Date.now();
  const timeoutMs = POLL_TIMEOUT_MIN * 60 * 1000;
  let lastSummaryPct = -1;

  while (activeTasks.length > 0) {
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed * 1000 > timeoutMs) {
      warn(`轮询超时 (${POLL_TIMEOUT_MIN}分钟)，剩余 ${activeTasks.length} 个任务未完成`);
      break;
    }

    let completed = 0;
    let downloading = 0;
    let waiting = 0;
    let activeFailed = 0;

    const stillActive = [];

    for (const task of activeTasks) {
      try {
        const progress = await getOfflineProgress(task.taskID);
        const pct = Math.round(progress.process || 0);

        if (progress.status === 2) {
          completed++;
          // 查找文件
          const fileId = await waitForFileToAppear(task.filename, folderId);
          if (fileId) {
            task.fileId = fileId;
            log(`  ✓ ${task.filename} — 下载完成, fileId=${fileId}`);
          } else {
            task.error = "下载完成但找不到文件";
            log(`  ✗ ${task.filename} — ${task.error}`);
          }
        } else if (progress.status === 3) {
          activeFailed++;
          task.error = "离线下载失败";
          log(`  ✗ ${task.filename} — ${task.error}`);
        } else if (progress.status === 4) {
          activeFailed++;
          task.error = "离线下载已取消";
          log(`  ✗ ${task.filename} — ${task.error}`);
        } else {
          // 状态 0(等待中) 或 1(下载中)
          if (progress.status === 0) waiting++;
          if (progress.status === 1) downloading++;
          stillActive.push(task);
        }
      } catch (err) {
        // 查询失败，保留在 active 中重试
        stillActive.push(task);
      }
      await sleep(200); // 避免请求太快
    }

    activeTasks.length = 0;
    activeTasks.push(...stillActive);

    // 汇总进度
    const totalDone = tasks.filter(t => t.fileId || t.error).length;
    const totalPct = Math.round((totalDone / tasks.length) * 100);
    if (totalPct !== lastSummaryPct) {
      const elapsedMin = Math.floor(elapsed / 60);
      const elapsedSec = Math.floor(elapsed % 60);
      log(`\n  总进度: ${totalDone}/${tasks.length} (${totalPct}%), 等待中:${waiting} 下载中:${downloading} 剩余:${activeTasks.length}, 已过 ${elapsedMin}分${elapsedSec}秒\n`);
      lastSummaryPct = totalPct;
    }

    if (activeTasks.length > 0) {
      await sleep(10000);
    }
  }

  log("\n━━━ Phase 3: 分享并更新资源站 ━━━\n");

  // 等待一段时间让服务器完成文件索引
  log("等待服务器处理文件索引...");
  await sleep(10000);

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 3: 分享所有成功下载的文件
  // ═══════════════════════════════════════════════════════════════════════════
  let success = 0;
  let failed = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    if (!task.fileId) {
      if (task.error) {
        error_(`[${i + 1}/${tasks.length}] ✗ ${task.entry.name || task.filename}: ${task.error}`);
      }
      failed++;
      continue;
    }

    // 分享（最多重试 6 次，每次间隔递增）
    let shareDone = false;
    let shareUrl = null;

    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        if (attempt > 1) {
          const waitSec = attempt * 5;
          log(`  等待 ${waitSec}s 后重试...`);
          await sleep(waitSec * 1000);
          // 重新查找最新的 fileId
          const freshId = await findFileInFolder(task.filename, folderId);
          if (freshId) {
            if (freshId !== task.fileId) {
              log(`  fileId 已更新: ${task.fileId} → ${freshId}`);
            }
            task.fileId = freshId;
          } else {
            warn(`  未找到文件 ${task.filename}，继续使用旧 ID`);
          }
        }

        const result = await createShare(task.fileId, task.filename);
        shareUrl = result.shareUrl;
        log(`[${i + 1}/${tasks.length}] ✓ ${task.entry.name || task.filename} → ${shareUrl}`);
        shareDone = true;
        break;
      } catch (err) {
        const msg = err.message || "";
        if (msg.includes("文件已被删除或移动") || msg.includes("分享ID非法")) {
          warn(`  文件尚未就绪 (${msg})，${attempt}/6`);
        } else {
          warn(`  分享失败: ${msg}`);
        }
        if (attempt === 6) {
          error_(`[${i + 1}/${tasks.length}] ✗ 分享失败 (已重试6次): ${msg}`);
        }
      }
    }

    if (!shareDone) {
      failed++;
      continue;
    }

    // 更新 index
    indexData[task.category][task.index].url_123pan = shareUrl;
    shares[String(task.fileId)] = { shareUrl, fileName: task.filename, sharedAt: new Date().toISOString() };
    success++;

    await sleep(500);
  }

  // Final save
  await saveShares(shares);
  await saveIndex(indexData);
  log("  [index.json 已更新]\n");

  log(`=== 完成: ${success} 成功, ${failed} 失败 ===`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  error_(`致命错误: ${err.message}`);
  process.exit(1);
});