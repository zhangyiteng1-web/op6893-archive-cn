/**
 * 123pan OpenAPI mirror script (官方文档对齐版)
 * - Uses official OpenAPI V2 (https://open-api.123pan.com)
 * - Auth via CLIENT_ID + CLIENT_SECRET → access_token
 * - Downloads from archive.org → uploads via OpenAPI V2 → creates share → updates index.json
 *
 * 官方文档: https://123yunpan.yuque.com/org-wiki-123yunpan-muaork/cr6ced
 * 注册获取凭证: https://www.123pan.com/open/
 *
 * Required env vars:
 *   PAN123_CLIENT_ID     - 123pan OpenAPI client ID
 *   PAN123_CLIENT_SECRET - 123pan OpenAPI client secret
 *
 * Optional env vars:
 *   PAN123_DRY_RUN       - set to "1" to skip actual upload (test mode)
 */

import { readFile, writeFile, stat, unlink, mkdir } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE = "https://open-api.123pan.com";
const DRY_RUN = process.env.PAN123_DRY_RUN === "1";
const SHARES_FILE = "public/.shares.json";
const INDEX_FILE = "public/index.json";
const TARGET_FOLDER_NAME = "rmx3031刷机包";
const MAX_RETRIES = 3;

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[openapi] ${msg}`);
}

function warn(msg) {
  console.warn(`[openapi:WARN] ${msg}`);
}

function error_(msg) {
  console.error(`[openapi:ERROR] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileSize(path) {
  return (await stat(path)).size;
}

