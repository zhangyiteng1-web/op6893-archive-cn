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

import { readFile, writeFile, stat, unlink, mkdir, open } from "node:fs/promises";
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

/** Make a POST request with error handling. Returns { code, data, message } */
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

/**
 * 在文件夹中查找文件，先尝试精准搜索，搜索不到则遍历列表
 */
async function findFileInFolder(fileName, parentFileId) {
  // 先尝试精准搜索
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

  // 搜索不到就遍历列表
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

// ── Upload (V2 API) ─────────────────────────────────────────────────────────

/**
 * Upload a file to 123pan via OpenAPI V2 (multipart/form-data slices).
 * V2 分片直接 POST 到 API 服务器，不走预签名存储 URL，网络更稳定。
 * Returns fileID.
 */
async function uploadFile(filePath, fileName, parentFileId) {
  const size = await fileSize(filePath);
  log(`  计算文件 MD5...`);
  const etag = await md5FromFile(filePath);
  log(`  MD5: ${etag}`);

  log(`  上传 ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)...`);

  if (DRY_RUN) {
    log("  [DRY RUN] 跳过上传");
    return `dry_${Date.now()}`;
  }

  // Step 1: Create upload (V2)
  const createJson = await apiPostRaw("/upload/v2/file/create", {
    parentFileID: parentFileId,
    filename: fileName,
    etag: etag,
    size: size,
  });

  if (createJson.code !== 0) {
    // code=1 可能是文件名重复
    if (createJson.code === 1) {
      log("  文件已存在（文件名重复），查找已有文件...");
      const existingId = await findFileInFolder(fileName, parentFileId);
      if (existingId) {
        log(`  找到已有文件, id=${existingId}`);
        return existingId;
      }
      throw new Error("文件已存在但无法找到其ID");
    }
    throw new Error(`创建上传失败: code=${createJson.code} message=${createJson.message || ""}`);
  }

  const data = createJson.data;

  // 秒传
  if (data.reuse) {
    if (data.fileID) {
      log(`  秒传成功, fileId=${data.fileID}`);
      return data.fileID;
    }
    // fallback: search
    log(`  秒传成功，搜索已有文件...`);
    const existingId = await findFileInFolder(fileName, parentFileId);
    if (existingId) {
      log(`  找到已有文件, id=${existingId}`);
      return existingId;
    }
    await sleep(3000);
    const retryId = await findFileInFolder(fileName, parentFileId);
    if (retryId) {
      log(`  延迟搜索找到, id=${retryId}`);
      return retryId;
    }
    throw new Error("秒传成功但搜索不到文件ID");
  }

  const preuploadID = data.preuploadID;
  const sliceSize = data.sliceSize;
  const totalParts = Math.ceil(size / sliceSize);

  // Step 2: 获取上传域名
  let uploadBase = (data.servers && data.servers.length > 0) ? data.servers[0].replace(/\/+$/, "") : "";
  if (!uploadBase) {
    const domains = await apiGet("/upload/v2/file/domain");
    if (domains && domains.length > 0) {
      uploadBase = String(domains[0]).replace(/\/+$/, "");
    }
  }
  if (!uploadBase) {
    // fallback to API base
    uploadBase = API_BASE;
  }
  log(`  上传域名: ${uploadBase}`);

  // Step 3: 逐个分片 → multipart/form-data POST
  const logInterval = totalParts > 100 ? 5 : 10;
  log(`  共 ${totalParts} 个分片，每片 ${(sliceSize / 1024 / 1024).toFixed(1)}MB，开始上传...`);
  const uploadStartTime = Date.now();
  let lastLogPercent = 0;

  for (let i = 1; i <= totalParts; i++) {
    const start = (i - 1) * sliceSize;
    const end = Math.min(start + sliceSize, size);
    const chunk = await readChunk(filePath, start, end);
    const sliceMD5 = md5FromBuffer(chunk);

    let sliceOk = false;
    let lastErr = null;

    for (let retry = 0; retry < 3 && !sliceOk; retry++) {
      if (retry > 0) {
        warn(`  分片 ${i}/${totalParts} 重试 ${retry}/3...`);
        await sleep(2000);
      }

      try {
        // 构建 multipart/form-data
        const boundary = "----" + Date.now().toString(36) + Math.random().toString(36).slice(2);
        const parts = [];
        const addField = (name, value) => {
          parts.push(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
          );
        };
        addField("preuploadID", preuploadID);
        addField("sliceNo", String(i));
        addField("sliceMD5", sliceMD5);
        parts.push(
          `--${boundary}\r\nContent-Disposition: form-data; name="slice"; filename="${encodeURIComponent(fileName)}"\r\nContent-Type: application/octet-stream\r\n\r\n`
        );
        // 拼接 header + chunk + footer
        const header = Buffer.from(parts.join(""), "utf-8");
        const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
        const body = Buffer.concat([header, chunk, footer]);

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 120_000);

        const putRes = await fetch(`${uploadBase}/upload/v2/file/slice`, {
          method: "POST",
          body: body,
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Authorization": `Bearer ${accessToken}`,
            "Platform": "open_platform",
          },
          signal: ctrl.signal,
        });

        clearTimeout(timer);

        const respJson = await putRes.json();
        if (!putRes.ok || respJson.code !== 0) {
          throw new Error(`HTTP ${putRes.status} code=${respJson.code} ${respJson.message || ""}`);
        }
        sliceOk = true;
      } catch (err) {
        lastErr = err;
        if (err.name === "AbortError") {
          warn(`  分片 ${i}/${totalParts} 超时 (2分钟)`);
        } else {
          warn(`  分片 ${i}/${totalParts} 失败: ${err.message}`);
        }
      }
    }

    if (!sliceOk) {
      throw new Error(`分片 ${i}/${totalParts} 上传失败: ${lastErr?.message}`);
    }

    // 进度报告
    const pct = Math.round((i / totalParts) * 100);
    if (pct >= lastLogPercent + logInterval || i === totalParts) {
      const elapsed = (Date.now() - uploadStartTime) / 1000;
      const eta = i > 0 ? (elapsed / i) * (totalParts - i) : 0;
      const etaStr = eta > 60 ? `${Math.round(eta / 60)}分钟` : `${Math.round(eta)}秒`;
      log(`  上传进度: ${pct}% (${i}/${totalParts})，预计剩余 ${etaStr}`);
      lastLogPercent = Math.floor(pct / logInterval) * logInterval;
    }
  }

  // Step 4: 完成上传
  log(`  所有分片上传完成，等待服务器处理...`);
  const completeData = await apiPost("/upload/v2/file/upload_complete", { preuploadID });

  if (completeData.completed && (completeData.fileID || completeData.fileId)) {
    const fileId = completeData.fileID || completeData.fileId;
    log(`  上传完成 fileId=${fileId}`);
    return fileId;
  }

  throw new Error(`上传完成但未返回 fileID: completed=${completeData.completed}`);
}

