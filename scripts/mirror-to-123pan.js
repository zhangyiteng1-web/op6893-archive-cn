/**
 * 123pan mirror script
 * - Authenticates via pre-obtained Bearer token (PAN123_TOKEN) or phone+password login
 * - Reads public/index.json and compares with public/.mirrored.json
 * - Downloads new files from archive.org → uploads to 123pan → creates share link
 * - Replaces download URLs in index.json with 123pan share links
 *
 * Required env vars (one of):
 *   PAN123_TOKEN    - 123pan Bearer token (preferred, avoids verification code)
 *
 * Fallback env vars (if no token):
 *   PAN123_PHONE    - 123pan account phone number
 *   PAN123_PASSWORD - 123pan account password
 *
 * Optional env vars:
 *   PAN123_MAX_SIZE_MB - skip files larger than this (default: 0 = no limit)
 *   PAN123_DRY_RUN     - set to "1" to skip actual upload (test mode)
 */

import { readFile, writeFile, stat, unlink, mkdir } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = "https://www.123pan.cn";
const USER_API = "https://user.123pan.cn";
const MAX_SIZE_MB = parseInt(process.env.PAN123_MAX_SIZE_MB || "0", 10); // 0 = no limit
const DRY_RUN = process.env.PAN123_DRY_RUN === "1";
const MIRRORED_FILE = "public/.mirrored.json";
const INDEX_FILE = "public/index.json";
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks for multipart upload
const SMALL_FILE_THRESHOLD = 100 * 1024 * 1024; // 100MB, below this use direct upload (multipart is unreliable for small files)
const TARGET_FOLDER_NAME = "rmx3031刷机包";

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[mirror] ${msg}`);
}

function warn(msg) {
  console.warn(`[mirror:WARN] ${msg}`);
}

function error(msg) {
  console.error(`[mirror:ERROR] ${msg}`);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileSize(path) {
  return (await stat(path)).size;
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

/**
 * Validate that the current token is still usable.
 */
async function validateToken() {
  // Try multiple endpoints to validate the token, simplest first
  const endpoints = [
    { url: `${BASE_URL}/a/api/user/info`, method: "GET" },
    { url: `https://www.123pan.cn/a/api/user/info`, method: "GET" },
    { url: `${BASE_URL}/b/api/file/list/new?driveId=0&parentFileId=0&limit=1`, method: "GET" },
  ];

  log(`Validating token (${endpoints.length} endpoints)...`);

  for (const { url, method } of endpoints) {
    try {
      const res = await fetch(url, { method, headers: headers() });
      const json = await res.json();
      if (json.code === 0 || json.code === 200) {
        log(`Token is valid (${url.split("?")[0]})`);
        return true;
      }
      log(`  ${url.split("?")[0]}: code=${json.code} ${json.message || ""}`);
    } catch (err) {
      log(`  ${url.split("?")[0]}: ${err.message}`);
    }
  }

  return false;
}

async function login() {
  // 1. Try token first (most reliable, avoids overseas IP block)
  let token = process.env.PAN123_TOKEN;

  if (token) {
    // Strip "Bearer " prefix if user pasted the full header
    token = token.replace(/^Bearer\s+/i, "").trim();
    authToken = token;
    log("Using PAN123_TOKEN...");

    const valid = await validateToken();
    if (valid) {
      log("Token is valid, proceeding");
      return;
    }

    warn("Token validation failed — check the log above for the API response code");
  }

  // 2. Fallback: phone + password (may be blocked for overseas IPs)
  const phone = process.env.PAN123_PHONE;
  const password = process.env.PAN123_PASSWORD;

  if (phone && password) {
    log(`Logging into 123pan as ${phone}...`);

    const res = await fetch(`${USER_API}/api/user/sign_in`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://yun.123pan.cn",
        Referer: "https://yun.123pan.cn/",
        Platform: "web",
        "App-Version": "3",
      },
      body: JSON.stringify({
        remember: true,
        passport: phone,
        password: password,
      }),
    });

    const json = await res.json();

    if (json.code === 200) {
      authToken = json.data.token;
      log("Login successful");
      log(`TOKEN_FOR_REUSE: ${authToken}`);
      return;
    }

    warn(`Login failed: code=${json.code} message=${json.message || ""}`);
    throw new Error(`Login blocked: ${json.message || JSON.stringify(json)}`);
  }

  throw new Error(
    "Token验证失败。请重新从 get-token.html 获取Token，确保完整复制。"
  );
}

