import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  PieChart,
  Pie,
} from "recharts";

const CHART_PALETTES = {
  dark: {
    axis: "#8b96a8",
    grid: "#252b38",
    tick: "#8b96a8",
    ok: "#3fb950",
    warn: "#d29922",
    bad: "#f85149",
    muted: "#5c6570",
    na: "#4a5568",
    accent: "#4f9eff",
    cursor: "rgba(79, 158, 255, 0.06)",
  },
  light: {
    axis: "#64748b",
    grid: "#e2e8f0",
    tick: "#475569",
    ok: "#16a34a",
    warn: "#ca8a04",
    bad: "#dc2626",
    muted: "#94a3b8",
    na: "#94a3b8",
    accent: "#2563eb",
    cursor: "rgba(37, 99, 235, 0.08)",
  },
};

function feedHostLabel(url) {
  if (!url) return "—";
  try {
    const h = new URL(url).hostname;
    return h || url.slice(0, 20);
  } catch {
    return url.length > 28 ? `${url.slice(0, 25)}…` : url;
  }
}

function shortName(url, max = 20) {
  const h = feedHostLabel(url);
  return h.length > max ? `${h.slice(0, max - 1)}…` : h;
}

function httpBarFill(status, palette) {
  if (status == null) return palette.na;
  const n = Number(status);
  if (Number.isNaN(n)) return palette.na;
  if (n >= 200 && n < 300) return palette.ok;
  if (n >= 400) return palette.bad;
  return palette.warn;
}

function httpBarValue(status) {
  if (status == null) return 0;
  const n = Number(status);
  return Number.isNaN(n) ? 0 : n;
}

function FeedTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  if (!row?.feed) return null;
  const f = row.feed;
  return (
    <div className="feed-chart-tooltip">
      <div className="feed-chart-tooltip-url">{f.url}</div>
      <dl className="feed-chart-tooltip-dl">
        <dt>HTTP</dt>
        <dd>{f.last_http_status != null ? f.last_http_status : "—"}</dd>
        <dt>Last fetch</dt>
        <dd>{f.last_fetch_at ? row.timeLabel : "Never"}</dd>
        <dt>Interval</dt>
        <dd>{f.fetch_interval_seconds ?? "—"}s</dd>
        {f.last_error ? (
          <>
            <dt>Error</dt>
            <dd>{f.last_error}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function PieTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="feed-chart-tooltip">
      <strong>{p.name}</strong>: {p.value}
    </div>
  );
}

export default function FeedStatusCharts({ feeds, formatTimeTz, colorScheme = "dark" }) {
  const C = CHART_PALETTES[colorScheme] ?? CHART_PALETTES.dark;

  const httpRows = useMemo(
    () =>
      feeds.map((f) => ({
        name: shortName(f.url),
        http: httpBarValue(f.last_http_status),
        fill: httpBarFill(f.last_http_status, C),
        feed: f,
        timeLabel: f.last_fetch_at ? formatTimeTz(f.last_fetch_at) : "",
      })),
    [feeds, formatTimeTz, C]
  );

  const ageRows = useMemo(
    () =>
      feeds.map((f) => {
        let minutes;
        if (!f.last_fetch_at) minutes = null;
        else {
          const t = new Date(f.last_fetch_at).getTime();
          minutes = Math.max(0, Math.round((Date.now() - t) / 60000));
        }
        const capped = minutes == null ? 10080 : Math.min(minutes, 10080);
        return {
          name: shortName(f.url),
          minutes: capped,
          fill: minutes == null ? C.bad : minutes > 1440 ? C.warn : C.ok,
          feed: f,
          rawMinutes: minutes,
          timeLabel: f.last_fetch_at ? formatTimeTz(f.last_fetch_at) : "",
        };
      }),
    [feeds, formatTimeTz, C]
  );

  const intervalRows = useMemo(
    () =>
      feeds.map((f) => ({
        name: shortName(f.url),
        seconds: Math.max(0, Number(f.fetch_interval_seconds) || 0),
        feed: f,
        timeLabel: f.last_fetch_at ? formatTimeTz(f.last_fetch_at) : "",
      })),
    [feeds, formatTimeTz]
  );

  const pieData = useMemo(() => {
    const on = feeds.filter((f) => f.enabled).length;
    const off = feeds.length - on;
    return [
      { name: "Enabled", value: on, fill: C.ok },
      { name: "Disabled", value: off, fill: C.muted },
    ].filter((d) => d.value > 0);
  }, [feeds, C]);

  const barHeight = Math.min(440, Math.max(200, feeds.length * 34 + 80));

  return (
    <div className="feed-charts-grid" aria-label="Feed health charts">
      <div className="feed-chart-panel feed-charts-pie">
        <h3 className="feed-chart-title">Feeds enabled</h3>
        <p className="feed-chart-sub">Polling on vs off</p>
        <div className="feed-chart-pie-wrap">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={48}
                outerRadius={72}
                paddingAngle={2}
              >
                {pieData.map((e, i) => (
                  <Cell key={e.name} fill={e.fill} />
                ))}
              </Pie>
              <Tooltip content={<PieTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="feed-chart-panel feed-charts-http">
        <h3 className="feed-chart-title">Last HTTP status</h3>
        <p className="feed-chart-sub">Bar length = response code (0 = none)</p>
        <div className="feed-chart-bars" style={{ height: barHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart layout="vertical" data={httpRows} margin={{ top: 6, right: 16, left: 8, bottom: 6 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} horizontal={false} />
              <XAxis type="number" domain={[0, 650]} stroke={C.axis} tick={{ fill: C.tick, fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey="name"
                width={92}
                stroke={C.axis}
                tick={{ fill: C.tick, fontSize: 11 }}
              />
              <Tooltip content={<FeedTooltip />} cursor={{ fill: C.cursor }} />
              <Bar dataKey="http" radius={[0, 4, 4, 0]} maxBarSize={22}>
                {httpRows.map((e, i) => (
                  <Cell key={e.feed.id ?? e.feed.url ?? i} fill={e.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="feed-chart-panel feed-charts-interval">
        <h3 className="feed-chart-title">Fetch interval</h3>
        <p className="feed-chart-sub">Seconds between polls (per feed)</p>
        <div className="feed-chart-bars" style={{ height: barHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart layout="vertical" data={intervalRows} margin={{ top: 6, right: 16, left: 8, bottom: 6 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} horizontal={false} />
              <XAxis type="number" stroke={C.axis} tick={{ fill: C.tick, fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey="name"
                width={92}
                stroke={C.axis}
                tick={{ fill: C.tick, fontSize: 11 }}
              />
              <Tooltip content={<FeedTooltip />} cursor={{ fill: C.cursor }} />
              <Bar dataKey="seconds" fill={C.accent} radius={[0, 4, 4, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="feed-chart-panel feed-charts-age">
        <h3 className="feed-chart-title">Last fetch age</h3>
        <p className="feed-chart-sub">Minutes since last successful poll (capped at 1 week; never = max)</p>
        <div className="feed-chart-bars" style={{ height: barHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart layout="vertical" data={ageRows} margin={{ top: 6, right: 16, left: 8, bottom: 6 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} horizontal={false} />
              <XAxis type="number" stroke={C.axis} tick={{ fill: C.tick, fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey="name"
                width={92}
                stroke={C.axis}
                tick={{ fill: C.tick, fontSize: 11 }}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload;
                  const f = row.feed;
                  const label =
                    row.rawMinutes == null ? "Never" : `${row.rawMinutes} min ago`;
                  return (
                    <div className="feed-chart-tooltip">
                      <div className="feed-chart-tooltip-url">{f.url}</div>
                      <p className="feed-chart-tooltip-age">{label}</p>
                      <dl className="feed-chart-tooltip-dl">
                        <dt>Last fetch</dt>
                        <dd>{f.last_fetch_at ? row.timeLabel : "—"}</dd>
                      </dl>
                    </div>
                  );
                }}
                cursor={{ fill: C.cursor }}
              />
              <Bar dataKey="minutes" radius={[0, 4, 4, 0]} maxBarSize={22}>
                {ageRows.map((e, i) => (
                  <Cell key={e.feed.id ?? e.feed.url ?? i} fill={e.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
