/**
 * 本地下载+上传+分享脚本
 * - 通过代理下载 archive.org 文件（国内可访问）
 * - 上传到123云盘
 * - 创建分享链接
 * - 更新 index.json
 *
 * 用法:
 *   set PAN123_TOKEN=你的token
 *   node scripts/local-download-and-share.js
 *
 * 可选环境变量:
 *   PROXY_URL  - 代理地址（默认 https://xz.zyt163.com/）
 *   SKIP_EXISTING - 设为1跳过云盘已存在的文件
 */

import { readFile, writeFile, stat, unlink, mkdir } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = "https://www.123pan.cn";
const INDEX_FILE = "public/index.json";
const SHARES_FILE = "public/.shares.json";
const TARGET_FOLDER_NAME = "rmx3031刷机包";
const PROXY_URL = (process.env.PROXY_URL || "https://xz.zyt163.com/").replace(/\/?$/, "/");
const SKIP_EXISTING = process.env.SKIP_EXISTING === "1";
const CHUNK_SIZE = 8 * 1024 * 1024;
const SMALL_FILE_THRESHOLD = 100 * 1024 * 1024;
const MAX_RETRIES = 3;

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[local] ${msg}`);
}

function warn(msg) {
  console.warn(`[local:WARN] ${msg}`);
}

function error(msg) {
  console.error(`[local:ERROR] ${msg}`);
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

// ── 123pan API client ───────────────────────────────────────────────────────

let authToken = null;

function headers() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
    Origin: "https://yun.123pan.cn",
    Referer: "https://yun.123pan.cn/",
    Platform: "web",
    "App-Version": "3",
  };
}

async function apiPost(url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers(), ...extraHeaders },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.code !== 0 && json.code !== 200) {
    throw new Error(`API error ${url}: code=${json.code} message=${json.message || ""}`);
  }
  return json;
}

async function apiGet(url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, String(v));
  }
  const res = await fetch(u.toString(), { headers: headers() });
  const json = await res.json();
  if (json.code !== 0 && json.code !== 200) {
    throw new Error(`API error ${url}: code=${json.code} message=${json.message || ""}`);
  }
  return json;
}

// ── Login ───────────────────────────────────────────────────────────────────

async function validateToken() {
  const endpoints = [
    { url: `${BASE_URL}/a/api/user/info`, method: "GET" },
    { url: `${BASE_URL}/b/api/file/list/new?driveId=0&parentFileId=0&limit=1`, method: "GET" },
  ];

  log("Validating token...");

  for (const { url, method } of endpoints) {
    try {
      const res = await fetch(url, { method, headers: headers() });
      const json = await res.json();
      if (json.code === 0 || json.code === 200) {
        log("Token is valid");
        return true;
      }
    } catch { /* continue */ }
  }

  return false;
}

async function login() {
  let token = process.env.PAN123_TOKEN;
  if (!token) {
    throw new Error("请设置 PAN123_TOKEN 环境变量。从 get-token.html 页面获取Token。");
  }

  token = token.replace(/^Bearer\s+/i, "").trim();
  authToken = token;

  const valid = await validateToken();
  if (!valid) {
    throw new Error("Token验证失败。请重新获取Token。");
  }
}

// ── Folder management ───────────────────────────────────────────────────────

function listParams(parentFileId, opts = {}) {
  return {
    driveId: 0,
    parentFileId: String(parentFileId),
    limit: opts.limit || 100,
    orderBy: "file_id",
    orderDirection: "desc",
    trashed: false,
    Page: String(opts.page || 1),
    SearchData: opts.searchData || "",
    searchType: opts.searchType || 0,
    OnlyLookAbnormalFile: 0,
  };
}

function extractItems(res) {
  return res.data?.InfoList || res.data?.fileList || res.data?.infoList || [];
}

function itemName(item) {
  return item.FileName || item.fileName || item.filename || "";
}

function itemId(item) {
  return item.FileId || item.fileId || item.fileID || 0;
}

function itemType(item) {
  return item.Type !== undefined ? item.Type : item.type;
}

async function findOrCreateFolder() {
  // Search by name
  try {
    const res = await apiGet(`${BASE_URL}/b/api/file/list/new`, listParams(0, {
      searchData: TARGET_FOLDER_NAME,
      searchType: 1,
    }));
    const items = extractItems(res);
    for (const item of items) {
      if (itemName(item) === TARGET_FOLDER_NAME && itemType(item) === 1) {
        return itemId(item);
      }
    }
  } catch { /* fall through */ }

  // Paginate
  for (let page = 1; page <= 10; page++) {
    const res = await apiGet(`${BASE_URL}/b/api/file/list/new`, listParams(0, { page }));
    const items = extractItems(res);
    if (!items.length) break;
    for (const item of items) {
      if (itemName(item) === TARGET_FOLDER_NAME && itemType(item) === 1) {
        return itemId(item);
      }
    }
    if (items.length < 100) break;
  }

  // Create
  const mkdirEndpoints = [
    { url: `${BASE_URL}/b/api/file/newFolder`, body: { driveId: 0, parentFileId: 0, folderName: TARGET_FOLDER_NAME } },
    { url: `${BASE_URL}/b/api/file/mkdir`, body: { driveId: 0, name: TARGET_FOLDER_NAME, parentFileId: 0 } },
  ];

  for (const { url, body } of mkdirEndpoints) {
    try {
      const res = await apiPost(url, body);
      const id = res.data?.fileId || res.data?.fileID || res.data?.FileId;
      if (id) return id;
    } catch { /* next */ }
  }

  throw new Error(`Failed to find or create folder "${TARGET_FOLDER_NAME}"`);
}

async function findFileInFolder(fileName, parentFileId) {
  try {
    const res = await apiGet(`${BASE_URL}/b/api/file/list/new`, listParams(parentFileId, {
      searchData: fileName,
      searchType: 1,
    }));
    for (const item of extractItems(res)) {
      if (itemName(item) === fileName) return itemId(item);
    }
  } catch { /* fall through */ }

  for (let page = 1; page <= 10; page++) {
    const res = await apiGet(`${BASE_URL}/b/api/file/list/new`, listParams(parentFileId, { page }));
    const items = extractItems(res);
    if (!items.length) break;
    for (const item of items) {
      if (itemName(item) === fileName) return itemId(item);
    }
    if (items.length < 100) break;
  }
  return null;
}

// ── Upload ───────────────────────────────────────────────────────────────────

async function uploadRequest(fileName, etag, size, parentFileId) {
  return apiPost(`${BASE_URL}/b/api/file/upload_request`, {
    driveId: 0, etag, fileName, parentFileId, size, type: 0, duplicate: 0,
  });
}

async function uploadComplete(fileId) {
  return apiPost(`${BASE_URL}/b/api/file/upload_complete`, { fileId });
}

async function s3PrepareUploadParts(bucket, key, uploadId, storageNode, start, end) {
  return apiPost(`${BASE_URL}/b/api/file/s3_repare_upload_parts_batch`, {
    bucket, key, partNumberEnd: end, partNumberStart: start, uploadId, storageNode,
  });
}

async function s3CompleteMultipartUpload(bucket, key, uploadId, storageNode) {
  return apiPost(`${BASE_URL}/b/api/file/s3_complete_multipart_upload`, {
    bucket, key, uploadId, storageNode,
  });
}

async function uploadBatch(batch, bucket, key, uploadId, storageNode) {
  const start = batch[0].partNumber;
  const end = batch[batch.length - 1].partNumber;
  const partsRes = await s3PrepareUploadParts(bucket, key, uploadId, storageNode, start, end);
  const presignedUrls = partsRes.data?.presignedUrls;
  if (!presignedUrls) throw new Error(`No presigned URLs for parts ${start}-${end}`);

  await Promise.all(batch.map(async (chunk) => {
    const url = presignedUrls[String(chunk.partNumber)] || presignedUrls[chunk.partNumber - 1];
    if (!url) throw new Error(`No presigned URL for part ${chunk.partNumber}`);
    const putRes = await fetch(url, {
      method: "PUT", body: chunk.data,
      headers: { "Content-Type": "application/octet-stream" },
    });
    if (!putRes.ok) throw new Error(`PUT part ${chunk.partNumber} failed: ${putRes.status}`);
  }));
}

async function uploadFile(filePath, fileName, parentFileId) {
  const size = await fileSize(filePath);
  const etag = await md5FromFile(filePath);

  log(`  上传 ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)...`);

  let reqRes = await uploadRequest(fileName, etag, size, parentFileId);

  if (reqRes.data.Reuse) {
    let fileId = reqRes.data.FileId;
    if (!fileId || fileId === 0) {
      fileId = await findFileInFolder(fileName, parentFileId);
    }
    if (fileId && fileId !== 0) {
      log(`  文件已存在 (fileId=${fileId})`);
      return { fileId, fileName };
    }
    // Force fresh upload
    reqRes = await apiPost(`${BASE_URL}/b/api/file/upload_request`, {
      driveId: 0, etag, fileName, parentFileId, size, type: 0, duplicate: 1,
    });
    if (reqRes.data.Reuse) throw new Error(`Still got Reuse after forcing duplicate=1`);
  }

  const { Bucket: bucket, StorageNode: storageNode, Key: key, UploadId: uploadId, FileId: fileId } = reqRes.data;

  if (size === 0) {
    await uploadComplete(fileId);
    return { fileId, fileName };
  }

  if (size <= SMALL_FILE_THRESHOLD) {
    const partsRes = await s3PrepareUploadParts(bucket, key, uploadId, storageNode, 1, 1);
    const presignedUrl = partsRes.data?.presignedUrls?.["1"] || partsRes.data?.presignedUrls?.[0];
    if (!presignedUrl) throw new Error("No presigned URL for small file upload");

    const fileBuffer = await readFile(filePath);
    const putRes = await fetch(presignedUrl, {
      method: "PUT", body: fileBuffer,
      headers: { "Content-Type": "application/octet-stream" },
    });
    if (!putRes.ok) throw new Error(`PUT failed: ${putRes.status}`);
  } else {
    const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
    let partNumber = 0;
    let batch = [];

    for await (const chunk of stream) {
      partNumber++;
      batch.push({ data: chunk, partNumber, size: chunk.length });
      if (batch.length >= 10) {
        await uploadBatch(batch, bucket, key, uploadId, storageNode);
        batch = [];
      }
    }
    if (batch.length > 0) {
      await uploadBatch(batch, bucket, key, uploadId, storageNode);
    }
    await s3CompleteMultipartUpload(bucket, key, uploadId, storageNode);
    await sleep(3000);
  }

  for (let retry = 1; retry <= 3; retry++) {
    try {
      await uploadComplete(fileId);
      break;
    } catch (err) {
      if (retry < 3 && err.message.includes("5053")) {
        await sleep(3000);
      } else {
        throw err;
      }
    }
  }

  return { fileId, fileName };
}

// ── Share ────────────────────────────────────────────────────────────────────

async function createShare(fileId, fileName) {
  const res = await apiPost(`${BASE_URL}/a/api/share/create`, {
    driveId: 0,
    expiration: "2099-12-31T23:59:59+08:00",
    fileIdList: String(fileId),
    shareName: fileName,
    sharePwd: "",
  });

  const shareKey = res.data?.ShareKey;
  if (!shareKey) throw new Error(`Share creation returned no ShareKey: ${JSON.stringify(res)}`);
  return { shareUrl: `https://www.123pan.com/s/${shareKey}`, shareKey };
}

