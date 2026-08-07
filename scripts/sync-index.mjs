import { mkdir, writeFile } from "node:fs/promises";

const SOURCES = [
  "https://rmx3031-archive.pages.dev/index.json",
  "https://raw.githubusercontent.com/xCaptaiN09/rmx3031-archive/main/public/index.json",
];

async function fetchJson() {
  let lastError;

  for (const source of SOURCES) {
    try {
      const response = await fetch(source, {
        headers: {
          "user-agent": "op6893-archive-cn-sync",
        },
      });

      if (!response.ok) {
        throw new Error(`${source} returned ${response.status}`);
      }

      return {
        data: await response.json(),
        source,
      };
    } catch (error) {
      lastError = error;
      console.warn(`同步源不可用：${source}`);
    }
  }

  throw lastError ?? new Error("没有可用的同步源");
}

const { data, source } = await fetchJson();
const output = {
  ...data,
  syncMeta: {
    source,
    syncedAt: new Date().toISOString(),
  },
};

await mkdir("public", { recursive: true });
await writeFile("public/index.json", `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`已同步 public/index.json，来源：${source}`);
