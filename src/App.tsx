import { useEffect, useMemo, useState } from "react";

const DATA_SOURCES = [
  "https://rmx3031-archive.pages.dev/index.json",
  "https://raw.githubusercontent.com/xCaptaiN09/rmx3031-archive/main/public/index.json",
];

const SUPPORTED_DEVICES = [
  "Realme X7 Max",
  "Realme GT Neo",
  "Realme GT Neo Flash",
  "OnePlus Nord 2",
];

const CATEGORY_ORDER = [
  "roms",
  "kernels",
  "modules",
  "ota",
  "ota_cn",
  "ota_cnf",
  "firmware",
  "sptool",
  "recovery",
  "other",
];

const CATEGORY_LABELS: Record<string, string> = {
  roms: "ROM",
  kernels: "内核",
  modules: "模块",
  ota: "X7 Max",
  ota_cn: "GT Neo",
  ota_cnf: "GT Neo Flash",
  firmware: "固件",
  sptool: "SP 工具",
  recovery: "Recovery",
  other: "其他",
};

type ArchiveFile = {
  name?: string;
  version?: string;
  android?: string;
  date?: string;
  size?: string;
  url?: string;
  changelog?: string;
};

type ArchiveData = {
  device?: string;
  codename?: string;
  maintainer?: string;
  [key: string]: unknown;
};

type FileWithCategory = ArchiveFile & {
  id: string;
  category: string;
  categoryLabel: string;
};

function formatCategory(key: string) {
  return CATEGORY_LABELS[key] ?? key.replace(/[_-]/g, " ").toUpperCase();
}

function isFileList(value: unknown): value is ArchiveFile[] {
  return (
    Array.isArray(value) &&
    value.every((item) => item && typeof item === "object" && "name" in item)
  );
}

function getOrderedCategoryKeys(data: ArchiveData) {
  const listKeys = Object.entries(data)
    .filter(([, value]) => isFileList(value))
    .map(([key]) => key);
  const knownKeys = CATEGORY_ORDER.filter((key) => listKeys.includes(key));
  const unknownKeys = listKeys.filter((key) => !CATEGORY_ORDER.includes(key));
  return [...knownKeys, ...unknownKeys];
}

function flattenFiles(data: ArchiveData): FileWithCategory[] {
  return getOrderedCategoryKeys(data).flatMap((category) => {
    const value = data[category];
    if (!isFileList(value)) {
      return [];
    }

    return value.map((file, index) => ({
      ...file,
      id: `${category}-${file.name ?? "file"}-${file.date ?? index}`,
      category,
      categoryLabel: formatCategory(category),
    }));
  });
}

function sortByDateDesc(files: FileWithCategory[]) {
  return [...files].sort((a, b) => {
    const left = a.date ? new Date(a.date).getTime() : 0;
    const right = b.date ? new Date(b.date).getTime() : 0;
    return right - left;
  });
}