// ── Share ────────────────────────────────────────────────────────────────────

async function createShare(fileId, fileName) {
  if (DRY_RUN) {
    return { shareUrl: `https://www.123pan.com/s/dry_run`, shareKey: "dry_run" };
  }

  // fileIDList 必须是逗号分隔的字符串，不是数组！
  log(`  创建分享: fileId=${fileId}, fileIDList="${String(fileId)}"`);
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

// ── Download ─────────────────────────────────────────────────────────────────

const DOWNLOAD_THREADS = 4;          // 并发连接数
const MULTI_THREAD_MIN_SIZE = 50 * 1024 * 1024; // 小于 50MB 用单线程

/**
 * 多线程下载，用 HTTP Range 将文件分成 N 段并行下载
 * 每个线程写入文件对应偏移量，无需额外合并
 */
async function downloadFile(url, destPath) {
  if (DRY_RUN) {
    await writeFile(destPath, "dummy");
    return;
  }

  // 1. HEAD 请求获取文件大小
  const headRes = await fetch(url, { method: "HEAD" });
  const totalSize = parseInt(headRes.headers.get("content-length") || "0", 10);
  const acceptRanges = headRes.headers.get("accept-ranges");

  // 小文件或服务器不支持 Range → 单线程
  if (totalSize === 0 || totalSize < MULTI_THREAD_MIN_SIZE || acceptRanges !== "bytes") {
    return downloadSingleThread(url, destPath);
  }

  // 2. 预分配文件空间
  const fd = await open(destPath, "w");
  await fd.truncate(totalSize);
  await fd.close();

  // 3. 计算分片并并行下载
  const chunkSize = Math.ceil(totalSize / DOWNLOAD_THREADS);
  const tasks = [];
  const startTime = Date.now();

  for (let i = 0; i < DOWNLOAD_THREADS; i++) {
    const start = i * chunkSize;
    const end = i === DOWNLOAD_THREADS - 1 ? totalSize - 1 : start + chunkSize - 1;
    if (start >= totalSize) break;
    tasks.push(downloadChunk(url, destPath, start, end, i));
  }

  await Promise.all(tasks);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const speed = totalSize > 0 ? ((totalSize / 1024 / 1024) / (elapsed || 0.1)).toFixed(1) : "?";
  log(`  下载完成: ${(totalSize / 1024 / 1024).toFixed(1)}MB (${DOWNLOAD_THREADS}线程, ${elapsed}s, ${speed}MB/s)`);
}

async function downloadSingleThread(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败: ${res.status} ${res.statusText}`);

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

async function downloadChunk(url, destPath, start, end, index) {
  for (let retry = 0; retry < 3; retry++) {
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
      });

      if (!res.ok && res.status !== 206) {
        throw new Error(`Range 请求失败: ${res.status}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());

      // 写入文件对应偏移量
      const fd = await open(destPath, "r+");
      await fd.write(buf, 0, buf.length, start);
      await fd.close();

      return;
    } catch (err) {
      if (retry === 2) throw err;
      await sleep(2000 * (retry + 1));
    }
  }
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
    if (entry.url_123pan) continue;
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

    // ── Phase 1: 下载 + 上传 ──
    let fileId = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 1) await sleep(attempt * 5000);

        await downloadFile(entry.url, tmpPath);

        const actualSize = await fileSize(tmpPath);
        if (actualSize === 0) throw new Error("下载文件大小为0");

        fileId = await uploadFile(tmpPath, filename, folderId);
        break;
      } catch (err) {
        // 文件名重复 → 重试时直接查找已有文件
        if (err.message.includes("文件名重复")) {
          try {
            fileId = await findFileInFolder(filename, folderId);
            if (fileId) {
              log(`  文件已存在, id=${fileId}`);
              break;
            }
          } catch { /* fall through */ }
        }

        if (attempt < MAX_RETRIES) {
          warn(`  下载/上传重试 ${attempt}/${MAX_RETRIES}: ${err.message}`);
        } else {
          error_(`  ✗ 下载/上传失败: ${err.message}`);
        }
      } finally {
        try { await unlink(tmpPath); } catch { /* ignore */ }
      }
    }

    if (!fileId) {
      failed++;
      continue;
    }

    // ── Phase 2: 分享 ──
    let shareDone = false;
    let shareUrl = null;
    let shareKey = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 1) await sleep(attempt * 3000);

        const result = await createShare(fileId, filename);
        shareUrl = result.shareUrl;
        shareKey = result.shareKey;
        log(`  分享链接: ${shareUrl}`);
        shareDone = true;
        break;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          warn(`  分享重试 ${attempt}/${MAX_RETRIES}: ${err.message}`);
        } else {
          error_(`  ✗ 分享失败: ${err.message}`);
        }
      }
    }

    if (!shareDone) {
      failed++;
      continue;
    }

    // Update index
    indexData[category][index].url_123pan = shareUrl;
    indexData[category][index].url_original = entry.url;
    shares[String(fileId)] = { shareUrl, shareKey, fileName: filename, sharedAt: new Date().toISOString() };

    success++;

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