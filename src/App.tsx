import { useEffect, useMemo, useState, useCallback } from "react";

const DATA_SOURCE = "/index.json";

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
  _synced_at?: string;
  [key: string]: unknown;
};

type FileWithCategory = ArchiveFile & {
  id: string;
  category: string;
  categoryLabel: string;
};

type SortKey = "date" | "name" | "android" | "size" | "version";

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

function parseSizeToBytes(size: string): number {
  const match = size.trim().match(/^([\d.]+)\s*(GB|MB|KB|B)$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  return num * (multipliers[unit] ?? 1);
}

function sortFiles(files: FileWithCategory[], key: SortKey, asc: boolean): FileWithCategory[] {
  return [...files].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "date":
        cmp = ((a.date ? new Date(a.date).getTime() : 0)) - ((b.date ? new Date(b.date).getTime() : 0));
        break;
      case "name":
        cmp = (a.name ?? "").localeCompare(b.name ?? "");
        break;
      case "android":
        cmp = parseFloat(a.android ?? "0") - parseFloat(b.android ?? "0");
        break;
      case "size":
        cmp = parseSizeToBytes(a.size ?? "") - parseSizeToBytes(b.size ?? "");
        break;
      case "version":
        cmp = (a.version ?? "").localeCompare(b.version ?? "");
        break;
    }
    return asc ? cmp : -cmp;
  });
}

function formatChangelog(text: string): string {
  // Split on bullet-like markers: -, *, •, 1., etc.
  return text
    .split(/(?:\s*[-–•*]\s+|\s*\d+\.\s+)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" || ");
}

function renderChangelogHtml(text: string): string {
  const lines = text.split(/\n/).filter(Boolean);
  if (lines.length <= 1 && !text.includes("- ") && !text.includes("• ") && !text.includes("* ")) {
    return text;
  }
  const items = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[-–•*]\s*/, "").trim());
  if (items.length > 1) {
    return "<ul>" + items.map((i) => `<li>${i}</li>`).join("") + "</ul>";
  }
  return text;
}