// ── Upload ───────────────────────────────────────────────────────────────────

// ── Folder management ───────────────────────────────────────────────────────

/**
 * Standard params for the /b/api/file/list/new web API.
 */
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

/**
 * Extract items from a list API response. The web API returns data.InfoList.
 */
function extractItems(res) {
  return res.data?.InfoList || res.data?.fileList || res.data?.infoList || [];
}

/**
 * Normalize item field names (web API uses FileName, FileId, Type).
 */
function itemName(item) {
  return item.FileName || item.fileName || item.filename || "";
}

function itemId(item) {
  return item.FileId || item.fileId || item.fileID || 0;
}

function itemType(item) {
  return item.Type !== undefined ? item.Type : item.type;
}

/**
 * Find or create the target folder. Returns folderId.
 */
async function findOrCreateFolder() {
  // Strategy 1: Search by name
  try {
    const res = await apiGet(`${BASE_URL}/b/api/file/list/new`, listParams(0, {
      searchData: TARGET_FOLDER_NAME,
      searchType: 1,
    }));
    const items = extractItems(res);
    for (const item of items) {
      if (itemName(item) === TARGET_FOLDER_NAME && itemType(item) === 1) {
        const id = itemId(item);
        log(`Found existing folder "${TARGET_FOLDER_NAME}", id=${id}`);
        return id;
      }
    }
  } catch (err) {
    warn(`  Folder search failed: ${err.message}`);
  }

  // Strategy 2: Paginate through root
  try {
    for (let page = 1; page <= 10; page++) {
      const res = await apiGet(`${BASE_URL}/b/api/file/list/new`, listParams(0, { page }));
      const items = extractItems(res);
      if (!items.length) break;
      for (const item of items) {
        if (itemName(item) === TARGET_FOLDER_NAME && itemType(item) === 1) {
          const id = itemId(item);
          log(`Found existing folder "${TARGET_FOLDER_NAME}" via listing (page ${page}), id=${id}`);
          return id;
        }
      }
      if (items.length < 100) break;
    }
  } catch (err) {
    warn(`  Folder listing failed: ${err.message}`);
  }

  // Strategy 3: Create the folder — try multiple endpoints
  log(`Creating folder "${TARGET_FOLDER_NAME}"...`);
  const mkdirEndpoints = [
    { url: `${BASE_URL}/b/api/file/newFolder`, body: { driveId: 0, parentFileId: 0, folderName: TARGET_FOLDER_NAME } },
    { url: `${BASE_URL}/b/api/file/mkdir`, body: { driveId: 0, name: TARGET_FOLDER_NAME, parentFileId: 0 } },
    { url: `${BASE_URL}/upload/v1/file/mkdir`, body: { name: TARGET_FOLDER_NAME, parentID: 0 } },
  ];

  let lastErr = null;
  for (const { url, body } of mkdirEndpoints) {
    try {
      const res = await apiPost(url, body);
      const folderId = res.data?.fileId || res.data?.fileID || res.data?.FileId || res.data?.dirID;
      if (folderId) {
        log(`Folder created via ${url.split("/").pop()}, id=${folderId}`);
        return folderId;
      }
      log(`  ${url}: created but no folderId in response: ${JSON.stringify(res.data).slice(0, 100)}`);
    } catch (err) {
      lastErr = err;
      log(`  ${url.split("/").pop()}: ${err.message}`);
    }
  }

  throw new Error(`Failed to create folder after trying ${mkdirEndpoints.length} endpoints. Last error: ${lastErr?.message}`);
}

/**
 * Search for a file by name in the target folder.
 * Returns fileId or null.
 */