// ── Download ─────────────────────────────────────────────────────────────────

async function downloadFile(url, destPath) {
  const proxyUrl = PROXY_URL + url;
  log(`  下载: ${proxyUrl}`);

  const res = await fetch(proxyUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

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
  log("=== 本地下载+上传+分享脚本 ===");
  log(`代理: ${PROXY_URL}`);
  log("");

  // 1. Login
  await login();

  // 2. Find/create folder
  const folderId = await findOrCreateFolder();
  log(`目标文件夹 ID: ${folderId}`);

  // 3. Load state
  const indexData = await loadIndex();
  const shares = await loadShares();
  const entries = flattenIndexEntries(indexData);

  log(`index.json 共 ${entries.length} 个文件`);
  log(`已分享: ${Object.keys(shares).length} 个`);
  log("");

  // 4. Find files not yet processed
  const pending = [];
  for (const { entry, category, index } of entries) {
    const filename = extractFilenameFromUrl(entry.url);
    if (!filename) continue;

    // Check if already has url_123pan
    if (entry.url_123pan) {
      log(`  ✓ 已有分享: ${entry.name}`);
      continue;
    }

    pending.push({ entry, category, index, filename });
  }

  if (pending.length === 0) {
    log("所有文件都已处理完毕！");
    return;
  }

  log(`待处理: ${pending.length} 个文件`);
  log("");

  const tmpDir = join(tmpdir(), "123pan-local");
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

        // Download via proxy
        await downloadFile(entry.url, tmpPath);

        const actualSize = await fileSize(tmpPath);
        if (actualSize === 0) throw new Error("下载文件大小为0");
        log(`  下载完成: ${(actualSize / 1024 / 1024).toFixed(1)}MB`);

        // Upload
        const { fileId } = await uploadFile(tmpPath, filename, folderId);

        // Share
        const { shareUrl, shareKey } = await createShare(fileId, filename);
        log(`  分享链接: ${shareUrl}`);

        // Update
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
          error(`  ✗ 失败: ${err.message}`);
        }
      } finally {
        try { await unlink(tmpPath); } catch { /* ignore */ }
      }
    }

    if (!done) failed++;

    // Save state every 3 files
    if ((i + 1) % 3 === 0) {
      await saveShares(shares);
      await saveIndex(indexData);
      log(`  [已保存进度]`);
    }

    // Delay between files
    await sleep(1000);
  }

  // Final save
  await saveShares(shares);
  await saveIndex(indexData);

  log(`\n=== 完成: ${success} 成功, ${failed} 失败 ===`);
}

main().catch((err) => {
  error(`致命错误: ${err.message}`);
  process.exit(1);
});