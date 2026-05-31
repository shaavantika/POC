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

// EPG grid constants
const EPG_PX_PER_MIN = 2;
const EPG_COL_WIDTH = 280;
const EPG_TIME_W = 64;
const EPG_DAYS_VISIBLE = 4;
const EPG_TOTAL_HEIGHT = 24 * 60 * EPG_PX_PER_MIN;
const EPG_TIME_LABELS = Array.from({ length: 48 }, (_, i) => ({
  label: `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 === 0 ? "00" : "30"}`,
  top: i * 30 * EPG_PX_PER_MIN,
}));

function epgDayKey(isoString) {
  const d = new Date(isoString);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function epgBlockTop(startsAt) {
  const dt = new Date(startsAt);
  const dayStart = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  return Math.max(0, ((dt - dayStart) / 60000) * EPG_PX_PER_MIN);
}
function epgBlockHeight(startsAt, endsAt) {
  const durationMs = new Date(endsAt) - new Date(startsAt);
  return Math.max((durationMs / 60000) * EPG_PX_PER_MIN, 26);
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

  const [epgDayOffset, setEpgDayOffset] = useState(0);
  const [expandedSeq, setExpandedSeq] = useState(null);

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

  const formatTimeOnly = useCallback(
    (iso) => {
      if (!iso) return "–";
      try {
        const opts = { timeStyle: "short" };
        if (displayTimeZone && displayTimeZone !== "local") opts.timeZone = displayTimeZone;
        return new Date(iso).toLocaleTimeString(undefined, opts);
      } catch {
        return iso;
      }
    },
    [displayTimeZone]
  );

  const assetTitleById = useMemo(() => {
    const m = new Map();
    for (const a of assets) {
      m.set(a.asset_id, a.title ?? null);
    }
    return m;
  }, [assets]);

  const assetTypeById = useMemo(() => {
    const m = new Map();
    for (const a of assets) {
      m.set(a.asset_id, a.asset_type ?? null);
    }
    return m;
  }, [assets]);

  const epgUniqueDays = useMemo(
    () => [...new Set(entries.filter((e) => e.asset_type === "episode").map((e) => epgDayKey(e.starts_at)))].sort(),
    [entries]
  );
  const epgEntriesByDay = useMemo(() => {
    const m = {};
    for (const e of entries) {
      if (e.asset_type !== "episode") continue;
      const k = epgDayKey(e.starts_at);
      if (!m[k]) m[k] = [];
      m[k].push(e);
    }
    return m;
  }, [entries]);
  const epgVisibleDays = epgUniqueDays.slice(epgDayOffset, epgDayOffset + EPG_DAYS_VISIBLE);

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

  useEffect(() => {
    setExpandedSeq(null);
    if (!entries.length) { setEpgDayOffset(0); return; }
    const todayKey = epgDayKey(new Date().toISOString());
    const days = [...new Set(entries.map((e) => epgDayKey(e.starts_at)))].sort();
    const idx = days.findIndex((d) => d >= todayKey);
    setEpgDayOffset(idx === -1 ? Math.max(0, days.length - EPG_DAYS_VISIBLE) : Math.max(0, idx));
  }, [entries]);

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
            window_hours: 168,
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
      const action = data.extended ? "Extended" : "Generated";
      setGenerateMessage({
        text: `${action} — run ${data.run_id}, ${data.entry_count} total entries.`,
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
    return start > now + TWO_HOURS_MS;
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
          <div className="tab-panel" id="panel-schedule" role="tabpanel" aria-labelledby="tab-schedule">
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

            {entries.length === 0 ? (
              <section className="card" style={{ padding: "2.5rem", textAlign: "center" }}>
                <p style={{ color: "var(--muted)", marginBottom: "1rem" }}>
                  No active schedule. Hit Generate to create one.
                </p>
                <button type="button" onClick={handleGenerate} disabled={noChannel || generateBusy}>
                  Generate schedule
                </button>
              </section>
            ) : (
              <section className="card" style={{ padding: 0, overflow: "hidden" }}>
                {/* Navigation bar */}
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.6rem 1rem", borderBottom: "1px solid var(--border)" }}>
                  <button type="button" className="btn-secondary" disabled={epgDayOffset === 0} onClick={() => setEpgDayOffset((o) => Math.max(0, o - 1))} aria-label="Previous days">◀</button>
                  <button type="button" className="btn-secondary" onClick={() => {
                    const todayKey = epgDayKey(new Date().toISOString());
                    const idx = epgUniqueDays.findIndex((d) => d >= todayKey);
                    setEpgDayOffset(idx === -1 ? Math.max(0, epgUniqueDays.length - EPG_DAYS_VISIBLE) : Math.max(0, idx));
                  }}>Today</button>
                  <button type="button" className="btn-secondary" disabled={epgDayOffset + EPG_DAYS_VISIBLE >= epgUniqueDays.length} onClick={() => setEpgDayOffset((o) => Math.min(Math.max(0, epgUniqueDays.length - EPG_DAYS_VISIBLE), o + 1))} aria-label="Next days">▶</button>
                  <span style={{ marginLeft: "0.5rem", fontSize: "0.85rem", color: "var(--muted)" }}>
                    {epgVisibleDays.length > 0 && (
                      <>
                        {new Date(epgVisibleDays[0] + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                        {epgVisibleDays.length > 1 && ` – ${new Date(epgVisibleDays[epgVisibleDays.length - 1] + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}
                      </>
                    )}
                  </span>
                </div>

                {/* EPG scroll area */}
                <div style={{ overflow: "auto", maxHeight: "640px" }}>
                  <div style={{ minWidth: EPG_TIME_W + epgVisibleDays.length * EPG_COL_WIDTH }}>

                    {/* Sticky date header row */}
                    <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 4, background: "var(--bg-elevated)" }}>
                      <div style={{ width: EPG_TIME_W, minWidth: EPG_TIME_W, flexShrink: 0, position: "sticky", left: 0, zIndex: 5, background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)" }} />
                      {epgVisibleDays.map((dayKey) => {
                        const isToday = dayKey === epgDayKey(new Date().toISOString());
                        return (
                          <div key={dayKey} style={{ width: EPG_COL_WIDTH, minWidth: EPG_COL_WIDTH, flexShrink: 0, padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", borderLeft: "1px solid var(--border)", fontWeight: isToday ? 700 : 500, fontSize: "0.85rem", color: isToday ? "var(--accent)" : undefined, display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            {new Date(dayKey + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                            {isToday && <span style={{ fontSize: "0.65rem", background: "var(--accent)", color: "#fff", padding: "1px 6px", borderRadius: 8 }}>Today</span>}
                          </div>
                        );
                      })}
                    </div>

                    {/* Body */}
                    <div style={{ display: "flex" }}>
                      {/* Sticky time gutter */}
                      <div style={{ width: EPG_TIME_W, minWidth: EPG_TIME_W, flexShrink: 0, height: EPG_TOTAL_HEIGHT, position: "sticky", left: 0, zIndex: 3, background: "var(--bg-elevated)" }}>
                        {EPG_TIME_LABELS.map(({ label, top }) => (
                          <Fragment key={label}>
                            <div style={{ position: "absolute", top: top - 8, right: 8, fontSize: "0.66rem", color: "var(--muted)", lineHeight: 1, whiteSpace: "nowrap", userSelect: "none" }}>
                              {label}
                            </div>
                            <div style={{ position: "absolute", top, left: 0, right: 0, height: 1, background: "var(--border)", opacity: label.endsWith(":00") ? 0.5 : 0.18 }} />
                          </Fragment>
                        ))}
                      </div>

                      {/* Day columns */}
                      {epgVisibleDays.map((dayKey) => {
                        const dayEntries = epgEntriesByDay[dayKey] ?? [];
                        return (
                          <div key={dayKey} style={{ width: EPG_COL_WIDTH, minWidth: EPG_COL_WIDTH, flexShrink: 0, height: EPG_TOTAL_HEIGHT, position: "relative", borderLeft: "1px solid var(--border)" }}>
                            {/* Grid lines */}
                            {EPG_TIME_LABELS.map(({ label, top }) => (
                              <div key={label} style={{ position: "absolute", top, left: 0, right: 0, height: 1, background: "var(--border)", opacity: label.endsWith(":00") ? 0.3 : 0.1, pointerEvents: "none" }} />
                            ))}

                            {/* Program blocks */}
                            {dayEntries.map((entry) => {
                              const bTop = epgBlockTop(entry.starts_at);
                              const bHeight = epgBlockHeight(entry.starts_at, entry.ends_at);
                              const isExpanded = expandedSeq === entry.sequence_no;
                              const editable = isWithinEditWindow(entry);
                              const slots = visibleSlateSlots(entry);

                              return (
                                <div
                                  key={entry.sequence_no}
                                  role="button"
                                  tabIndex={0}
                                  aria-expanded={isExpanded}
                                  onClick={() => setExpandedSeq(isExpanded ? null : entry.sequence_no)}
                                  onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setExpandedSeq(isExpanded ? null : entry.sequence_no); } }}
                                  style={{
                                    position: "absolute",
                                    top: bTop + 1,
                                    left: 3,
                                    right: 3,
                                    height: isExpanded ? undefined : Math.max(bHeight - 2, 26),
                                    minHeight: 26,
                                    background: "var(--card)",
                                    border: `1px solid ${editable ? "var(--accent)" : "var(--border)"}`,
                                    borderLeft: `3px solid ${editable ? "var(--accent)" : "var(--border)"}`,
                                    borderRadius: 4,
                                    overflow: isExpanded ? "visible" : "hidden",
                                    cursor: "pointer",
                                    zIndex: isExpanded ? 20 : 1,
                                    boxSizing: "border-box",
                                    userSelect: "none",
                                  }}
                                >
                                  {isExpanded ? (
                                    <div
                                      onClick={(ev) => ev.stopPropagation()}
                                      style={{ background: "var(--bg-elevated)", border: "1px solid var(--accent)", borderRadius: 4, padding: "10px 12px", minWidth: EPG_COL_WIDTH - 14, boxShadow: "0 6px 24px rgba(0,0,0,0.18)", cursor: "default", fontSize: "0.78rem", lineHeight: 1.4 }}
                                    >
                                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                                        <strong style={{ fontSize: "0.82rem", flex: 1, marginRight: 8 }}>{entry.title ?? entry.asset_id}</strong>
                                        <button type="button" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: "0.9rem", padding: 0, lineHeight: 1 }} onClick={(ev) => { ev.stopPropagation(); setExpandedSeq(null); }} aria-label="Close">✕</button>
                                      </div>
                                      <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginBottom: 8 }}>
                                        {formatTimeOnly(entry.starts_at)} → {formatTimeOnly(entry.ends_at)} &nbsp;·&nbsp; #{entry.sequence_no} &nbsp;·&nbsp; {entry.asset_type}
                                      </div>
                                      {slots.length > 0 && (
                                        <div style={{ marginBottom: 8, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                                          <div style={{ fontSize: "0.66rem", color: "var(--muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                                            Ad breaks &middot; {slots.length} asset{slots.length !== 1 ? "s" : ""}
                                          </div>
                                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                            {slots.map((slot, si) => {
                                              const slotStart = offsetIso(entry.starts_at, slot.cue_point_ms);
                                              const slotEnd = offsetIso(entry.starts_at, slot.cue_point_ms + slot.slate_duration_ms);
                                              const aType = assetTypeById.get(slot.slate_asset_id) ?? "unknown";
                                              const isBumper = aType === "bumper";
                                              const badgeColor = isBumper ? "var(--accent)" : aType === "slate" ? "var(--warn)" : "var(--muted)";
                                              return (
                                                <div key={si} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 6px", background: "var(--bg)", borderRadius: 4 }}>
                                                  <span style={{ flexShrink: 0, fontSize: "0.58rem", fontWeight: 700, padding: "2px 5px", borderRadius: 3, background: badgeColor, color: "#fff", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 1 }}>
                                                    {aType}
                                                  </span>
                                                  <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div style={{ fontSize: "0.72rem", fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                      {assetTitleById.get(slot.slate_asset_id) ?? slot.slate_asset_id}
                                                    </div>
                                                    <div style={{ fontSize: "0.64rem", color: "var(--muted)", marginTop: 1 }}>
                                                      {formatTimeOnly(slotStart)} – {formatTimeOnly(slotEnd)}
                                                    </div>
                                                  </div>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      )}
                                      {editable && (
                                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                                          <button type="button" className="btn-secondary table-action-btn" onClick={() => { handleOpenEdit(entry); setExpandedSeq(null); }}>Edit</button>
                                          <button type="button" className="btn-secondary table-action-btn" onClick={() => { handleOpenInsert(entry); setExpandedSeq(null); }}>Add After</button>
                                          <button type="button" className="btn-secondary table-action-btn" style={{ color: "var(--bad)" }} onClick={() => { handleDeleteEntry(entry); setExpandedSeq(null); }}>Remove</button>
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <div style={{ padding: "3px 6px", height: "100%", overflow: "hidden", fontSize: "0.74rem", lineHeight: 1.3 }}>
                                      <div style={{ fontSize: "0.66rem", color: "var(--accent)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 1 }}>
                                        {formatTimeOnly(entry.starts_at)}
                                        {entry.season_number != null && (
                                          <span style={{ marginLeft: 6, color: "var(--muted)", fontWeight: 400 }}>
                                            S{String(entry.season_number).padStart(2, "0")}
                                            {entry.episode_number != null && `E${String(entry.episode_number).padStart(2, "0")}`}
                                          </span>
                                        )}
                                      </div>
                                      <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {entry.title ?? entry.asset_id}
                                      </div>
                                      {bHeight > 52 && (
                                        <div style={{ color: "var(--muted)", fontSize: "0.68rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                          {formatTimeOnly(entry.starts_at)} – {formatTimeOnly(entry.ends_at)}
                                        </div>
                                      )}
                                      {bHeight > 68 && slots.length > 0 && (
                                        <div style={{ marginTop: 2, fontSize: "0.66rem", color: "var(--warn)" }}>
                                          ▪ {slots.length} ad{slots.length !== 1 ? "s" : ""}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>
            )}
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
                          <td>
                            {a.asset_type}
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