async function fetchArchiveData(): Promise<{ data: ArchiveData; source: string }> {
  let lastError: unknown;

  for (const source of DATA_SOURCES) {
    try {
      const response = await fetch(`${source}?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`读取失败：${response.status}`);
      }
      return { data: await response.json(), source };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "无法读取上游数据";
}

export default function App() {
  const [data, setData] = useState<ArchiveData | null>(null);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");

  useEffect(() => {
    fetchArchiveData()
      .then((result) => {
        setData(result.data);
        setSource(result.source);
      })
      .catch((fetchError) => setError(getErrorMessage(fetchError)))
      .finally(() => setLoading(false));
  }, []);

  const files = useMemo(() => (data ? sortByDateDesc(flattenFiles(data)) : []), [data]);
  const categories = useMemo(
    () => {
      if (!data) {
        return [];
      }

      return getOrderedCategoryKeys(data).map((key) => ({
        key,
        label: formatCategory(key),
        count: files.filter((file) => file.category === key).length,
      }));
    },
    [data, files],
  );
  const latestFiles = files.slice(0, 8);

  const filteredFiles = useMemo(() => {
    const keyword = query.trim().toLowerCase();

    return files.filter((file) => {
      const matchesCategory = category === "all" || file.category === category;
      const target = `${file.name ?? ""} ${file.version ?? ""} ${file.android ?? ""} ${
        file.changelog ?? ""
      }`.toLowerCase();
      return matchesCategory && (!keyword || target.includes(keyword));
    });
  }, [category, files, query]);

  const latestDate = files[0]?.date ?? "暂无";

  return (
    <main>
      <section className="hero">
        <nav className="nav">
          <span className="brand">OP6893 中文归档</span>
          <a href="https://github.com/xCaptaiN09/rmx3031-archive" target="_blank">
            上游项目
          </a>
        </nav>

        <div className="heroGrid">
          <div>
            <p className="eyebrow">自动同步 · 中文索引 · 静态部署</p>
            <h1>OP6893 家族刷机资源中文站</h1>
            <p className="summary">
              本站读取 RMX3031 Archive 的公开数据源，整理展示 Realme X7 Max、Realme GT Neo、
              Realme GT Neo Flash 和 OnePlus Nord 2 的 ROM、内核、Recovery、固件和模块等资源。
              下载链接仍指向原始归档地址，本站只做中文索引和导航。
            </p>
            <div className="actions">
              <a className="button primary" href="#archive">
                查看归档
              </a>
              <a className="button" href="https://rmx3031-archive.pages.dev/" target="_blank">
                访问原站
              </a>
            </div>
          </div>

          <div className="panel statsPanel">
            <div>
              <span>支持设备</span>
              <strong className="deviceList">{SUPPORTED_DEVICES.join(" / ")}</strong>
            </div>
            <div>
              <span>代号</span>
              <strong>{data?.codename ?? "OP6893"}</strong>
            </div>
            <div>
              <span>文件数</span>
              <strong>{files.length || "读取中"}</strong>
            </div>
            <div>
              <span>最近更新</span>
              <strong>{latestDate}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="notice">
        <strong>刷机风险提示：</strong>
        请确认机型、分区和 Android 版本匹配后再下载使用。刷机可能导致数据丢失、无法开机或保修失效。
      </section>

      {loading && <section className="state">正在同步上游数据……</section>}
      {error && (
        <section className="state error">
          数据读取失败：{error}。你可以稍后重试，或检查部署环境是否允许访问上游 JSON。
        </section>
      )}

      {!loading && !error && (
        <>
          <section className="section">
            <div className="sectionHeader">
              <p className="eyebrow">Latest</p>
              <h2>最新收录</h2>
            </div>
            <div className="latestGrid">
              {latestFiles.map((file) => (
                <article className="card" key={file.id}>
                  <span className="tag">{file.categoryLabel}</span>
                  <h3>{file.name}</h3>
                  <p>
                    Android {file.android ?? "未知"} · {file.version ? `v${file.version}` : "无版本"} ·{" "}
                    {file.size ?? "未知大小"}
                  </p>
                  <p>{file.date ?? "无日期"}</p>
                  {file.url && (
                    <a href={file.url} target="_blank">
                      下载文件
                    </a>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="section" id="archive">
            <div className="sectionHeader archiveHeader">
              <div>
                <p className="eyebrow">Archive</p>
                <h2>全部资源</h2>
              </div>
              <p className="source">
                数据源：
                <a href={source} target="_blank">
                  {source.includes("github") ? "GitHub Raw" : "原站 index.json"}
                </a>
              </p>
            </div>

            <div className="filters">
              <input
                aria-label="搜索资源"
                placeholder="搜索名称、版本、更新日志……"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <select
                aria-label="筛选分类"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="all">全部分类（{files.length}）</option>
                {categories.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}（{item.count}）
                  </option>
                ))}
              </select>
            </div>

            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th>分类</th>
                    <th>名称</th>
                    <th>Android</th>
                    <th>版本</th>
                    <th>日期</th>
                    <th>大小</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFiles.map((file) => (
                    <tr key={file.id}>
                      <td>
                        <span className="tag">{file.categoryLabel}</span>
                      </td>
                      <td>
                        <strong>{file.name ?? "未命名文件"}</strong>
                        {file.changelog && <small>{file.changelog}</small>}
                      </td>
                      <td>{file.android ?? "—"}</td>
                      <td>{file.version ? `v${file.version}` : "—"}</td>
                      <td>{file.date ?? "—"}</td>
                      <td>{file.size ?? "—"}</td>
                      <td>
                        {file.url ? (
                          <a href={file.url} target="_blank">
                            下载
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <footer>
        <p>
          中文站点模板。上游数据来自 xCaptaiN09/rmx3031-archive；文件版权和刷机风险请以原作者说明为准。
        </p>
      </footer>
    </main>
  );
}
