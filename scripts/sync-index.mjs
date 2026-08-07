import { mkdir, writeFile } from "node:fs/promises";

const SOURCES = [
  "https://rmx3031-archive.pages.dev/index.json",
  "https://raw.githubusercontent.com/xCaptaiN09/rmx3031-archive/main/public/index.json",
];

const TRANSLATE_API = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=";
const TRANSLATE_DELAY_MS = 800; // 避免触发限流

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

async function translateText(text) {
  if (!text || text.trim().length < 3) return text;

  const url = TRANSLATE_API + encodeURIComponent(text);
  try {
    const resp = await fetch(url, {
      headers: { "user-agent": "op6893-archive-cn-sync" },
    });
    if (!resp.ok) throw new Error(`translate HTTP ${resp.status}`);
    const json = await resp.json();
    // Google Translate returns [[["translated", "original", ...], ...], ...]
    const translated = (json[0] ?? [])
      .map((seg) => seg[0] ?? "")
      .join("");
    return translated || text;
  } catch (err) {
    console.warn(`翻译失败，保留原文: ${err.message}`);
    return text;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function translateChangelogs(data) {
  const listKeys = Object.entries(data)
    .filter(([, v]) => Array.isArray(v) && v.every((item) => item && typeof item === "object" && "name" in item))
    .map(([k]) => k);

  let total = 0;
  let translated = 0;

  for (const key of listKeys) {
    const items = data[key];
    for (const item of items) {
      if (item.changelog && typeof item.changelog === "string" && item.changelog.trim().length > 0) {
        total++;
        // 跳过已经很短的或已经包含中文的
        if (/[\u4e00-\u9fff]/.test(item.changelog)) {
          item.changelog_zh = item.changelog;
          continue;
        }
        console.log(`  翻译 [${key}] ${(item.name ?? "unknown").slice(0, 40)}...`);
        const zh = await translateText(item.changelog);
        if (zh !== item.changelog) {
          item.changelog_zh = zh;
          translated++;
        } else {
          item.changelog_zh = item.changelog;
        }
        await delay(TRANSLATE_DELAY_MS);
      }
    }
  }

  console.log(`翻译完成：${translated}/${total} 条已翻译`);
  return data;
}

const { data, source } = await fetchJson();
const now = new Date();
const syncedAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

console.log("开始翻译 changelog...");
const translatedData = await translateChangelogs(data);

const output = {
  ...translatedData,
  _synced_at: syncedAt,
  _sync_source: source,
};

await mkdir("public", { recursive: true });
await writeFile("public/index.json", `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`已同步 public/index.json，来源：${source}，时间戳：${syncedAt}`);