async function findFileInFolder(fileName, parentFileId) {
  // Strategy 1: Use search API
  try {
    const res = await apiGet(`${BASE_URL}/b/api/file/list/new`, listParams(parentFileId, {
      searchData: fileName,
      searchType: 1,
    }));
    const items = extractItems(res);
    for (const item of items) {
      if (itemName(item) === fileName) {
        const id = itemId(item);
        log(`  Found existing file via search: id=${id}`);
        return id;
      }
    }
  } catch (err) {
    warn(`  Search API failed: ${err.message}, trying listing...`);
  }

  // Strategy 2: Paginate through target folder
  try {
    for (let page = 1; page <= 10; page++) {
      const res = await apiGet(`${BASE_URL}/b/api/file/list/new`, listParams(parentFileId, { page }));
      const items = extractItems(res);
      if (!items.length) break;
      for (const item of items) {
        if (itemName(item) === fileName) {
          const id = itemId(item);
          log(`  Found existing file via listing (page ${page}): id=${id}`);
          return id;
        }
      }
      if (items.length < 100) break;
    }
  } catch (err) {
    warn(`  File listing failed: ${err.message}`);
  }

  return null;
}

async function uploadRequest(fileName, etag, size, parentFileId) {
  return apiPost(`${BASE_URL}/b/api/file/upload_request`, {
    driveId: 0,
    etag,
    fileName,
    parentFileId,
    size,
    type: 0,
    duplicate: 0,
  });
}

async function uploadComplete(fileId) {
  return apiPost(`${BASE_URL}/b/api/file/upload_complete`, { fileId });
}

async function s3PrepareUploadParts(bucket, key, uploadId, storageNode, start, end) {
  return apiPost(`${BASE_URL}/b/api/file/s3_repare_upload_parts_batch`, {
    bucket,
    key,
    partNumberEnd: end,
    partNumberStart: start,
    uploadId,
    storageNode,
  });
}

async function s3CompleteMultipartUpload(bucket, key, uploadId, storageNode) {
  return apiPost(`${BASE_URL}/b/api/file/s3_complete_multipart_upload`, {
    bucket,
    key,
    uploadId,
    storageNode,
  });
}

/**
 * Upload a batch of chunks to S3 presigned URLs in parallel.
 */
async function uploadBatch(batch, bucket, key, uploadId, storageNode) {
  const start = batch[0].partNumber;
  const end = batch[batch.length - 1].partNumber;

  const partsRes = await s3PrepareUploadParts(bucket, key, uploadId, storageNode, start, end);
  const presignedUrls = partsRes.data?.presignedUrls;

  if (!presignedUrls) {
    throw new Error(`No presigned URLs for parts ${start}-${end}`);
  }

  await Promise.all(
    batch.map(async (chunk) => {
      const url = presignedUrls[String(chunk.partNumber)] || presignedUrls[chunk.partNumber - 1];
      if (!url) {
        throw new Error(`No presigned URL for part ${chunk.partNumber}`);
      }

      const putRes = await fetch(url, {
        method: "PUT",
        body: chunk.data,
        headers: { "Content-Type": "application/octet-stream" },
      });

      if (!putRes.ok) {
        throw new Error(`PUT part ${chunk.partNumber} failed: ${putRes.status}`);
      }
    })
  );
}

/**
 * Upload a local file to 123pan inside the target folder.
 * Returns { fileId, fileName }.
 */
