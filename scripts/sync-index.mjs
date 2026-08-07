import { mkdir, writeFile, readFile } from "node:fs/promises";

const SOURCES = [
  "https://rmx3031-archive.pages.dev/index.json",
  "https://raw.githubusercontent.com/xCaptaiN09/rmx3031-archive/main/public/index.json",
];

async function fetchJson() {
  let lastError;

  for (const source of SOURCES) {
    try {
      const response = await fetch(source, {
        headers: { "user-agent": "op6893-archive-cn-sync" },
      });

      if (!response.ok) {
        throw new Error(`${source} returned ${response.status}`);
      }

      return { data: await response.json(), source };
    } catch (error) {
      lastError = error;
      console.warn(`同步源不可用：${source}`);
    }
  }

  throw lastError ?? new Error("没有可用的同步源");
}

// Preserve existing 123pan mirror URLs from old index.json
async function loadMirrorMap() {
  try {
    const raw = await readFile("public/index.json", "utf8");
    const old = JSON.parse(raw);
    const map = {};
    for (const [, value] of Object.entries(old)) {
      if (!Array.isArray(value)) continue;
      for (const file of value) {
        if (file && file.url && file.url_123pan) {
          map[file.url] = file.url_123pan;
        }
      }
    }
    console.log(`从旧数据恢复了 ${Object.keys(map).length} 条 123pan 镜像链接`);
    return map;
  } catch {
    return {};
  }
}

const mirrorMap = await loadMirrorMap();
const { data, source } = await fetchJson();
const now = new Date();
const syncedAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

// Restore 123pan mirror URLs
for (const [, value] of Object.entries(data)) {
  if (!Array.isArray(value)) continue;
  for (const file of value) {
    if (file && file.url && mirrorMap[file.url]) {
      file.url_123pan = mirrorMap[file.url];
    }
  }
}

const output = {
  ...data,
  _synced_at: syncedAt,
  _sync_source: source,
};

await mkdir("public", { recursive: true });
await writeFile("public/index.json", `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`已同步 public/index.json，来源：${source}，时间戳：${syncedAt}`);