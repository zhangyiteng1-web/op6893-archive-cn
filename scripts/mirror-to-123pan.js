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
import { pipeline } from "node:stream/promises";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = "https://www.123pan.cn";
const USER_API = "https://user.123pan.cn";
const MAX_SIZE_MB = parseInt(process.env.PAN123_MAX_SIZE_MB || "0", 10); // 0 = no limit
const DRY_RUN = process.env.PAN123_DRY_RUN === "1";
const MIRRORED_FILE = "public/.mirrored.json";
const INDEX_FILE = "public/index.json";
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks for multipart upload
const SMALL_FILE_THRESHOLD = 10 * 1024 * 1024; // 10MB, below this use direct upload

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
  // Try multiple endpoints to validate the token
  const endpoints = [
    `${BASE_URL}/b/api/file/list/new`,
    `${BASE_URL}/a/api/user/info`,
    `https://www.123pan.cn/a/api/user/info`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: headers() });
      const json = await res.json();
      log(`Token validation (${url}): code=${json.code} message=${json.message || ""}`);
      if (json.code === 0 || json.code === 200) {
        return true;
      }
    } catch (err) {
      log(`Token validation error (${url}): ${err.message}`);
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

async function uploadRequest(fileName, etag, size) {
  return apiPost(`${BASE_URL}/b/api/file/upload_request`, {
    driveId: 0,
    etag,
    fileName,
    parentFileId: 0,
    size,
    type: 0,
    duplicate: 1, // 1 = keep both if duplicate
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
 * Upload a local file to 123pan.
 * Returns { fileId, fileName }.
 */
async function uploadFile(filePath, fileName) {
  const size = await fileSize(filePath);
  const etag = await md5FromFile(filePath);

  log(`Uploading ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB, etag=${etag})...`);

  if (DRY_RUN) {
    log(`[DRY RUN] Would upload ${fileName}`);
    return { fileId: `dry_run_${Date.now()}`, fileName };
  }

  // Step 1: upload_request
  const reqRes = await uploadRequest(fileName, etag, size);

  if (reqRes.data.Reuse) {
    log(`  File already exists on 123pan (reuse), fileId=${reqRes.data.FileId}`);
    return { fileId: reqRes.data.FileId, fileName };
  }

  const { Bucket: bucket, StorageNode: storageNode, Key: key, UploadId: uploadId, FileId: fileId } = reqRes.data;

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
    // Large file: multipart upload
    const totalParts = Math.ceil(size / CHUNK_SIZE);
    log(`  Multipart upload: ${totalParts} parts of ${(CHUNK_SIZE / 1024 / 1024).toFixed(0)}MB each`);

    const fd = await readFile(filePath); // Read entire file for simplicity; for really large files use streams
    // Actually, for 5GB files we need streaming. Let's use streaming.
    const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE });

    let partNumber = 0;
    let bytesRead = 0;
    const chunks = [];

    for await (const chunk of stream) {
      partNumber++;
      chunks.push({ data: chunk, partNumber, size: chunk.length });
    }

    // Upload parts in batches of 10
    const BATCH_SIZE = 10;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const start = batch[0].partNumber;
      const end = batch[batch.length - 1].partNumber;

      const partsRes = await s3PrepareUploadParts(bucket, key, uploadId, storageNode, start, end);
      const presignedUrls = partsRes.data?.presignedUrls;

      if (!presignedUrls) {
        throw new Error(`No presigned URLs for parts ${start}-${end}`);
      }

      // Upload each part in parallel
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

          bytesRead += chunk.size;
        })
      );

      log(`  Uploaded parts ${start}-${end} (${(bytesRead / size * 100).toFixed(0)}%)`);
    }

    // Complete multipart upload
    await s3CompleteMultipartUpload(bucket, key, uploadId, storageNode);
  }

  // Complete upload
  await uploadComplete(fileId);

  log(`  Upload complete, fileId=${fileId}`);
  return { fileId, fileName };
}

// ── Share ────────────────────────────────────────────────────────────────────

/**
 * Create a share link for a file.
 * Returns { shareUrl, shareKey }.
 */
async function createShare(fileId, fileName, shareName) {
  log(`  Creating share for ${fileName}...`);

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
  log(`  Share created: ${shareUrl}`);
  return { shareUrl, shareKey };
}

// ── Download file from archive.org ──────────────────────────────────────────

async function downloadFile(url, destPath) {
  log(`  Downloading ${url}...`);

  if (DRY_RUN) {
    log(`  [DRY RUN] Would download to ${destPath}`);
    // Create a dummy file
    await writeFile(destPath, "dummy");
    return;
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const contentLength = res.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;

  const fileStream = createWriteStream(destPath);
  let downloaded = 0;
  let lastLog = 0;

  const reader = res.body.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    downloaded += value.length;
    fileStream.write(value);

    // Log progress every 10MB
    if (downloaded - lastLog >= 10 * 1024 * 1024) {
      lastLog = downloaded;
      const pct = total ? ` ${(downloaded / total * 100).toFixed(0)}%` : "";
      log(`    Downloaded ${(downloaded / 1024 / 1024).toFixed(0)}MB${pct}`);
    }
  }

  fileStream.end();
  await new Promise((resolve) => fileStream.on("finish", resolve));

  log(`    Download complete: ${(downloaded / 1024 / 1024).toFixed(1)}MB`);
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

  // 2. Load state
  const indexData = await loadIndex();
  const mirrored = await loadMirrored();
  const allFiles = flattenFiles(indexData);

  log(`Loaded index: ${allFiles.length} files across ${Object.keys(indexData).filter(isCategoryKey).length} categories`);
  log(`Previously mirrored: ${Object.keys(mirrored).length} files`);

  // 3. Find new files
  const newFiles = allFiles.filter((f) => !mirrored[f.file.url]);

  if (newFiles.length === 0) {
    log("No new files to mirror. Done.");
    return;
  }

  log(`Found ${newFiles.length} new files to mirror`);

  // 4. Size check
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

  // 5. Process each file
  const tmpDir = join(tmpdir(), "123pan-mirror");
  await mkdir(tmpDir, { recursive: true });

  let success = 0;
  let failed = 0;

  for (const { file, category, index } of toProcess) {
    const fileName = basename(new URL(file.url).pathname) || file.name || "unknown";
    const tmpPath = join(tmpDir, fileName);

    try {
      log(`\n--- Processing: ${file.name} (${file.size || "unknown"}) ---`);

      // Download
      await downloadFile(file.url, tmpPath);

      if (!DRY_RUN) {
        const actualSize = await fileSize(tmpPath);
        log(`  File size on disk: ${(actualSize / 1024 / 1024).toFixed(1)}MB`);
      }

      // Upload to 123pan
      const { fileId } = await uploadFile(tmpPath, fileName);

      // Create share
      const shareName = file.name || fileName;
      const { shareUrl } = await createShare(fileId, fileName, shareName);

      // Update index.json
      indexData[category][index].url_123pan = shareUrl;
      indexData[category][index].url_original = file.url;

      // Record in mirrored state
      mirrored[file.url] = {
        shareUrl,
        fileId,
        mirroredAt: new Date().toISOString(),
      };

      success++;
      log(`  ✓ Mirrored: ${shareUrl}`);
    } catch (err) {
      error(`  ✗ Failed to mirror ${file.name}: ${err.message}`);
      failed++;
      // Continue with next file
    } finally {
      // Clean up temp file
      try {
        await unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  // 6. Save state
  await saveIndex(indexData);
  await saveMirrored(mirrored);

  log(`\n=== Done: ${success} succeeded, ${failed} failed, ${skipped} skipped ===`);

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