async function uploadFile(filePath, fileName, parentFileId) {
  const size = await fileSize(filePath);
  const etag = await md5FromFile(filePath);

  log(`  Uploading ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)...`);

  if (DRY_RUN) {
    log(`[DRY RUN] Would upload ${fileName} to folder ${parentFileId}`);
    return { fileId: `dry_run_${Date.now()}`, fileName };
  }

  // Step 1: upload_request
  let reqRes = await uploadRequest(fileName, etag, size, parentFileId);

  if (reqRes.data.Reuse) {
    let fileId = reqRes.data.FileId;
    if (!fileId || fileId === 0) {
      log(`  Reuse returned fileId=0, searching in folder...`);
      fileId = await findFileInFolder(fileName, parentFileId);
    }
    if (fileId && fileId !== 0) {
      log(`  File already exists on 123pan (reuse), fileId=${fileId}`);
      return { fileId, fileName };
    }
    // Could not find fileId — force a fresh upload with duplicate=1
    warn(`  Could not find existing fileId, forcing fresh upload...`);
    reqRes = await apiPost(`${BASE_URL}/b/api/file/upload_request`, {
      driveId: 0,
      etag,
      fileName,
      parentFileId,
      size,
      type: 0,
      duplicate: 1,
    });
    if (reqRes.data.Reuse) {
      throw new Error(`Still got Reuse after forcing duplicate=1 for ${fileName}`);
    }
    log(`  Forced fresh upload for ${fileName}`);
  }

  const { Bucket: bucket, StorageNode: storageNode, Key: key, UploadId: uploadId, FileId: fileId } = reqRes.data;

  if (size === 0) {
    // 0-byte file: skip PUT, just complete upload
    log(`  0-byte file, completing upload directly...`);
    await uploadComplete(fileId);
    return { fileId, fileName };
  }

  if (size <= SMALL_FILE_THRESHOLD) {
    // Small file: get presigned URL for single-part upload
    const partsRes = await s3PrepareUploadParts(bucket, key, uploadId, storageNode, 1, 1);
    const presignedUrl = partsRes.data?.presignedUrls?.["1"] || partsRes.data?.presignedUrls?.[0];

    if (!presignedUrl) {
      throw new Error("No presigned URL returned for small file upload");
    }

    const fileBuffer = await readFile(filePath);
    const putRes = await fetch(presignedUrl, {
      method: "PUT",
      body: fileBuffer,
      headers: { "Content-Type": "application/octet-stream" },
    });

    if (!putRes.ok) {
      throw new Error(`PUT to presigned URL failed: ${putRes.status} ${putRes.statusText}`);
    }
  } else {
    // Large file: multipart upload — stream in batches to avoid memory blowup

    const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE });

    let partNumber = 0;
    const BATCH_SIZE = 10;
    let batch = [];

    for await (const chunk of stream) {
      partNumber++;
      batch.push({ data: chunk, partNumber, size: chunk.length });

      if (batch.length >= BATCH_SIZE) {
        await uploadBatch(batch, bucket, key, uploadId, storageNode);
        batch = [];
      }
    }

    // Upload remaining
    if (batch.length > 0) {
      await uploadBatch(batch, bucket, key, uploadId, storageNode);
    }

    // Complete multipart upload
    await s3CompleteMultipartUpload(bucket, key, uploadId, storageNode);
    // Wait for server-side assembly
    await sleep(3000);
  }

  // Complete upload with retry (server may need time to finalize)
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

/**
 * Create a share link for a file.
 * Returns { shareUrl, shareKey }.
 */
async function createShare(fileId, fileName, shareName) {
  if (DRY_RUN) {
    return { shareUrl: `https://www.123pan.com/s/dry_run`, shareKey: "dry_run" };
  }

  const res = await apiPost(`${BASE_URL}/a/api/share/create`, {
    driveId: 0,
    expiration: "2099-12-31T23:59:59+08:00", // Far future = permanent
    fileIdList: String(fileId),
    shareName: shareName || fileName,
    sharePwd: "",
  });

  const shareKey = res.data?.ShareKey;
  if (!shareKey) {
    throw new Error(`Share creation returned no ShareKey: ${JSON.stringify(res)}`);
  }

  const shareUrl = `https://www.123pan.com/s/${shareKey}`;
  return { shareUrl, shareKey };
}

// ── Download file from archive.org ──────────────────────────────────────────

/**
 * Download a file using fetch() stream.
 */
async function downloadFile(url, destPath) {
  if (DRY_RUN) {
    await writeFile(destPath, "dummy");
    return;
  }

  await downloadWithFetch(url, destPath);
}

/**
 * Download a file using fetch() stream.
 */
