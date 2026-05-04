import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./config.js";

const FeedStatusCharts = lazy(() => import("./FeedStatusCharts.jsx"));

async function getJson(path) {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${path}`);
  }
  return res.json();
}

const TZ_STORAGE_KEY = "scheduler-display-tz";
const THEME_STORAGE_KEY = "scheduler-theme";

/** IANA zone id or "local" (browser default). */
const DISPLAY_TIMEZONES = [
  { value: "local", label: "Local" },
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "New York" },
  { value: "America/Chicago", label: "Chicago" },
  { value: "America/Denver", label: "Denver" },
  { value: "America/Los_Angeles", label: "Los Angeles" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Europe/Berlin", label: "Berlin" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Asia/Shanghai", label: "Shanghai" },
  { value: "Australia/Sydney", label: "Sydney" },
];

function formatTime(iso, timeZone) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    const opts = { dateStyle: "short", timeStyle: "medium" };
    if (timeZone && timeZone !== "local") {
      opts.timeZone = timeZone;
    }
    return d.toLocaleString(undefined, opts);
  } catch {
    return iso;
  }
}

function Message({ text, type }) {
  if (!text) return null;
  const cls = type === "success" ? "message success" : type === "error" ? "message error" : "message";
  return <p className={cls}>{text}</p>;
}

export default function App() {
  const [feeds, setFeeds] = useState([]);
  const [channels, setChannels] = useState([]);
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const prevSelectedRef = useRef("");

  const [runs, setRuns] = useState([]);
  const [entries, setEntries] = useState([]);
  const [assets, setAssets] = useState([]);

  const [channelServiceId, setChannelServiceId] = useState("");
  const [mrssUrl, setMrssUrl] = useState("");
  const [xmlFilePath, setXmlFilePath] = useState("");
  const [fetchInterval, setFetchInterval] = useState(900);
  const [enabled, setEnabled] = useState(true);

  const [registerMessage, setRegisterMessage] = useState({ text: "", type: "" });
  const [generateMessage, setGenerateMessage] = useState({ text: "", type: "" });

  const [refreshBusy, setRefreshBusy] = useState(false);
  const [generateBusy, setGenerateBusy] = useState(false);

  const [activeTab, setActiveTab] = useState("dashboard");
  const [registerModalOpen, setRegisterModalOpen] = useState(false);

  const [displayTimeZone, setDisplayTimeZone] = useState(() => {
    try {
      const raw = localStorage.getItem(TZ_STORAGE_KEY);
      if (raw && DISPLAY_TIMEZONES.some((z) => z.value === raw)) {
        return raw;
      }
    } catch {
      /* ignore */
    }
    return "local";
  });

  useEffect(() => {
    try {
      localStorage.setItem(TZ_STORAGE_KEY, displayTimeZone);
    } catch {
      /* ignore */
    }
  }, [displayTimeZone]);

  const [colorScheme, setColorScheme] = useState(() => {
    try {
      const t = localStorage.getItem(THEME_STORAGE_KEY);
      if (t === "light" || t === "dark") {
        return t;
      }
    } catch {
      /* ignore */
    }
    return "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", colorScheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, colorScheme);
    } catch {
      /* ignore */
    }
  }, [colorScheme]);

  const formatTimeTz = useCallback(
    (iso) => formatTime(iso, displayTimeZone),
    [displayTimeZone]
  );

  const activeRunsCount = runs.filter((r) => r.is_active).length;
  const failedRunsCount = runs.filter((r) => String(r.status).toLowerCase() === "failed").length;

  const loadChannel = useCallback(async (channelId) => {
    const [r, e, a] = await Promise.all([
      getJson(`/channels/${encodeURIComponent(channelId)}/runs`),
      getJson(`/channels/${encodeURIComponent(channelId)}/schedule/active`),
      getJson(`/channels/${encodeURIComponent(channelId)}/assets`),
    ]);
    setRuns(r);
    setEntries(e);
    setAssets(a);
  }, []);

  const loadData = useCallback(async () => {
    const preserve = prevSelectedRef.current;
    const [f, ch] = await Promise.all([getJson("/feeds"), getJson("/channels")]);
    setFeeds(f);
    setChannels(ch);

    if (ch.length > 0) {
      const selectedId = ch.some((c) => c.channel_service_id === preserve)
        ? preserve
        : ch[0].channel_service_id;
      setSelectedChannelId(selectedId);
      prevSelectedRef.current = selectedId;
      await loadChannel(selectedId);
    } else {
      setSelectedChannelId("");
      prevSelectedRef.current = "";
      setRuns([]);
      setEntries([]);
      setAssets([]);
    }
  }, [loadChannel]);

  useEffect(() => {
    loadData().catch((err) => {
      console.error(err);
      setGenerateMessage({ text: `Initial load failed: ${err.message}`, type: "error" });
    });
  }, [loadData]);

  const selectChannel = useCallback(
    async (id, opts = {}) => {
      const quiet = opts.quiet ?? true;
      setSelectedChannelId(id);
      prevSelectedRef.current = id;
      try {
        await loadChannel(id);
        if (!quiet) {
          setGenerateMessage({ text: `Loaded ${id}.`, type: "success" });
        }
      } catch (err) {
        console.error(err);
        setGenerateMessage({ text: `Load failed: ${err.message}`, type: "error" });
      }
    },
    [loadChannel]
  );

  const handleRefresh = async () => {
    setRefreshBusy(true);
    try {
      await loadData();
      setGenerateMessage({ text: "Data refreshed.", type: "success" });
    } catch (err) {
      console.error(err);
      setGenerateMessage({ text: `Refresh failed: ${err.message}`, type: "error" });
    } finally {
      setRefreshBusy(false);
    }
  };

  const handleChannelSelectChange = (e) => {
    selectChannel(e.target.value, { quiet: false });
  };

  const handleRegisterSubmit = async (ev) => {
    ev.preventDefault();
    setRegisterMessage({ text: "", type: "" });
    const payload = {
      channel_service_id: channelServiceId.trim(),
      mrss_url: mrssUrl.trim(),
      xml_file_path: xmlFilePath.trim() || null,
      fetch_interval_seconds: Number(fetchInterval),
      enabled,
    };
    try {
      const res = await fetch(`${API_BASE_URL}/channels/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed: ${res.status}`);
      }
      const data = await res.json();
      setChannelServiceId("");
      setMrssUrl("");
      setXmlFilePath("");
      setFetchInterval(900);
      setEnabled(true);
      prevSelectedRef.current = data.channel_service_id;
      await loadData();
      setRegisterModalOpen(false);
      setRegisterMessage({ text: "", type: "" });
      setGenerateMessage({
        text: `Registered ${data.channel_service_id} and ingested ${data.assets_upserted} assets.`,
        type: "success",
      });
    } catch (err) {
      console.error(err);
      setRegisterMessage({ text: `Registration failed: ${err.message}`, type: "error" });
    }
  };

  const closeRegisterModal = () => {
    setRegisterModalOpen(false);
    setRegisterMessage({ text: "", type: "" });
  };

  const handleGenerate = async () => {
    if (!selectedChannelId) {
      setGenerateMessage({ text: "Select a channel first.", type: "error" });
      return;
    }
    setGenerateBusy(true);
    setGenerateMessage({ text: "Generating schedule...", type: "" });
    try {
      const res = await fetch(
        `${API_BASE_URL}/channels/${encodeURIComponent(selectedChannelId)}/schedule/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            window_hours: 24,
            trigger_type: "manual",
            schedule_type: "binge",
          }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed: ${res.status}`);
      }
      const data = await res.json();
      setGenerateMessage({
        text: `Generated run ${data.run_id} with ${data.entry_count} entries.`,
        type: "success",
      });
      await loadChannel(selectedChannelId);
    } catch (err) {
      console.error(err);
      setGenerateMessage({ text: `Generate failed: ${err.message}`, type: "error" });
    } finally {
      setGenerateBusy(false);
    }
  };

  const handleDownload = async () => {
    if (!selectedChannelId) {
      setGenerateMessage({ text: "Select a channel first.", type: "error" });
      return;
    }
    try {
      const res = await fetch(
        `${API_BASE_URL}/channels/${encodeURIComponent(selectedChannelId)}/schedule/active/download`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed: ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${selectedChannelId}_active_schedule.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setGenerateMessage({ text: "Active schedule JSON downloaded.", type: "success" });
    } catch (err) {
      console.error(err);
      setGenerateMessage({ text: `Download failed: ${err.message}`, type: "error" });
    }
  };

  const noChannel = channels.length === 0;

  const tabs = [
    { id: "dashboard", label: "Dashboard" },
    { id: "channels", label: "Channels" },
    { id: "schedule", label: "Schedule" },
    { id: "assets", label: "Assets" },
  ];

  const registerForm = (
    <form className="form-grid" onSubmit={handleRegisterSubmit}>
      <div>
        <label htmlFor="modal-channelServiceId">Channel Service ID</label>
        <input
          id="modal-channelServiceId"
          value={channelServiceId}
          onChange={(e) => setChannelServiceId(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="modal-mrssUrl">MRSS URL</label>
        <input
          id="modal-mrssUrl"
          type="url"
          value={mrssUrl}
          onChange={(e) => setMrssUrl(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="modal-xmlFilePath">XML File Path (optional)</label>
        <input
          id="modal-xmlFilePath"
          value={xmlFilePath}
          onChange={(e) => setXmlFilePath(e.target.value)}
          placeholder="/absolute/path/to/feed.xml"
        />
      </div>
      <div>
        <label htmlFor="modal-fetchInterval">Fetch Interval (seconds)</label>
        <input
          id="modal-fetchInterval"
          type="number"
          min={1}
          value={fetchInterval}
          onChange={(e) => setFetchInterval(Number(e.target.value))}
          required
        />
      </div>
      <div>
        <label htmlFor="modal-enabled">Enabled</label>
        <select
          id="modal-enabled"
          value={enabled ? "true" : "false"}
          onChange={(e) => setEnabled(e.target.value === "true")}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </div>
      <div className="form-actions modal-actions">
        <button type="button" className="btn-secondary" onClick={closeRegisterModal}>
          Cancel
        </button>
        <button type="submit">Save channel</button>
      </div>
    </form>
  );

  return (
    <div className="app-frame">
      <header className="topbar">
        <div className="page-shell topbar-inner">
          <div className="topbar-title">
            <h1>Channel Scheduler</h1>
            <p className="subtitle">Feeds, channels, schedule, and assets.</p>
          </div>
          <div className="topbar-meta">
            <div
              className="channel-field"
              title="Applies to Dashboard scope, Schedule, and Assets. Also updates when you pick a row on Channels."
            >
              <label htmlFor="global-channelSelect" className="timezone-label">
                Channel
              </label>
              <select
                id="global-channelSelect"
                className="timezone-select channel-select"
                value={selectedChannelId}
                onChange={handleChannelSelectChange}
                disabled={noChannel}
                aria-label="Active channel for schedule and assets"
              >
                {channels.length === 0 ? (
                  <option value="">—</option>
                ) : (
                  channels.map((c) => (
                    <option key={c.channel_service_id} value={c.channel_service_id}>
                      {c.channel_service_id}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="timezone-field" title="All schedule and feed times use this time zone.">
              <label htmlFor="display-tz" className="timezone-label">
                Time zone
              </label>
              <select
                id="display-tz"
                className="timezone-select"
                value={displayTimeZone}
                onChange={(e) => setDisplayTimeZone(e.target.value)}
              >
                {DISPLAY_TIMEZONES.map((z) => (
                  <option key={z.value} value={z.value}>
                    {z.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="theme-toggle-field" title="Interface color theme">
              <span className="theme-toggle-label">Theme</span>
              <button
                type="button"
                className="theme-toggle"
                role="switch"
                aria-checked={colorScheme === "light"}
                aria-label={colorScheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                onClick={() => setColorScheme((s) => (s === "dark" ? "light" : "dark"))}
              >
                <span className="theme-toggle-knob" aria-hidden />
              </button>
              <span className="theme-toggle-name">{colorScheme === "dark" ? "Dark" : "Light"}</span>
            </div>
            <button type="button" onClick={handleRefresh} disabled={refreshBusy}>
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="layout page-shell">
        <nav className="tab-bar" role="tablist" aria-label="Main sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={activeTab === t.id}
              aria-controls={`panel-${t.id}`}
              className={`tab ${activeTab === t.id ? "active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {activeTab === "dashboard" && (
          <div className="tab-panel" id="panel-dashboard" role="tabpanel" aria-labelledby="tab-dashboard">
            <p className="tab-lede">
              Scope uses the channel selected in the header. Feed charts are global. Hover chart areas for full URL and
              details.
            </p>

            <section className="card">
              <h2 className="card-title">Scope &amp; run matrix</h2>
              <div
                className="kpi-matrix"
                role="grid"
                aria-label="Dashboard counts: feeds, channels, active and failed runs for selected channel"
              >
                <div className="kpi-matrix-grid" role="presentation">
                  <div className="kpi-cell" role="gridcell" title="MRSS feeds registered">
                    <span className="kpi-cell-value">{feeds.length}</span>
                    <span className="kpi-cell-axis">Feeds</span>
                  </div>
                  <div className="kpi-cell" role="gridcell" title="Channel mappings">
                    <span className="kpi-cell-value">{channels.length}</span>
                    <span className="kpi-cell-axis">Channels</span>
                  </div>
                  <div className="kpi-cell" role="gridcell" title="Active schedule runs (this channel)">
                    <span className="kpi-cell-value">{activeRunsCount}</span>
                    <span className="kpi-cell-axis">Active</span>
                  </div>
                  <div className="kpi-cell kpi-cell-fail" role="gridcell" title="Failed schedule runs (this channel)">
                    <span className="kpi-cell-value">{failedRunsCount}</span>
                    <span className="kpi-cell-axis">Failed</span>
                  </div>
                </div>
              </div>
            </section>

            <section className="card">
              <h2 className="card-title">Feed health</h2>
              {feeds.length === 0 ? (
                <p className="channel-info">No feeds.</p>
              ) : (
                <Suspense fallback={<p className="channel-info">Loading charts…</p>}>
                  <FeedStatusCharts feeds={feeds} formatTimeTz={formatTimeTz} colorScheme={colorScheme} />
                </Suspense>
              )}
            </section>
          </div>
        )}

        {activeTab === "channels" && (
          <div className="tab-panel" id="panel-channels" role="tabpanel" aria-labelledby="tab-channels">
            <div className="channels-toolbar">
              <p className="tab-lede" style={{ margin: 0, flex: "1 1 240px" }}>
                Click a row or change Channel in the header. Register adds a new mapping.
              </p>
              <button type="button" onClick={() => setRegisterModalOpen(true)}>
                Register channel
              </button>
            </div>

            <section className="card">
              <h2 className="card-title">Channels</h2>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Channel ID</th>
                      <th>Feed ID</th>
                      <th>MRSS URL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="empty">
                          No channels yet. Register one to begin.
                        </td>
                      </tr>
                    ) : (
                      channels.map((c) => (
                        <tr
                          key={c.channel_service_id}
                          className={`channel-row ${selectedChannelId === c.channel_service_id ? "selected" : ""}`}
                          onClick={() => selectChannel(c.channel_service_id)}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault();
                              selectChannel(c.channel_service_id);
                            }
                          }}
                          tabIndex={0}
                          role="button"
                          aria-label={`Select channel ${c.channel_service_id}`}
                        >
                          <td>{c.channel_service_id}</td>
                          <td className="cell-mono">{c.mrss_feed_id}</td>
                          <td className="cell-mono">{c.mrss_url}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {registerModalOpen && (
              <div
                className="modal-backdrop"
                role="presentation"
                onClick={closeRegisterModal}
              >
                <div
                  className="modal"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="register-modal-title"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="modal-header">
                    <h3 id="register-modal-title">Register channel</h3>
                    <button type="button" className="btn-icon" onClick={closeRegisterModal} aria-label="Close">
                      ×
                    </button>
                  </div>
                  <p className="modal-lede">Maps a channel to an MRSS URL and ingests.</p>
                  {registerForm}
                  <Message text={registerMessage.text} type={registerMessage.type} />
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "schedule" && (
          <div className="tab-panel stack-gap-sm" id="panel-schedule" role="tabpanel" aria-labelledby="tab-schedule">
            <p className="tab-lede">
              Uses the channel selected in the header. Generate or download schedule; review runs and the active playlist.
            </p>

            <div className="schedule-toolbar">
              <div className="schedule-toolbar-row schedule-toolbar-row--actions">
                <div className="schedule-toolbar-actions">
                  <button type="button" onClick={handleGenerate} disabled={noChannel || generateBusy}>
                    Generate
                  </button>
                  <button type="button" onClick={handleDownload} disabled={noChannel}>
                    Download JSON
                  </button>
                </div>
              </div>
              <Message text={generateMessage.text} type={generateMessage.type} />
            </div>

            <section className="card">
              <h2 className="card-title">Run history</h2>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Run ID</th>
                      <th>Status</th>
                      <th>Active</th>
                      <th>Entries</th>
                      <th>Created</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="empty">
                          {noChannel ? "No runs yet." : "No runs for this channel."}
                        </td>
                      </tr>
                    ) : (
                      runs.map((r) => (
                        <tr key={r.id}>
                          <td className="cell-mono">{r.id}</td>
                          <td>
                            <span className={`status ${String(r.status).toLowerCase()}`}>{r.status}</span>
                          </td>
                          <td>{String(!!r.is_active)}</td>
                          <td>{r.generated_entry_count ?? 0}</td>
                          <td>{formatTimeTz(r.created_at)}</td>
                          <td>{r.error_message ?? "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <details className="playlist-details">
              <summary className="playlist-summary">
                <span className="playlist-summary-start">
                  <span className="playlist-chevron" aria-hidden />
                  <span className="playlist-summary-title">Active playlist</span>
                </span>
                <span className="playlist-summary-meta">{entries.length} rows</span>
              </summary>
              <div className="playlist-details-body">
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Start</th>
                        <th>End</th>
                        <th>Asset</th>
                        <th>Type</th>
                        <th>Title</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="empty">
                            No active schedule rows.
                          </td>
                        </tr>
                      ) : (
                        entries.map((e) => (
                          <tr key={`${e.sequence_no}-${e.starts_at}`}>
                            <td>{e.sequence_no}</td>
                            <td>{formatTimeTz(e.starts_at)}</td>
                            <td>{formatTimeTz(e.ends_at)}</td>
                            <td className="cell-mono">{e.asset_id}</td>
                            <td>{e.asset_type}</td>
                            <td>{e.title ?? "—"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          </div>
        )}

        {activeTab === "assets" && (
          <div className="tab-panel" id="panel-assets" role="tabpanel" aria-labelledby="tab-assets">
            <p className="tab-lede">Catalog for the channel selected in the header.</p>

            <section className="card">
              <h2 className="card-title">Catalog</h2>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Asset ID</th>
                      <th>Type</th>
                      <th>S</th>
                      <th>E</th>
                      <th>Duration</th>
                      <th>Valid from</th>
                      <th>Valid to</th>
                      <th>Title</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assets.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="empty">
                          {noChannel ? "No channel configured." : "No assets for this channel."}
                        </td>
                      </tr>
                    ) : (
                      assets.map((a) => (
                        <tr key={a.asset_id}>
                          <td className="cell-mono">{a.asset_id}</td>
                          <td>{a.asset_type}</td>
                          <td>{a.season_number ?? "—"}</td>
                          <td>{a.episode_number ?? "—"}</td>
                          <td>{a.duration_ms ?? "—"}</td>
                          <td>{formatTimeTz(a.valid_from)}</td>
                          <td>{formatTimeTz(a.valid_to)}</td>
                          <td>{a.title ?? "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