function md5FromStream(stream) {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function md5FromFile(filePath) {
  return md5FromStream(createReadStream(filePath));
}

function md5FromBuffer(buf) {
  return createHash("md5").update(buf).digest("hex");
}

/** Read a byte range from a file (streaming, no full-file memory load) */
function readChunk(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = createReadStream(filePath, { start, end: end - 1 });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
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

async function apiPost(path, body) {
  const url = API_BASE + path;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const json = await res.json();
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

async function findFileInFolder(fileName, parentFileId) {
  const res = await apiGet("/api/v2/file/list", { parentFileId, limit: 100, searchData: fileName, searchMode: 1 });
  const fileList = res.fileList || res.file_list || [];
  for (const item of fileList) {
    const name = item.filename || item.fileName || "";
    if (name === fileName) return item.fileId || item.fileID;
  }
  return null;
}

// ── Upload (V2 API) ─────────────────────────────────────────────────────────

/**
 * Upload a file to 123pan via OpenAPI V2.
 * Uses streaming reads to avoid loading entire file into memory.
 * Returns fileID.
 */
async function uploadFile(filePath, fileName, parentFileId) {
  const size = await fileSize(filePath);
  const etag = await md5FromFile(filePath);

  log(`  上传 ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)...`);

  if (DRY_RUN) {
    log("  [DRY RUN] 跳过上传");
    return `dry_${Date.now()}`;
  }

  // Step 1: V2 Create upload
  const data = await apiPost("/upload/v2/file/create", {
    parentFileID: parentFileId,
    filename: fileName,
    etag: etag,
    size: size,
  });

  // 秒传：文件已存在
  if (data.reuse) {
    log("  文件已存在，秒传成功");
    if (data.fileID) return data.fileID;
    const existingId = await findFileInFolder(fileName, parentFileId);
    if (existingId) return existingId;
    return data.fileID;
  }

  const preuploadID = data.preuploadID;
  const sliceSize = data.sliceSize;
  const servers = data.servers || [];
  const uploadServer = (servers.length > 0 ? servers[0] : API_BASE).replace(/\/$/, "");

  // Step 2: Upload each slice via multipart form
  const totalParts = Math.ceil(size / sliceSize);

  for (let i = 1; i <= totalParts; i++) {
    const start = (i - 1) * sliceSize;
    const end = Math.min(start + sliceSize, size);

    // Read chunk and compute its MD5 (streaming, no full-file load)
    const chunk = await readChunk(filePath, start, end);
    const sliceMD5 = md5FromBuffer(chunk);

    // Build multipart form
    const form = new FormData();
    form.append("preuploadID", preuploadID);
    form.append("sliceNo", String(i));
    form.append("sliceMD5", sliceMD5);
    form.append("filename", fileName);
    form.append("slice", new Blob([chunk]), fileName);

    const sliceUrl = `${uploadServer}/upload/v2/file/slice`;
    const sliceRes = await fetch(sliceUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Platform: "open_platform",
      },
      body: form,
    });

    const sliceJson = await sliceRes.json();
    if (sliceJson.code !== 0) {
      throw new Error(`分片 ${i}/${totalParts} 上传失败: code=${sliceJson.code} message=${sliceJson.message || ""}`);
    }
  }

  // Step 3: Complete upload (poll until done)
  log(`  所有分片上传完成，等待服务器合并...`);
  for (let attempt = 1; attempt <= 60; attempt++) {
    await sleep(2000);
    try {
      const completeData = await apiPost("/upload/v2/file/upload_complete", { preuploadID });
      if (completeData.completed && completeData.fileID) {
        log(`  上传完成 fileId=${completeData.fileID}`);
        return completeData.fileID;
      }
    } catch (err) {
      // Keep polling — server may still be processing
    }
    if (attempt % 10 === 0) {
      log(`  等待合并中... (${attempt}/60)`);
    }
  }

  throw new Error("上传超时：60次轮询后仍未完成");
}

// ── Share ────────────────────────────────────────────────────────────────────

async function createShare(fileId, fileName) {
  if (DRY_RUN) {
    return { shareUrl: `https://www.123pan.com/s/dry_run`, shareKey: "dry_run" };
  }

  const data = await apiPost("/api/v1/share/create", {
    shareName: fileName,
    shareExpire: 0, // 0 = 永久有效
    fileIDList: [fileId],
    sharePwd: "",
  });

  const shareUrl = data.shareUrl || data.share_url || `https://www.123pan.com/s/${data.shareKey || data.share_key}`;
  const shareKey = data.shareKey || data.share_key || "";
  return { shareUrl, shareKey };
}

// ── Download ─────────────────────────────────────────────────────────────────

async function downloadFile(url, destPath) {
  if (DRY_RUN) {
    await writeFile(destPath, "dummy");
    return;
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载失败: ${res.status} ${res.statusText}`);
  }

  const fileStream = createWriteStream(destPath);
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(value);
  }

  fileStream.end();
  await new Promise((resolve) => fileStream.on("finish", resolve));
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
  log("=== 123pan OpenAPI V2 Mirror Script ===");

  // 1. Auth
  await login();

  // 2. Find/create folder
  const folderId = await findOrCreateFolder();

  // 3. Load state
  const indexData = await loadIndex();
  const shares = await loadShares();
  const entries = flattenIndexEntries(indexData);

  log(`index.json: ${entries.length} files`);
  log(`已分享: ${Object.keys(shares).length} files`);

  // 4. Find pending files
  const pending = [];
  for (const { entry, category, index } of entries) {
    const filename = extractFilenameFromUrl(entry.url);
    if (!filename) continue;
    if (entry.url_123pan) continue; // Already has share link
    pending.push({ entry, category, index, filename });
  }

  if (pending.length === 0) {
    log("所有文件都已处理完毕！");
    return;
  }

  log(`待处理: ${pending.length} 个文件\n`);

  const tmpDir = join(tmpdir(), "123pan-openapi-v2");
  await mkdir(tmpDir, { recursive: true });

  let success = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i++) {
    const { entry, category, index, filename } = pending[i];
    const tmpPath = join(tmpDir, filename);

    log(`[${i + 1}/${pending.length}] ${entry.name}`);
    let done = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 1) await sleep(attempt * 5000);

        // Download via archive.org
        await downloadFile(entry.url, tmpPath);

        const actualSize = await fileSize(tmpPath);
        if (actualSize === 0) throw new Error("下载文件大小为0");
        log(`  下载完成: ${(actualSize / 1024 / 1024).toFixed(1)}MB`);

        // Upload via OpenAPI V2
        const fileId = await uploadFile(tmpPath, filename, folderId);

        // Share
        const { shareUrl, shareKey } = await createShare(fileId, filename);
        log(`  分享链接: ${shareUrl}`);

        // Update index
        indexData[category][index].url_123pan = shareUrl;
        indexData[category][index].url_original = entry.url;
        shares[String(fileId)] = { shareUrl, shareKey, fileName: filename, sharedAt: new Date().toISOString() };

        success++;
        done = true;
        break;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          warn(`  重试 ${attempt}/${MAX_RETRIES}: ${err.message}`);
        } else {
          error_(`  ✗ 失败: ${err.message}`);
        }
      } finally {
        try { await unlink(tmpPath); } catch { /* ignore */ }
      }
    }

    if (!done) failed++;

    // Save progress every 3 files
    if ((i + 1) % 3 === 0) {
      await saveShares(shares);
      await saveIndex(indexData);
      log("  [已保存进度]\n");
    }

    await sleep(1000);
  }

  // Final save
  await saveShares(shares);
  await saveIndex(indexData);

  log(`\n=== 完成: ${success} 成功, ${failed} 失败 ===`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  error_(`致命错误: ${err.message}`);
  process.exit(1);
});