async function downloadWithFetch(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
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

// ── Main mirror logic ───────────────────────────────────────────────────────

async function loadMirrored() {
  try {
    const raw = await readFile(MIRRORED_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveMirrored(data) {
  await mkdir("public", { recursive: true });
  await writeFile(MIRRORED_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function loadIndex() {
  const raw = await readFile(INDEX_FILE, "utf8");
  return JSON.parse(raw);
}

async function saveIndex(data) {
  await writeFile(INDEX_FILE, JSON.stringify(data, null, 2), "utf8");
}

function flattenFiles(indexData) {
  const result = [];
  for (const [category, value] of Object.entries(indexData)) {
    if (category.startsWith("_") || !Array.isArray(value)) continue;
    for (let i = 0; i < value.length; i++) {
      const file = value[i];
      if (file && file.url) {
        result.push({ file, category, index: i });
      }
    }
  }
  return result;
}

function isCategoryKey(key) {
  return !key.startsWith("_");
}

async function main() {
  log("=== 123pan Mirror Script ===");

  // 1. Login
  await login();

  // 2. Find or create target folder
  const folderId = await findOrCreateFolder();

  // 3. Load state
  const indexData = await loadIndex();
  const mirrored = await loadMirrored();
  const allFiles = flattenFiles(indexData);

  log(`Loaded index: ${allFiles.length} files across ${Object.keys(indexData).filter(isCategoryKey).length} categories`);
  log(`Previously mirrored: ${Object.keys(mirrored).length} files`);

  // 4. Find new files
  const newFiles = allFiles.filter((f) => !mirrored[f.file.url]);

  if (newFiles.length === 0) {
    log("No new files to mirror. Done.");
    return;
  }

  log(`Found ${newFiles.length} new files to mirror`);

  // 5. Size check
  let skipped = 0;
  const toProcess = [];
  for (const f of newFiles) {
    if (MAX_SIZE_MB > 0 && f.file.size) {
      const sizeMB = parseSizeMB(f.file.size);
      if (sizeMB > MAX_SIZE_MB) {
        warn(`Skipping ${f.file.name} (${f.file.size} > ${MAX_SIZE_MB}MB limit)`);
        skipped++;
        continue;
      }
    }
    toProcess.push(f);
  }

  if (skipped > 0) {
    log(`${skipped} files skipped due to size limit`);
  }

  if (toProcess.length === 0) {
    log("No files to process after size filter. Done.");
    return;
  }

  // 6. Process each file
  const tmpDir = join(tmpdir(), "123pan-mirror");
  await mkdir(tmpDir, { recursive: true });

  let success = 0;
  let failed = 0;
  const failedFiles = [];
  const MAX_RETRIES = 3;

  for (const { file, category, index } of toProcess) {
    const fileName = basename(new URL(file.url).pathname) || file.name || "unknown";
    const tmpPath = join(tmpDir, fileName);

    let lastErr = null;
    let mirroredEntry = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          const delay = Math.min(attempt * 5, 20);
          await sleep(delay * 1000);
        }

        log(`\n  [${file.name}] (${file.size || "unknown"})${attempt > 1 ? ` [重试 ${attempt}/${MAX_RETRIES}]` : ""}`);

        // Download
        await downloadFile(file.url, tmpPath);

        if (!DRY_RUN) {
          const actualSize = await fileSize(tmpPath);
          if (actualSize === 0) {
            throw new Error("Downloaded file is 0 bytes");
          }
        }

        // Upload to 123pan (inside target folder)
        const { fileId } = await uploadFile(tmpPath, fileName, folderId);

        // Create share
        const shareName = file.name || fileName;
        const { shareUrl } = await createShare(fileId, fileName, shareName);

        // Update index.json
        indexData[category][index].url_123pan = shareUrl;
        indexData[category][index].url_original = file.url;

        mirroredEntry = {
          shareUrl,
          fileId,
          mirroredAt: new Date().toISOString(),
        };

        success++;
        log(`  ✓ 完成: ${shareUrl}`);
        break; // success, exit retry loop
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          warn(`  Attempt ${attempt} failed: ${err.message}`);
        } else {
          error(`  ✗ Failed to mirror ${file.name} after ${MAX_RETRIES} attempts: ${err.message}`);
        }
      } finally {
        // Clean up temp file between retries
        try { await unlink(tmpPath); } catch { /* ignore */ }
      }
    }

    if (mirroredEntry) {
      // Record in mirrored state (whether success or skipped)
      mirrored[file.url] = mirroredEntry;
    } else {
      failed++;
      failedFiles.push(`${file.name}: ${lastErr?.message || "unknown"}`);
    }
  }

  // 7. Save state
  await saveIndex(indexData);
  await saveMirrored(mirrored);

  log(`\n=== Done: ${success} succeeded, ${failed} failed, ${skipped} skipped ===`);

  if (failedFiles.length > 0) {
    log(`\nFailed files:`);
    for (const f of failedFiles) {
      error(`  ${f}`);
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
}

function parseSizeMB(sizeStr) {
  if (!sizeStr) return 0;
  const match = String(sizeStr).trim().match(/^([\d.]+)\s*(GB|MB|KB|B)$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers = { B: 1 / 1024 / 1024, KB: 1 / 1024, MB: 1, GB: 1024 };
  return num * (multipliers[unit] || 1);
}

main().catch((err) => {
  error(`Fatal: ${err.message}`);
  process.exit(1);
});