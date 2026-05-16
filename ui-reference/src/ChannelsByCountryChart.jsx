import { useMemo } from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts";

const SLICE_COLORS = {
  dark: ["#4f9eff", "#3fb950", "#d29922", "#a371f7", "#f85149", "#79c0ff", "#56d364", "#ffa657", "#8b949e"],
  light: ["#2563eb", "#16a34a", "#ca8a04", "#7c3aed", "#dc2626", "#3b82f6", "#22c55e", "#ea580c", "#64748b"],
};

function bucketCountry(channel) {
  const raw = channel?.country;
  const t = raw == null ? "" : String(raw).trim();
  return t || "Unspecified";
}

function CountryTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="feed-chart-tooltip">
      <strong>{row.name}</strong>
      <p className="feed-chart-tooltip-age" style={{ margin: "6px 0 0" }}>
        {row.value} channel{row.value === 1 ? "" : "s"} ({row.pct}%)
      </p>
    </div>
  );
}

export default function ChannelsByCountryChart({ channels, colorScheme = "dark" }) {
  const palette = SLICE_COLORS[colorScheme] ?? SLICE_COLORS.dark;

  const pieData = useMemo(() => {
    if (!channels?.length) return [];
    const counts = new Map();
    for (const c of channels) {
      const key = bucketCountry(c);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const total = channels.length;
    return Array.from(counts.entries())
      .map(([name, value], i) => ({
        name,
        value,
        pct: total ? Math.round((value / total) * 1000) / 10 : 0,
        fill: palette[i % palette.length],
      }))
      .sort((a, b) => b.value - a.value);
  }, [channels, palette]);

  if (!channels?.length) {
    return <p className="channel-info">No channels yet.</p>;
  }

  return (
    <div className="dashboard-country-chart" aria-label="Channel count by country">
      <div className="country-chart-compact-inner">
        <div className="country-chart-pie">
          <ResponsiveContainer width="100%" height={152}>
            <PieChart margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={34}
                outerRadius={56}
                paddingAngle={pieData.length > 1 ? 1.5 : 0}
              >
                {pieData.map((e) => (
                  <Cell key={e.name} fill={e.fill} />
                ))}
              </Pie>
              <Tooltip content={<CountryTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="country-pie-legend-list">
          {pieData.map((d) => (
            <li key={d.name} className="country-pie-legend-row">
              <span className="country-pie-swatch" style={{ background: d.fill }} aria-hidden />
              <span className="country-pie-legend-name" title={d.name}>
                {d.name}
              </span>
              <span className="country-pie-legend-meta">
                {d.value} ({d.pct}%)
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