async function fetchArchiveData(): Promise<{ data: ArchiveData }> {
  const response = await fetch(`${DATA_SOURCE}?t=${Date.now()}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`读取失败：${response.status}`);
  }

  return { data: await response.json() };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "无法读取上游数据";
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    try {
      document.execCommand("copy");
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(el);
    }
  }
}

export default function App() {
  const [data, setData] = useState<ArchiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [sortAsc, setSortAsc] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState("");
  const [showToast, setShowToast] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [showBackToTop, setShowBackToTop] = useState(false);

  // Sync category from URL hash
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace("#", "");
      if (hash && CATEGORY_ORDER.includes(hash)) {
        setCategory(hash);
      } else if (hash === "archive") {
        document.getElementById("archive")?.scrollIntoView({ behavior: "smooth" });
      }
    };
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Update URL hash when category changes
  const handleCategoryChange = useCallback((newCat: string) => {
    setCategory(newCat);
    if (newCat === "all") {
      window.history.replaceState(null, "", window.location.pathname);
    } else {
      window.history.replaceState(null, "", `#${newCat}`);
    }
  }, []);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Show back-to-top button on scroll
  useEffect(() => {
    const onScroll = () => setShowBackToTop(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    fetchArchiveData()
      .then((result) => setData(result.data))
      .catch((fetchError) => setError(getErrorMessage(fetchError)))
      .finally(() => setLoading(false));
  }, []);

  const files = useMemo(() => (data ? flattenFiles(data) : []), [data]);
  const categories = useMemo(
    () => {
      if (!data) return [];
      return getOrderedCategoryKeys(data).map((key) => ({
        key,
        label: formatCategory(key),
        count: files.filter((file) => file.category === key).length,
      }));
    },
    [data, files],
  );
  const latestFiles = useMemo(() => {
    return sortFiles(files, "date", false).slice(0, 8);
  }, [files]);

  const filteredFiles = useMemo(() => {
    const keyword = debouncedQuery;
    const matched = files.filter((file) => {
      const matchesCategory = category === "all" || file.category === category;
      const target = `${file.name ?? ""} ${file.version ?? ""} ${file.android ?? ""} ${file.changelog ?? ""}`.toLowerCase();
      return matchesCategory && (!keyword || target.includes(keyword));
    });
    return sortFiles(matched, sortBy, sortAsc);
  }, [category, files, debouncedQuery, sortBy, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortBy(key);
      setSortAsc(false);
    }
  };

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopy = async (url: string, id: string) => {
    const ok = await copyToClipboard(url);
    setCopiedId(id);
    setShowToast(ok ? "链接已复制" : "复制失败，请手动复制");
    setTimeout(() => { setCopiedId(""); setShowToast(""); }, 2000);
  };

  const latestDate = files[0]?.date ?? "暂无";
  const syncTime = data?._synced_at ?? latestDate;
  const sortIcon = (key: SortKey) => {
    if (sortBy !== key) return " ↕";
    return sortAsc ? " ↑" : " ↓";
  };

  return (
    <main>
      {/* Toast */}
      {showToast && <div className="toast">{showToast}</div>}

      <section className="hero">
        <nav className="nav">
          <span className="brand">OP6893_CN_ARCHIVE</span>
          <a href="https://github.com/xCaptaiN09/rmx3031-archive" target="_blank">
            上游项目
          </a>
        </nav>

        <div className="heroGrid">
          <div className="heroCopy">
            <p className="eyebrow">SYNCED INDEX · OP6893 FAMILY · CN MIRROR UI</p>
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

          <div className="heroConsole">
            <div className="consoleTop">
              <span />
              <span />
              <span />
            </div>
            <div className="consoleScreen">
              <p className="consoleLine">system.boot = OP6893_ARCHIVE_CN</p>
              <p className="consoleLine">sync.source = CLOUDFLARE_EDGE</p>
              <p className="consoleLine">device.codename = {data?.codename ?? "OP6893"}</p>
              <p className="consoleLine">records.total = {files.length || "..."}</p>
              <p className="consoleLine">sync.updated = {syncTime}</p>
              <div className="signalRing">
                <span>{files.length || "—"}</span>
                <small>FILES</small>
              </div>
            </div>
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
            <span>数据更新</span>
            <strong className="syncTime">{syncTime}</strong>
          </div>
          <div>
            <span>文件总数</span>
            <strong>{files.length || "读取中"}</strong>
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
              <div>
                <p className="eyebrow">Latest Builds</p>
                <h2>最新收录</h2>
              </div>
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
                <p className="eyebrow">Data Matrix · {syncTime}</p>
                <h2>全部资源</h2>
              </div>
              <p className="source">
                数据缓存于 Cloudflare 边缘节点，由 GitHub Actions 每日同步。
              </p>
            </div>

            <div className="categoryRail" aria-label="资源分类">
              <button
                className={category === "all" ? "active" : ""}
                type="button"
                onClick={() => handleCategoryChange("all")}
              >
                全部
                <span>{files.length}</span>
              </button>
              {categories.map((item) => (
                <button
                  className={category === item.key ? "active" : ""}
                  key={item.key}
                  type="button"
                  onClick={() => handleCategoryChange(item.key)}
                >
                  {item.label}
                  <span>{item.count}</span>
                </button>
              ))}
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
                onChange={(event) => handleCategoryChange(event.target.value)}
              >
                <option value="all">全部分类（{files.length}）</option>
                {categories.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}（{item.count}）
                  </option>
                ))}
              </select>
            </div>

            <div className="resultCount">
              共找到 <strong>{filteredFiles.length}</strong> 个资源
              {debouncedQuery && <>，匹配 "<strong>{debouncedQuery}</strong>"</>}
            </div>

            {/* Desktop table */}
            <div className="tableWrap desktopOnly">
              <table>
                <thead>
                  <tr>
                    <th>分类</th>
                    <th className="sortable" onClick={() => handleSort("name")}>
                      名称{sortIcon("name")}
                    </th>
                    <th className="sortable" onClick={() => handleSort("android")}>
                      Android{sortIcon("android")}
                    </th>
                    <th className="sortable" onClick={() => handleSort("version")}>
                      版本{sortIcon("version")}
                    </th>
                    <th className="sortable" onClick={() => handleSort("date")}>
                      日期{sortIcon("date")}
                    </th>
                    <th className="sortable" onClick={() => handleSort("size")}>
                      大小{sortIcon("size")}
                    </th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFiles.map((file) => {
                    const isExpanded = expandedRows.has(file.id);
                    const changelog = file.changelog ?? "";
                    return (
                      <tr
                        key={file.id}
                        className={`${isExpanded ? "expanded" : ""} ${changelog ? "clickable" : ""}`}
                      >
                        <td>
                          <span className="tag">{file.categoryLabel}</span>
                        </td>
                        <td>
                          <strong
                            className={changelog ? "expandToggle" : ""}
                            onClick={() => changelog && toggleRow(file.id)}
                            title={changelog ? (isExpanded ? "点击收起" : "点击展开日志") : ""}
                          >
                            {file.name ?? "未命名文件"}
                            {changelog && <span className="expandIcon">{isExpanded ? " ▾" : " ▸"}</span>}
                          </strong>
                          {changelog && !isExpanded && (
                            <small className="changelogPreview">{formatChangelog(changelog)}</small>
                          )}
                          {changelog && isExpanded && (
                            <div
                              className="changelogFull"
                              dangerouslySetInnerHTML={{ __html: renderChangelogHtml(changelog) }}
                            />
                          )}
                        </td>
                        <td>{file.android ?? "—"}</td>
                        <td>{file.version ? `v${file.version}` : "—"}</td>
                        <td>{file.date ?? "—"}</td>
                        <td>{file.size ?? "—"}</td>
                        <td className="actionsCell">
                          {file.url && (
                            <>
                              <a href={file.url} target="_blank" onClick={(e) => e.stopPropagation()}>
                                下载
                              </a>
                              <button
                                className="copyBtn"
                                type="button"
                                title="复制下载链接"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopy(file.url!, file.id);
                                }}
                              >
                                {copiedId === file.id ? "✓" : "⎘"}
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredFiles.length === 0 && (
                <div style={{ padding: "32px", textAlign: "center", color: "#7e97ad" }}>
                  没有匹配的资源，试试调整筛选条件。
                </div>
              )}
            </div>

            {/* Mobile card view */}
            <div className="mobileCards">
              {filteredFiles.map((file) => {
                const isExpanded = expandedRows.has(file.id);
                const changelog = file.changelog ?? "";
                return (
                  <article
                    className="mobileCard"
                    key={file.id}
                  >
                    <div className="mobileCardHeader">
                      <span className="tag">{file.categoryLabel}</span>
                      <span className="mobileCardDate">{file.date ?? "—"}</span>
                    </div>
                    <h4
                      className={changelog ? "expandToggle" : ""}
                      onClick={() => changelog && toggleRow(file.id)}
                    >
                      {file.name ?? "未命名文件"}
                      {changelog && <span className="expandIcon">{isExpanded ? " ▾" : " ▸"}</span>}
                    </h4>
                    <div className="mobileCardMeta">
                      <span>Android {file.android ?? "—"}</span>
                      <span>{file.version ? `v${file.version}` : "—"}</span>
                      <span>{file.size ?? "—"}</span>
                    </div>
                    {changelog && isExpanded && (
                      <div
                        className="changelogFull"
                        dangerouslySetInnerHTML={{ __html: renderChangelogHtml(changelog) }}
                      />
                    )}
                    {changelog && !isExpanded && (
                      <small className="changelogPreview">{formatChangelog(changelog)}</small>
                    )}
                    {file.url && (
                      <div className="mobileCardActions">
                        <a href={file.url} target="_blank" onClick={(e) => e.stopPropagation()}>
                          下载
                        </a>
                        <button
                          className="copyBtn"
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopy(file.url!, file.id);
                          }}
                        >
                          {copiedId === file.id ? "✓ 已复制" : "⎘ 复制链接"}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
              {filteredFiles.length === 0 && (
                <div style={{ padding: "32px", textAlign: "center", color: "#7e97ad" }}>
                  没有匹配的资源，试试调整筛选条件。
                </div>
              )}
            </div>
          </section>
        </>
      )}

      {showBackToTop && (
        <button
          className="backToTop"
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="回到顶部"
          title="回到顶部"
        >
          ↑
        </button>
      )}

      <section className="section sponsorSection">
        <div className="sponsorCard">
          <div className="sponsorCopy">
            <p className="eyebrow">SUPPORT THE PROJECT</p>
            <h2>赞助支持</h2>
            <p>
              如果你觉得本站有用，欢迎请我喝杯咖啡。你的支持是我持续维护的动力。
            </p>
          </div>
          <div className="sponsorQr">
            <img src="/sponsor-qrcode.png" alt="赞助二维码" />
            <span>微信扫码赞助</span>
          </div>
        </div>
      </section>

      <footer>
        <p>
          数据每日由 GitHub Actions 自动同步，源码托管于 GitHub。上游数据来自 xCaptaiN09/rmx3031-archive；文件版权和刷机风险请以原作者说明为准。
        </p>
      </footer>
    </main>
  );
}