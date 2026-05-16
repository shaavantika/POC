import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "./config.js";

const ChannelsByCountryChart = lazy(() => import("./ChannelsByCountryChart.jsx"));

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
const LICENSE_EXPIRY_ALERT_DAYS = 7;

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

function formatDurationDaysHours(totalMs) {
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return "0d 0h";
  }
  const totalHours = Math.floor(totalMs / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h`;
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Short label for last HTTP response after an MRSS poll (feed row from /feeds). */
function formatMrssPollHttpStatus(feed) {
  if (!feed.last_fetch_at && feed.last_http_status == null) {
    return "Not polled yet";
  }
  if (feed.last_http_status == null) {
    return "—";
  }
  const n = Number(feed.last_http_status);
  if (Number.isNaN(n)) {
    return String(feed.last_http_status);
  }
  if (n >= 200 && n < 300) {
    return `${n} OK`;
  }
  if (n >= 400) {
    return `${n} error`;
  }
  return String(n);
}

/** ISO timestamp + offset ms (cue position within parent row). */
function offsetIso(baseIso, offsetMs) {
  const t = new Date(baseIso).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(offsetMs)) {
    return baseIso;
  }
  return new Date(t + offsetMs).toISOString();
}

/** API may omit slate_plan or use alternate keys; normalize for rendering. */
function normalizeSlateSlots(plan) {
  if (!Array.isArray(plan)) {
    return [];
  }
  return plan
    .map((s) => ({
      cue_point_ms: Number(s?.cue_point_ms ?? s?.cuePointMs),
      slate_asset_id: String(s?.slate_asset_id ?? s?.slateAssetId ?? "").trim(),
      slate_duration_ms: Math.max(
        1,
        Number.isFinite(Number(s?.slate_duration_ms ?? s?.slateDurationMs))
          ? Number(s.slate_duration_ms ?? s.slateDurationMs)
          : 1
      ),
    }))
    .filter((s) => s.slate_asset_id && Number.isFinite(s.cue_point_ms));
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

  const [editingEntry, setEditingEntry] = useState(null);
  const [editAssetId, setEditAssetId] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editMessage, setEditMessage] = useState({ text: "", type: "" });

  const [insertAfterEntry, setInsertAfterEntry] = useState(null);
  const [insertAssetId, setInsertAssetId] = useState("");
  const [insertBusy, setInsertBusy] = useState(false);
  const [insertMessage, setInsertMessage] = useState({ text: "", type: "" });

  const [channelServiceId, setChannelServiceId] = useState("");
  const [channelName, setChannelName] = useState("");
  const [country, setCountry] = useState("");
  const [mrssUrl, setMrssUrl] = useState("");
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

  const assetTitleById = useMemo(() => {
    const m = new Map();
    for (const a of assets) {
      m.set(a.asset_id, a.title ?? null);
    }
    return m;
  }, [assets]);

  const visibleSlateSlots = (e) =>
    normalizeSlateSlots(e.slate_plan).filter((slot) => {
      const slotStart = new Date(e.starts_at).getTime() + slot.cue_point_ms;
      return slotStart < new Date(e.ends_at).getTime();
    });

  const playlistRowCount = useMemo(() => {
    return entries.reduce((acc, e) => acc + 1 + visibleSlateSlots(e).length, 0);
  }, [entries]);

  const activeRunsCount = runs.filter((r) => r.is_active).length;
  const failedRunsCount = runs.filter((r) => String(r.status).toLowerCase() === "failed").length;
  const totalRunsCount = runs.length;
  const totalAssetsCount = assets.length;
  const assetTypeCounts = assets.reduce((acc, a) => {
    const type = String(a.asset_type || "").trim().toLowerCase();
    if (!type) return acc;
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});
  const availableAssetTypeEntries = Object.entries(assetTypeCounts).sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  const activeScheduleRowsCount = entries.length;
  const nowMs = Date.now();
  const availableScheduleMs = entries.reduce((acc, e) => {
    const start = new Date(e.starts_at).getTime();
    const end = new Date(e.ends_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return acc;
    const effectiveStart = Math.max(start, nowMs);
    return acc + Math.max(0, end - effectiveStart);
  }, 0);
  const availableScheduleDaysHours = formatDurationDaysHours(availableScheduleMs);
  const soonWindowEndMs = nowMs + LICENSE_EXPIRY_ALERT_DAYS * 24 * 60 * 60 * 1000;
  const expiringSoonByType = assets.reduce((acc, a) => {
    if (!a.valid_to) return acc;
    const validToMs = new Date(a.valid_to).getTime();
    if (!Number.isFinite(validToMs) || !(validToMs >= nowMs && validToMs <= soonWindowEndMs)) {
      return acc;
    }
    const type = String(a.asset_type || "unknown").trim().toLowerCase();
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});
  const expiredByType = assets.reduce((acc, a) => {
    if (!a.valid_to) return acc;
    const validToMs = new Date(a.valid_to).getTime();
    if (!Number.isFinite(validToMs) || validToMs >= nowMs) return acc;
    const type = String(a.asset_type || "unknown").trim().toLowerCase();
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});
  const expiringSoonCount = Object.values(expiringSoonByType).reduce((sum, count) => sum + count, 0);
  const expiredCount = Object.values(expiredByType).reduce((sum, count) => sum + count, 0);
  const expiringSoonTypeText = Object.entries(expiringSoonByType)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type}: ${count}`)
    .join(" | ");
  const expiredTypeText = Object.entries(expiredByType)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type}: ${count}`)
    .join(" | ");

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

  const handleOpenSchedule = async (channelId) => {
    setActiveTab("schedule");
    await selectChannel(channelId, { quiet: false });
  };

  const handleDashboardCardNavigate = (target) => {
    if (target === "channels") {
      setActiveTab("channels");
      return;
    }
    if (target === "schedule") {
      setActiveTab("schedule");
    }
  };

  const handleRegisterSubmit = async (ev) => {
    ev.preventDefault();
    setRegisterMessage({ text: "", type: "" });
    const trimmedChannelServiceId = channelServiceId.trim();
    const trimmedCountry = country.trim();
    const trimmedMrssUrl = mrssUrl.trim();
    if (
      trimmedChannelServiceId &&
      trimmedCountry &&
      !trimmedChannelServiceId.toUpperCase().startsWith(trimmedCountry.toUpperCase())
    ) {
      setRegisterMessage({
        text: "Channel Service ID must start with the country code.",
        type: "error",
      });
      return;
    }
    if (!isValidHttpUrl(trimmedMrssUrl)) {
      setRegisterMessage({
        text: "MRSS URL must be a valid http/https URL.",
        type: "error",
      });
      return;
    }
    const payload = {
      channel_service_id: trimmedChannelServiceId,
      channel_name: channelName.trim(),
      country: trimmedCountry,
      mrss_url: trimmedMrssUrl,
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
      setChannelName("");
      setCountry("");
      setMrssUrl("");
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

  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const isWithinEditWindow = (entry) => {
    const start = new Date(entry.starts_at).getTime();
    const now = Date.now();
    return start > now && start <= now + TWO_HOURS_MS;
  };

  const handleDeleteEntry = async (entry) => {
    if (!window.confirm(`Remove "${entry.title ?? entry.asset_id}" from the schedule?`)) return;
    try {
      const res = await fetch(
        `${API_BASE_URL}/channels/${encodeURIComponent(selectedChannelId)}/schedule/entries/${entry.sequence_no}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed: ${res.status}`);
      }
      setGenerateMessage({ text: `Entry #${entry.sequence_no} removed from schedule.`, type: "success" });
      await loadChannel(selectedChannelId);
    } catch (err) {
      console.error(err);
      setGenerateMessage({ text: `Delete failed: ${err.message}`, type: "error" });
    }
  };

  const handleOpenEdit = (entry) => {
    setEditingEntry(entry);
    setEditAssetId(entry.asset_id);
    setEditMessage({ text: "", type: "" });
  };

  const handleCloseEdit = () => {
    setEditingEntry(null);
    setEditAssetId("");
    setEditMessage({ text: "", type: "" });
  };

  const handleSaveEdit = async () => {
    if (!editingEntry || !editAssetId) return;
    setEditBusy(true);
    try {
      const res = await fetch(
        `${API_BASE_URL}/channels/${encodeURIComponent(selectedChannelId)}/schedule/entries/${editingEntry.sequence_no}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asset_id: editAssetId }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed: ${res.status}`);
      }
      setGenerateMessage({ text: `Entry #${editingEntry.sequence_no} updated.`, type: "success" });
      handleCloseEdit();
      await loadChannel(selectedChannelId);
    } catch (err) {
      console.error(err);
      setEditMessage({ text: `Update failed: ${err.message}`, type: "error" });
    } finally {
      setEditBusy(false);
    }
  };

  const handleOpenInsert = (entry) => {
    setInsertAfterEntry(entry);
    setInsertAssetId(assets.length > 0 ? assets[0].asset_id : "");
    setInsertMessage({ text: "", type: "" });
  };

  const handleCloseInsert = () => {
    setInsertAfterEntry(null);
    setInsertAssetId("");
    setInsertMessage({ text: "", type: "" });
  };

  const handleSaveInsert = async () => {
    if (!insertAfterEntry || !insertAssetId) return;
    setInsertBusy(true);
    try {
      const res = await fetch(
        `${API_BASE_URL}/channels/${encodeURIComponent(selectedChannelId)}/schedule/entries/${insertAfterEntry.sequence_no}/insert-after`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asset_id: insertAssetId }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed: ${res.status}`);
      }
      setGenerateMessage({ text: `Program inserted after entry #${insertAfterEntry.sequence_no}.`, type: "success" });
      handleCloseInsert();
      await loadChannel(selectedChannelId);
    } catch (err) {
      console.error(err);
      setInsertMessage({ text: `Insert failed: ${err.message}`, type: "error" });
    } finally {
      setInsertBusy(false);
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
        <label htmlFor="modal-channelServiceId">
          Channel Service ID <span className="required-mark">*</span>
        </label>
        <input
          id="modal-channelServiceId"
          value={channelServiceId}
          onChange={(e) => setChannelServiceId(e.target.value)}
          placeholder="e.g. US_channel_001"
          required
        />
      </div>
      <div>
        <label htmlFor="modal-channelName">
          Channel Name <span className="required-mark">*</span>
        </label>
        <input
          id="modal-channelName"
          value={channelName}
          onChange={(e) => setChannelName(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="modal-country">
          Country <span className="required-mark">*</span>
        </label>
        <input
          id="modal-country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          placeholder="e.g. US"
          maxLength={64}
          required
        />
      </div>
      <div>
        <label htmlFor="modal-mrssUrl">
          MRSS URL <span className="required-mark">*</span>
        </label>
        <input
          id="modal-mrssUrl"
          type="url"
          value={mrssUrl}
          onChange={(e) => setMrssUrl(e.target.value)}
          placeholder="https://example.com/feed.xml"
          pattern="https?://.+"
          title="Enter a valid MRSS URL starting with http:// or https://"
          required
        />
      </div>
      <div>
        <label htmlFor="modal-enabled">
          Auto MRSS Polling <span className="required-mark">*</span>
        </label>
        <select
          id="modal-enabled"
          value={enabled ? "true" : "false"}
          onChange={(e) => setEnabled(e.target.value === "true")}
          title="When enabled, AWS scheduled polling will fetch this channel's MRSS feed automatically."
        >
          <option value="true">On</option>
          <option value="false">Off</option>
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
            <h1>Automatic O{"&"}O Channel Scheduler</h1>
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
          <div className="tab-panel tab-panel--dashboard" id="panel-dashboard" role="tabpanel" aria-labelledby="tab-dashboard">
            <p className="tab-lede tab-lede--tight">
              Scope uses the channel selected in the header. Last MRSS poll time and status for each channel are on the
              Channels tab (expand a row).
            </p>

            <section className="card dashboard-overview-card">
              <h2 className="card-title">Overview</h2>
              <div className="dashboard-overview-split">
                <div className="dashboard-overview-main">
                  <h3 className="dashboard-overview-subtitle">Scope &amp; run matrix</h3>
                  <div
                    className="kpi-matrix"
                    role="grid"
                    aria-label="Dashboard counts: feeds, channels, active and failed runs for selected channel"
                  >
                    <div className="kpi-matrix-grid" role="presentation">
                      <button
                        type="button"
                        className="kpi-cell kpi-cell-button"
                        role="gridcell"
                        title="MRSS feeds registered. Click to open Channels tab."
                        onClick={() => handleDashboardCardNavigate("channels")}
                      >
                        <span className="kpi-cell-value">{feeds.length}</span>
                        <span className="kpi-cell-axis">Feeds</span>
                      </button>
                      <button
                        type="button"
                        className="kpi-cell kpi-cell-button"
                        role="gridcell"
                        title="Channel mappings. Click to open Channels tab."
                        onClick={() => handleDashboardCardNavigate("channels")}
                      >
                        <span className="kpi-cell-value">{channels.length}</span>
                        <span className="kpi-cell-axis">Channels</span>
                      </button>
                      <button
                        type="button"
                        className="kpi-cell kpi-cell-button"
                        role="gridcell"
                        title="Active schedule runs for selected channel. Click to open Schedule tab."
                        onClick={() => handleDashboardCardNavigate("schedule")}
                      >
                        <span className="kpi-cell-value">{activeRunsCount}</span>
                        <span className="kpi-cell-axis">Active</span>
                      </button>
                      <button
                        type="button"
                        className="kpi-cell kpi-cell-button kpi-cell-fail"
                        role="gridcell"
                        title="Failed schedule runs for selected channel. Click to open Schedule tab."
                        onClick={() => handleDashboardCardNavigate("schedule")}
                      >
                        <span className="kpi-cell-value">{failedRunsCount}</span>
                        <span className="kpi-cell-axis">Failed</span>
                      </button>
                    </div>
                  </div>
                </div>
                <aside className="dashboard-country-aside" aria-label="Channels by country">
                  <h3 className="dashboard-overview-subtitle">Channels by country</h3>
                  <Suspense fallback={<p className="channel-info">Loading chart…</p>}>
                    <ChannelsByCountryChart channels={channels} colorScheme={colorScheme} />
                  </Suspense>
                </aside>
              </div>
            </section>
          </div>
        )}

        {activeTab === "channels" && (
          <div className="tab-panel" id="panel-channels" role="tabpanel" aria-labelledby="tab-channels">
            <div className="channels-toolbar">
              <p className="tab-lede" style={{ margin: 0, flex: "1 1 240px" }}>
                Click a row or change Channel in the header. Register adds a new mapping.
              </p>
              <div className="schedule-toolbar-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => handleOpenSchedule(selectedChannelId)}
                  disabled={noChannel || !selectedChannelId}
                >
                  Open Schedule
                </button>
                <button type="button" onClick={() => setRegisterModalOpen(true)}>
                  Register channel
                </button>
              </div>
            </div>

            <section className="card">
              <h2 className="card-title">Channels</h2>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Channel ID</th>
                      <th>Channel Name</th>
                      <th>Country</th>
                      <th>Feed ID</th>
                      <th>MRSS URL</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="empty">
                          No channels yet. Register one to begin.
                        </td>
                      </tr>
                    ) : (
                      channels.map((c) => {
                        const feedForChannel = feeds.find((f) => f.id === c.mrss_feed_id);
                        return (
                        <Fragment key={c.channel_service_id}>
                          <tr
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
                            <td>{c.channel_name ?? "—"}</td>
                            <td>{c.country ?? "—"}</td>
                            <td className="cell-mono">{c.mrss_feed_id}</td>
                            <td className="cell-mono">{c.mrss_url}</td>
                            <td>
                              <button
                                type="button"
                                className="btn-secondary table-action-btn"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  handleOpenSchedule(c.channel_service_id);
                                }}
                              >
                                Schedule
                              </button>
                            </td>
                          </tr>
                          {selectedChannelId === c.channel_service_id && (
                            <tr className="channel-expand-row">
                              <td colSpan={6}>
                                <div className="channel-stats-layout" role="group" aria-label="Selected channel stats">
                                  <section className="channel-stats-group">
                                    <h3 className="channel-stats-group-title">Overview</h3>
                                    <div className="channel-stats-grid">
                                      <div className="channel-stat">
                                        <span className="channel-stat-label">Channel name</span>
                                        <strong className="channel-stat-value">
                                          {c.channel_name?.trim() || "—"}
                                        </strong>
                                      </div>
                                      <div className="channel-stat">
                                        <span className="channel-stat-label">Country</span>
                                        <strong className="channel-stat-value">
                                          {c.country?.trim() || "—"}
                                        </strong>
                                      </div>
                                      <div className="channel-stat">
                                        <span className="channel-stat-label">Runs</span>
                                        <strong className="channel-stat-value">{totalRunsCount}</strong>
                                      </div>
                                      <div className="channel-stat">
                                        <span className="channel-stat-label">Active runs</span>
                                        <strong className="channel-stat-value">{activeRunsCount}</strong>
                                      </div>
                                      <div className="channel-stat">
                                        <span className="channel-stat-label">Failed runs</span>
                                        <strong className="channel-stat-value">{failedRunsCount}</strong>
                                      </div>
                                    </div>
                                  </section>

                                  <section className="channel-stats-group">
                                    <h3 className="channel-stats-group-title">Assets</h3>
                                    <div className="channel-stats-grid">
                                      <div className="channel-stat">
                                        <span className="channel-stat-label">Assets</span>
                                        <strong className="channel-stat-value">{totalAssetsCount}</strong>
                                      </div>
                                      {availableAssetTypeEntries.map(([type, count]) => (
                                        <div className="channel-stat" key={type}>
                                          <span className="channel-stat-label">{type} assets</span>
                                          <strong className="channel-stat-value">{count}</strong>
                                        </div>
                                      ))}
                                    </div>
                                  </section>

                                  <section className="channel-stats-group">
                                    <h3 className="channel-stats-group-title">Schedule & Alerts</h3>
                                    <div className="channel-stats-grid">
                                      <div className="channel-stat">
                                        <span className="channel-stat-label">Active schedule rows</span>
                                        <strong className="channel-stat-value">{activeScheduleRowsCount}</strong>
                                      </div>
                                      <div className="channel-stat">
                                        <span className="channel-stat-label">Available schedule</span>
                                        <strong className="channel-stat-value">{availableScheduleDaysHours}</strong>
                                      </div>
                                      <div className="channel-stat channel-stat-alert">
                                        <span className="channel-stat-label">License expiry (next 7d)</span>
                                        <strong className="channel-stat-value">{expiringSoonCount}</strong>
                                        <span className="channel-stat-subtext">
                                          {expiringSoonTypeText || "No expiring assets"}
                                        </span>
                                      </div>
                                      <div className="channel-stat channel-stat-danger">
                                        <span className="channel-stat-label">Expired licenses</span>
                                        <strong className="channel-stat-value">{expiredCount}</strong>
                                        <span className="channel-stat-subtext">{expiredTypeText || "No expired assets"}</span>
                                      </div>
                                    </div>
                                  </section>
                                </div>
                                <div className="channel-feed-health">
                                  <h3 className="channel-feed-health-title">MRSS polling</h3>
                                  <p className="channel-feed-health-url cell-mono" title={c.mrss_url}>
                                    {c.mrss_url}
                                  </p>
                                  {!feedForChannel ? (
                                    <p className="channel-info">
                                      No feed record matched this channel. Try Refresh.
                                    </p>
                                  ) : (
                                    <div className="channel-feed-poll-stack">
                                      <div className="channel-feed-poll-row">
                                        <span className="channel-feed-poll-label">Last MRSS poll</span>
                                        <span className="channel-feed-poll-value channel-feed-poll-value--time">
                                          {feedForChannel.last_fetch_at
                                            ? formatTimeTz(feedForChannel.last_fetch_at)
                                            : "Never"}
                                        </span>
                                      </div>
                                      <div
                                        className={`channel-feed-poll-row channel-feed-poll-row--status${
                                          feedForChannel.last_error
                                            ? " channel-feed-poll-row--danger"
                                            : feedForChannel.last_http_status != null &&
                                                Number(feedForChannel.last_http_status) >= 400
                                              ? " channel-feed-poll-row--danger"
                                              : ""
                                        }`}
                                      >
                                        <span className="channel-feed-poll-label">Status</span>
                                        <span className="channel-feed-poll-value">
                                          {formatMrssPollHttpStatus(feedForChannel)}
                                        </span>
                                        {feedForChannel.last_error ? (
                                          <p className="channel-feed-poll-error">{feedForChannel.last_error}</p>
                                        ) : null}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                        );
                      })
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
                      runs.slice(0, 2).map((r) => (
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

            <details className="playlist-details" open>
              <summary className="playlist-summary">
                <span className="playlist-summary-start">
                  <span className="playlist-chevron" aria-hidden />
                  <span className="playlist-summary-title">Active playlist</span>
                </span>
                <span className="playlist-summary-meta">
                  {playlistRowCount} rows
                  {entries.some((e) => visibleSlateSlots(e).length > 0)
                    ? " (episodes + ad slates)"
                    : ""}
                </span>
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
                        <th>Actions</th>
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
                          <Fragment key={`${e.sequence_no}-${e.starts_at}`}>
                            <tr>
                              <td>{e.sequence_no}</td>
                              <td>{formatTimeTz(e.starts_at)}</td>
                              <td>{formatTimeTz(e.ends_at)}</td>
                              <td className="cell-mono">{e.asset_id}</td>
                              <td>{e.asset_type}</td>
                              <td>{e.title ?? "—"}</td>
                              <td>
                                {isWithinEditWindow(e) && (
                                  <span style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                                    <button
                                      type="button"
                                      className="btn-secondary table-action-btn"
                                      onClick={() => handleOpenEdit(e)}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      className="btn-secondary table-action-btn"
                                      onClick={() => handleOpenInsert(e)}
                                    >
                                      Add After
                                    </button>
                                    <button
                                      type="button"
                                      className="btn-secondary table-action-btn"
                                      style={{ color: "var(--color-danger, #e05c5c)" }}
                                      onClick={() => handleDeleteEntry(e)}
                                    >
                                      Remove
                                    </button>
                                  </span>
                                )}
                              </td>
                            </tr>
                            {visibleSlateSlots(e).map((slot, si) => {
                              const slotStart = offsetIso(e.starts_at, slot.cue_point_ms);
                              const slotEnd = offsetIso(
                                e.starts_at,
                                slot.cue_point_ms + slot.slate_duration_ms
                              );
                              return (
                                <tr
                                  key={`${e.sequence_no}-slate-${si}-${slot.slate_asset_id}`}
                                  className="playlist-slate-row"
                                >
                                  <td className="playlist-slate-seq">
                                    <span className="playlist-slate-badge">Ad</span>
                                  </td>
                                  <td>{formatTimeTz(slotStart)}</td>
                                  <td>{formatTimeTz(slotEnd)}</td>
                                  <td className="cell-mono">{slot.slate_asset_id}</td>
                                  <td>slate</td>
                                  <td>{assetTitleById.get(slot.slate_asset_id) ?? "—"}</td>
                                  <td />
                                </tr>
                              );
                            })}
                          </Fragment>
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
            <p className="tab-lede">Catalog for the channel selected in the header. Use the Type dropdown on slate rows to change the type.</p>

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
                          <td>
                            {a.asset_type === "slate" || a.asset_type === "bumper" ? (
                              <select
                                value={a.asset_type}
                                onChange={async (ev) => {
                                  const newType = ev.target.value;
                                  try {
                                    const res = await fetch(
                                      `${API_BASE_URL}/channels/${encodeURIComponent(selectedChannelId)}/assets/${encodeURIComponent(a.asset_id)}`,
                                      {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ asset_type: newType }),
                                      }
                                    );
                                    if (!res.ok) {
                                      const body = await res.json().catch(() => ({}));
                                      throw new Error(body.detail || `Request failed: ${res.status}`);
                                    }
                                    await loadChannel(selectedChannelId);
                                  } catch (err) {
                                    console.error(err);
                                    setGenerateMessage({ text: `Type update failed: ${err.message}`, type: "error" });
                                  }
                                }}
                                style={{ minWidth: "6rem" }}
                                aria-label={`Type for ${a.asset_id}`}
                              >
                                <option value="slate">slate</option>
                                <option value="bumper">bumper</option>
                              </select>
                            ) : (
                              a.asset_type
                            )}
                          </td>
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

      {insertAfterEntry && (
        <div className="modal-backdrop" role="presentation" onClick={handleCloseInsert}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="insert-entry-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="insert-entry-modal-title">Add Program After #{insertAfterEntry.sequence_no}</h3>
              <button type="button" className="btn-icon" onClick={handleCloseInsert} aria-label="Close">
                ×
              </button>
            </div>
            <p className="modal-lede">
              New program will start at: {formatTimeTz(insertAfterEntry.ends_at)}
            </p>
            <div className="form-grid">
              <div>
                <label htmlFor="insert-asset-select">Select program</label>
                <select
                  id="insert-asset-select"
                  value={insertAssetId}
                  onChange={(e) => setInsertAssetId(e.target.value)}
                >
                  {assets.map((a) => (
                    <option key={a.asset_id} value={a.asset_id}>
                      [{a.asset_type}]{a.season_number != null ? ` S${a.season_number}` : ""}
                      {a.episode_number != null ? `E${a.episode_number}` : ""}{" "}
                      {a.title ?? a.asset_id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-actions modal-actions">
                <button type="button" className="btn-secondary" onClick={handleCloseInsert}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveInsert}
                  disabled={insertBusy || !insertAssetId}
                >
                  {insertBusy ? "Adding…" : "Add program"}
                </button>
              </div>
            </div>
            <Message text={insertMessage.text} type={insertMessage.type} />
          </div>
        </div>
      )}

      {editingEntry && (
        <div className="modal-backdrop" role="presentation" onClick={handleCloseEdit}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-entry-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="edit-entry-modal-title">Edit Entry #{editingEntry.sequence_no}</h3>
              <button type="button" className="btn-icon" onClick={handleCloseEdit} aria-label="Close">
                ×
              </button>
            </div>
            <p className="modal-lede">
              Slot: {formatTimeTz(editingEntry.starts_at)} → {formatTimeTz(editingEntry.ends_at)}
            </p>
            <div className="form-grid">
              <div>
                <label htmlFor="edit-asset-select">Replace with asset</label>
                <select
                  id="edit-asset-select"
                  value={editAssetId}
                  onChange={(e) => setEditAssetId(e.target.value)}
                >
                  {assets.map((a) => (
                    <option key={a.asset_id} value={a.asset_id}>
                      [{a.asset_type}]{a.season_number != null ? ` S${a.season_number}` : ""}
                      {a.episode_number != null ? `E${a.episode_number}` : ""}{" "}
                      {a.title ?? a.asset_id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-actions modal-actions">
                <button type="button" className="btn-secondary" onClick={handleCloseEdit}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={editBusy || !editAssetId || editAssetId === editingEntry.asset_id}
                >
                  {editBusy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
            <Message text={editMessage.text} type={editMessage.type} />
          </div>
        </div>
      )}
    </div>
  );
}
