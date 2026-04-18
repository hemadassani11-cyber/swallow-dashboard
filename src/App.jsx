import React, { useState, useEffect, useMemo, useRef } from 'react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

// ============================================================
// SIMULATED DATA — replace with real wearable data later
// ============================================================

// Realistic inter-swallow gap (ms) — most between 30–60s, long tail out to 420s+
function randomGapMs() {
  const r = Math.random();
  if (r < 0.55) return 30000 + Math.random() * 30000;    // 30–60s (55%)
  if (r < 0.82) return 60000 + Math.random() * 60000;    // 60–120s (27%)
  if (r < 0.96) return 120000 + Math.random() * 120000;  // 120–240s (14%)
  return 240000 + Math.random() * 180000;                // 240–420s (4%)
}

function generateSwallowsForDay(dayOffset = 0) {
  const swallows = [];
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setDate(dayStart.getDate() - dayOffset);
  dayStart.setHours(7, 0, 0, 0);

  const dayEnd = new Date(dayStart);
  dayEnd.setHours(22, 30, 0, 0);

  const endTime = dayOffset === 0 ? Math.min(now.getTime(), dayEnd.getTime()) : dayEnd.getTime();

  let t = dayStart.getTime();
  while (t < endTime) {
    swallows.push(new Date(t));
    t += randomGapMs();
  }
  return swallows;
}

function generateNudges(swallows, threshold = 60000) {
  const nudges = [];
  for (let i = 1; i < swallows.length; i++) {
    const gap = swallows[i].getTime() - swallows[i - 1].getTime();
    if (gap > threshold && Math.random() < 0.4) {
      nudges.push(new Date(swallows[i - 1].getTime() + threshold + Math.random() * 5000));
    }
  }
  return nudges;
}

// 30 days, ordered oldest-to-newest (index 0 = 29 days ago, index 29 = today)
const thirtyDayDetailedHistory = Array.from({ length: 30 }, (_, i) => {
  const d = 29 - i;
  const sws = generateSwallowsForDay(d);
  const nudges = generateNudges(sws);
  const date = new Date();
  date.setDate(date.getDate() - d);
  return { date, swallows: sws, nudges };
});

// Last 7 days — same shape as before: index 6 = today
const sevenDayDetailedHistory = thirtyDayDetailedHistory.slice(-7);

const todaySwallows = sevenDayDetailedHistory[6].swallows;
const yesterdaySwallows = sevenDayDetailedHistory[5].swallows;
const todayNudges = sevenDayDetailedHistory[6].nudges;

const sevenDayHistory = sevenDayDetailedHistory.map((d) => ({
  date: d.date,
  swallows: d.swallows.length,
  nudges: d.nudges.length,
}));

const sevenDayAverage = Math.round(
  sevenDayHistory.reduce((sum, d) => sum + d.swallows, 0) / 7
);

// Flatten nudges across all 7 days with their preceding gap context
const allNudgesDetailed = sevenDayDetailedHistory.flatMap((day) =>
  day.nudges.map((nudge) => {
    let before = null;
    let after = null;
    for (let i = 0; i < day.swallows.length; i++) {
      if (day.swallows[i] <= nudge) before = day.swallows[i];
      else { after = day.swallows[i]; break; }
    }
    const gapSec = before && after
      ? Math.round((after.getTime() - before.getTime()) / 1000)
      : null;
    return { time: nudge, date: day.date, gapSec, before, after };
  })
);

// Report metrics across the full 30-day window
const reportMetrics = (() => {
  let gentleCues = 0;
  let tier2 = 0, tier3 = 0, tier4 = 0;
  for (const day of thirtyDayDetailedHistory) {
    gentleCues += day.nudges.length;
    for (let i = 1; i < day.swallows.length; i++) {
      const gapSec = (day.swallows[i].getTime() - day.swallows[i - 1].getTime()) / 1000;
      if (gapSec >= 120) tier2++;
      if (gapSec >= 240) tier3++;
      if (gapSec >= 420) tier4++;
    }
  }
  if (tier4 < 2) tier4 = 2 + Math.floor(Math.random() * 3); // ensure 2–4
  return { gentleCues, tier2, tier3, tier4 };
})();

// Gap-distribution buckets for the histogram (last 7 days)
const gapBuckets7d = (() => {
  const buckets = [0, 0, 0, 0, 0]; // 0–30, 30–60, 60–120, 120–240, 240+
  for (const day of sevenDayDetailedHistory) {
    for (let i = 1; i < day.swallows.length; i++) {
      const gapSec = (day.swallows[i].getTime() - day.swallows[i - 1].getTime()) / 1000;
      if (gapSec < 30) buckets[0]++;
      else if (gapSec < 60) buckets[1]++;
      else if (gapSec < 120) buckets[2]++;
      else if (gapSec < 240) buckets[3]++;
      else buckets[4]++;
    }
  }
  return buckets;
})();

// ============================================================
// DESIGN TOKENS
// ============================================================

const T = {
  // Page
  page: '#eef2f6',        // soft blue-gray page bg
  canvas: '#ffffff',

  // Sidebar
  sidebar: '#0d1b1a',
  sidebarHover: '#1a2f2c',
  sidebarActive: '#ffffff',
  sidebarActiveText: '#0d1b1a',
  sidebarText: '#a8b5b0',

  // Teal accents
  tealPrimary: '#2d7a6e',
  tealSoft: '#5ea89a',
  tealLight: '#a8d4cb',
  tealWash: '#e8f0ed',
  tealTint: '#f4f8f6',

  // Text
  textDeep: '#0d1b1a',
  textBody: '#2d5a52',
  textMuted: '#6b7f7a',
  textFaint: '#9aaba6',

  // States
  amber: '#d4a04a',
  amberWash: '#fdf5e3',
  coral: '#e06565',
  coralWash: '#fbebeb',
  success: '#4a9d7f',
  successWash: '#e6f2ec',

  // Escalation tiers (orange → deep red)
  tier2: '#e07a3c',
  tier2Wash: '#fdeadb',
  tier2Tint: '#fdf3eb',
  tier3: '#c53030',
  tier3Wash: '#f8d7d7',
  tier3Tint: '#fbe5e5',
  tier4: '#9b1717',
  tier4Dark: '#6f0f0f',

  // Lines
  hairline: '#edf0ef',
  hairlineSoft: '#f4f6f5',
};

const DEFAULT_THRESHOLDS = { tier1: 60, tier2: 120, tier3: 240, tier4: 420 };
const THRESHOLDS_STORAGE_KEY = 'chyme.thresholds';

// ============================================================
// HELPERS
// ============================================================

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatTimeWithSeconds(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatDayShort(date) {
  return date.toLocaleDateString([], { weekday: 'short' });
}

// ============================================================
// ICON BADGE (colored rounded square with icon inside)
// ============================================================

function IconBadge({ color, bg, children }) {
  return (
    <div style={{
      width: '36px',
      height: '36px',
      borderRadius: '9px',
      background: bg,
      color: color,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    }}>
      {children}
    </div>
  );
}

// Simple inline SVG icons
const icons = {
  timer: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M9 2h6"/>
    </svg>
  ),
  droplet: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.69l5.66 5.66a8 8 0 11-11.32 0z"/>
    </svg>
  ),
  calendar: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
    </svg>
  ),
  trending: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>
    </svg>
  ),
  bell: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
    </svg>
  ),
  activity: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  ),
  // Sidebar icons
  home: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a2 2 0 01-2 2H5a2 2 0 01-2-2V9.5z"/>
    </svg>
  ),
  clock: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
  chart: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  ),
  user: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  ),
  search: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
  bellSolid: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
    </svg>
  ),
};

// ============================================================
// SIDEBAR
// ============================================================

function Sidebar({ activePage, setActivePage }) {
  const items = [
    { label: 'Overview', icon: icons.home },
    { label: 'Live Monitor', icon: icons.activity },
    { label: 'Patient History', icon: icons.clock },
    { label: 'Reports', icon: icons.chart },
    { label: 'Patient Profile', icon: icons.user },
    { label: 'Alerts', icon: icons.bell, badge: todayNudges.length },
    { label: 'Settings', icon: icons.settings },
  ];

  return (
    <aside style={{
      width: '240px',
      background: T.sidebar,
      color: T.sidebarText,
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      borderRadius: '20px',
      margin: '16px 0 16px 16px',
      padding: '24px 16px',
    }}>
      {/* Logo */}
      <div style={{
        padding: '0 12px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}>
        <div style={{
          width: '30px',
          height: '30px',
          borderRadius: '8px',
          background: T.tealPrimary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}>
          <div style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: T.tealLight,
          }} />
          <div style={{
            position: 'absolute',
            inset: 2,
            borderRadius: '6px',
            border: `1px solid ${T.tealLight}`,
            opacity: 0.3,
          }} />
        </div>
        <div style={{
          fontSize: '18px',
          fontWeight: 700,
          color: '#ffffff',
          letterSpacing: '-0.01em',
        }}>
          ChYme
        </div>
      </div>

      {/* Search */}
      <div style={{
        padding: '10px 14px',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: '10px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        marginBottom: '20px',
        color: T.sidebarText,
      }}>
        {icons.search}
        <div style={{ fontSize: '13px', flex: 1 }}>Search here...</div>
        <div style={{
          fontSize: '11px',
          padding: '2px 6px',
          background: 'rgba(255,255,255,0.08)',
          borderRadius: '4px',
        }}>⌘K</div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1 }}>
        {items.map((item, i) => {
          const active = activePage === item.label;
          return (
            <div
              key={i}
              onClick={() => setActivePage(item.label)}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = T.sidebarHover;
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = 'transparent';
              }}
              style={{
                padding: '11px 14px',
                borderRadius: '10px',
                fontSize: '14px',
                fontWeight: active ? 600 : 500,
                color: active ? T.sidebarActiveText : T.sidebarText,
                background: active ? T.sidebarActive : 'transparent',
                marginBottom: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                transition: 'background 0.15s ease',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center' }}>{item.icon}</span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.badge > 0 && (
                <span style={{
                  background: T.coral,
                  color: '#fff',
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '2px 7px',
                  borderRadius: '10px',
                  minWidth: '20px',
                  textAlign: 'center',
                }}>
                  {item.badge}
                </span>
              )}
            </div>
          );
        })}
      </nav>

      {/* Device status card at bottom */}
      <div style={{
        padding: '16px',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: '12px',
        marginTop: '16px',
      }}>
        <div style={{
          fontSize: '11px',
          color: 'rgba(255,255,255,0.5)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          marginBottom: '10px',
          fontWeight: 600,
        }}>
          Device
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '12px',
          color: '#fff',
          marginBottom: '8px',
        }}>
          <div style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: T.success,
            boxShadow: `0 0 0 3px ${T.success}33`,
          }} />
          Connected · Signal strong
        </div>
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>
          Battery 78% · ChYme v0.1
        </div>
      </div>
    </aside>
  );
}

// ============================================================
// TOP GREETING BAR
// ============================================================

function TopGreeting({ currentTime }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: '24px',
    }}>
      <div>
        <div style={{
          fontSize: '24px',
          fontWeight: 700,
          color: T.textDeep,
          letterSpacing: '-0.02em',
        }}>
          Welcome back, Maria
        </div>
        <div style={{
          fontSize: '14px',
          color: T.textMuted,
          marginTop: '4px',
        }}>
          Monitoring patient 0427 · {currentTime.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <IconButton badge>{icons.bellSolid}</IconButton>
        <IconButton>{icons.settings}</IconButton>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '6px 14px 6px 6px',
          background: T.canvas,
          border: `1px solid ${T.hairline}`,
          borderRadius: '999px',
          cursor: 'pointer',
        }}>
          <div style={{
            width: '30px',
            height: '30px',
            borderRadius: '50%',
            background: `linear-gradient(135deg, ${T.tealSoft}, ${T.tealPrimary})`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 600,
          }}>
            M
          </div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: T.textDeep }}>Maria</div>
          <span style={{ color: T.textFaint, fontSize: '10px' }}>▾</span>
        </div>
      </div>
    </div>
  );
}

function IconButton({ children, badge }) {
  return (
    <div style={{
      width: '38px',
      height: '38px',
      borderRadius: '50%',
      background: T.canvas,
      border: `1px solid ${T.hairline}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: T.textBody,
      cursor: 'pointer',
      position: 'relative',
    }}>
      {children}
      {badge && (
        <div style={{
          position: 'absolute',
          top: '6px',
          right: '6px',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: T.coral,
          border: `2px solid ${T.canvas}`,
        }} />
      )}
    </div>
  );
}

// ============================================================
// KPI CARDS (with colored icon badges + inline sparkline)
// ============================================================

function KPICard({ icon, iconColor, iconBg, title, value, unit, delta, deltaDirection, sparkline, trend }) {
  return (
    <div style={{
      background: T.canvas,
      borderRadius: '16px',
      padding: '20px',
      border: `1px solid ${T.hairline}`,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '18px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <IconBadge color={iconColor} bg={iconBg}>{icon}</IconBadge>
          <div style={{ fontSize: '14px', fontWeight: 600, color: T.textDeep }}>
            {title}
          </div>
        </div>
        <div style={{ color: T.textFaint, cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}>⋮</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
            <div style={{
              fontSize: '32px',
              fontWeight: 700,
              color: T.textDeep,
              letterSpacing: '-0.02em',
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {value}
            </div>
            {unit && (
              <div style={{ fontSize: '13px', color: T.textMuted, fontWeight: 500 }}>
                {unit}
              </div>
            )}
          </div>
          {delta && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginTop: '10px',
            }}>
              <div style={{
                fontSize: '11px',
                fontWeight: 600,
                padding: '3px 8px',
                borderRadius: '6px',
                background: deltaDirection === 'up' ? T.successWash : T.coralWash,
                color: deltaDirection === 'up' ? T.success : T.coral,
                display: 'flex',
                alignItems: 'center',
                gap: '3px',
              }}>
                {delta}
                <span style={{ fontSize: '10px' }}>
                  {deltaDirection === 'up' ? '↗' : '↘'}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: T.textMuted }}>{trend}</div>
            </div>
          )}
        </div>
        {sparkline && (
          <div style={{ width: '90px', height: '44px', flexShrink: 0 }}>
            {sparkline}
          </div>
        )}
      </div>
    </div>
  );
}

// Mini bar sparkline
function BarSparkline({ data, color, highlightIndex }) {
  const max = Math.max(...data);
  return (
    <svg width="100%" height="100%" viewBox="0 0 90 44" preserveAspectRatio="none">
      {data.map((v, i) => {
        const barWidth = 8;
        const gap = 2;
        const totalWidth = data.length * (barWidth + gap) - gap;
        const startX = (90 - totalWidth) / 2;
        const x = startX + i * (barWidth + gap);
        const h = (v / max) * 36 + 4;
        const y = 44 - h;
        const isHighlight = i === highlightIndex;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barWidth}
            height={h}
            rx={2}
            fill={isHighlight ? color : `${color}40`}
          />
        );
      })}
    </svg>
  );
}

// Mini line sparkline
function LineSparkline({ data, color }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * 86 + 2;
    const y = 42 - ((v - min) / range) * 36 - 2;
    return `${x},${y}`;
  }).join(' ');

  const areaPoints = `2,44 ${points} 88,44`;

  return (
    <svg width="100%" height="100%" viewBox="0 0 90 44" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill="url(#sparkGrad)" />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ============================================================
// CIRCULAR COUNTDOWN — PROMINENT HERO CARD
// ============================================================

function CountdownHero({ lastSwallow, secondsSince, tier, thresholds, onReset }) {
  const mins = Math.floor(secondsSince / 60);
  const secs = secondsSince % 60;

  let label, description, ringColor, bgGradient, pillText;
  let showCheckButton = false;

  if (tier === 0 && secondsSince < 30) {
    label = 'Normal rhythm';
    description = 'Swallowing at a healthy interval';
    ringColor = T.tealPrimary;
    bgGradient = `linear-gradient(135deg, ${T.tealTint} 0%, ${T.tealWash} 100%)`;
    pillText = 'ALL CLEAR';
  } else if (tier === 0) {
    label = 'Extended interval';
    description = 'Slightly longer than baseline';
    ringColor = T.amber;
    bgGradient = `linear-gradient(135deg, #fdf8ec 0%, ${T.amberWash} 100%)`;
    pillText = 'MONITORING';
  } else if (tier === 1) {
    label = 'Nudge threshold';
    description = 'Gentle haptic cue delivered';
    ringColor = T.coral;
    bgGradient = `linear-gradient(135deg, #fdf0f0 0%, ${T.coralWash} 100%)`;
    pillText = 'GENTLE CUE';
  } else if (tier === 2) {
    label = 'Caregiver attention';
    description = `Patient hasn't swallowed in ${mins}m ${secs}s`;
    ringColor = T.tier2;
    bgGradient = `linear-gradient(135deg, ${T.tier2Tint} 0%, ${T.tier2Wash} 100%)`;
    pillText = 'CAREGIVER ATTENTION';
    showCheckButton = true;
  } else {
    // tier 3 or 4 (tier 4 also shows this card under the overlay)
    label = 'Urgent: extended inactivity';
    description = 'Check patient now';
    ringColor = T.tier3;
    bgGradient = `linear-gradient(135deg, ${T.tier3Tint} 0%, ${T.tier3Wash} 100%)`;
    pillText = 'URGENT';
    showCheckButton = true;
  }

  const progress = Math.min(secondsSince / Math.max(thresholds.tier4, 1), 1);
  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progress);

  const pulseClass = tier === 3 ? 'chyme-pulse-border' : '';

  return (
    <div
      className={pulseClass}
      style={{
        background: bgGradient,
        borderRadius: '16px',
        padding: '24px',
        border: `1px solid ${T.hairline}`,
        display: 'flex',
        alignItems: 'center',
        gap: '24px',
        transition: 'background 0.8s ease',
      }}
    >
      {/* Circular countdown */}
      <div style={{ position: 'relative', width: '180px', height: '180px', flexShrink: 0 }}>
        <svg width="180" height="180" viewBox="0 0 180 180">
          {/* Decorative outer dashed ring */}
          <circle
            cx="90"
            cy="90"
            r={radius + 12}
            fill="none"
            stroke={ringColor}
            strokeWidth="1"
            strokeDasharray="2 5"
            opacity="0.3"
          />
          {/* White inner background */}
          <circle cx="90" cy="90" r={radius} fill={T.canvas} />
          {/* Background track */}
          <circle
            cx="90"
            cy="90"
            r={radius}
            fill="none"
            stroke={`${ringColor}20`}
            strokeWidth="6"
          />
          {/* Progress */}
          <circle
            cx="90"
            cy="90"
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 90 90)"
            style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.8s ease' }}
          />
        </svg>
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{
            fontSize: '48px',
            fontWeight: 700,
            color: T.textDeep,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.03em',
          }}>
            {secondsSince}
          </div>
          <div style={{
            fontSize: '10px',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            marginTop: '6px',
            color: T.textMuted,
            fontWeight: 600,
          }}>
            seconds
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1 }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 10px',
          borderRadius: '999px',
          background: T.canvas,
          fontSize: '11px',
          fontWeight: 600,
          color: T.textDeep,
          marginBottom: '12px',
          border: `1px solid ${T.hairline}`,
        }}>
          <div style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: ringColor,
            boxShadow: tier >= 1 ? `0 0 0 3px ${ringColor}33` : 'none',
          }} />
          {pillText}
        </div>
        <div style={{
          fontSize: '22px',
          fontWeight: 700,
          color: T.textDeep,
          letterSpacing: '-0.02em',
          marginBottom: '6px',
        }}>
          {label}
        </div>
        <div style={{
          fontSize: '14px',
          color: T.textMuted,
          lineHeight: 1.5,
          marginBottom: '18px',
        }}>
          {description}. Last swallow at {formatTime(lastSwallow)}.
        </div>

        {showCheckButton && (
          <button
            onClick={onReset}
            onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(0.92)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; }}
            style={{
              marginBottom: '18px',
              padding: '10px 18px',
              borderRadius: '10px',
              border: 'none',
              background: ringColor,
              color: '#fff',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              letterSpacing: '0.01em',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              boxShadow: `0 2px 8px ${ringColor}33`,
              transition: 'filter 0.15s ease',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Check patient
          </button>
        )}

        <div style={{ display: 'flex', gap: '20px' }}>
          <div>
            <div style={{ fontSize: '11px', color: T.textMuted, marginBottom: '2px' }}>Threshold</div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep, fontVariantNumeric: 'tabular-nums' }}>{thresholds.tier1}s</div>
          </div>
          <div style={{ width: '1px', background: T.hairline }} />
          <div>
            <div style={{ fontSize: '11px', color: T.textMuted, marginBottom: '2px' }}>Nudges today</div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep, fontVariantNumeric: 'tabular-nums' }}>
              {todayNudges.length}
            </div>
          </div>
          <div style={{ width: '1px', background: T.hairline }} />
          <div>
            <div style={{ fontSize: '11px', color: T.textMuted, marginBottom: '2px' }}>Since morning</div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep, fontVariantNumeric: 'tabular-nums' }}>
              {todaySwallows.length}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SOS EMERGENCY OVERLAY (Tier 4)
// ============================================================

function SOSOverlay({ secondsSince, calling, onCall, onDismiss }) {
  const minutes = Math.floor(secondsSince / 60);
  const seconds = secondsSince % 60;

  const buttonStyle = {
    width: '100%',
    padding: '18px 22px',
    borderRadius: '12px',
    border: 'none',
    background: T.tier4,
    color: '#fff',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    transition: 'background 0.15s ease',
  };

  const callIcon = (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
    </svg>
  );

  return (
    <div
      className="chyme-overlay"
      onClick={onDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(90, 10, 10, 0.55)',
        backdropFilter: 'blur(3px)',
        WebkitBackdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '40px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.canvas,
          borderRadius: '20px',
          padding: '40px 44px',
          maxWidth: '560px',
          width: '100%',
          border: `2px solid ${T.tier4}`,
          boxShadow: '0 30px 80px rgba(0, 0, 0, 0.4)',
        }}
      >
        {calling ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{
              fontSize: '11px',
              color: T.textMuted,
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
              fontWeight: 700,
              marginBottom: '14px',
            }}>
              Connecting
            </div>
            <div style={{
              fontSize: '26px',
              fontWeight: 700,
              color: T.textDeep,
              letterSpacing: '-0.01em',
              marginBottom: '26px',
            }}>
              Calling {calling}…
            </div>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div
                className="chyme-spin"
                style={{
                  width: '44px',
                  height: '44px',
                  border: `3px solid ${T.tier4}33`,
                  borderTopColor: T.tier4,
                  borderRadius: '50%',
                }}
              />
            </div>
            <div style={{
              fontSize: '12px',
              color: T.textFaint,
              marginTop: '22px',
            }}>
              This dialog will close automatically.
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '22px' }}>
              <div style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: T.tier4,
                boxShadow: `0 0 0 4px ${T.tier4}22`,
              }} />
              <div style={{
                fontSize: '12px',
                fontWeight: 700,
                color: T.tier4,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
              }}>
                Emergency
              </div>
            </div>

            <div style={{
              fontSize: '26px',
              fontWeight: 700,
              color: T.textDeep,
              letterSpacing: '-0.01em',
              marginBottom: '10px',
              lineHeight: 1.25,
            }}>
              Contact caregiver immediately
            </div>

            <div style={{
              fontSize: '14px',
              color: T.textMuted,
              lineHeight: 1.6,
              marginBottom: '28px',
            }}>
              Extended inactivity detected. No swallow has been recorded in{' '}
              <span style={{ color: T.textDeep, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {minutes}m {seconds}s
              </span>
              .
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                onClick={(e) => { e.stopPropagation(); onCall('Maria Chen'); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = T.tier4Dark; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = T.tier4; }}
                style={buttonStyle}
              >
                {callIcon}
                <div>
                  <div style={{ fontSize: '16px', fontWeight: 700 }}>Call Maria Chen</div>
                  <div style={{ fontSize: '13px', fontWeight: 500, opacity: 0.9, marginTop: '2px', fontVariantNumeric: 'tabular-nums' }}>
                    (555) 123-4567
                  </div>
                </div>
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); onCall('911'); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = T.tier4Dark; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = T.tier4; }}
                style={buttonStyle}
              >
                {callIcon}
                <div>
                  <div style={{ fontSize: '16px', fontWeight: 700 }}>Call 911</div>
                  <div style={{ fontSize: '13px', fontWeight: 500, opacity: 0.9, marginTop: '2px' }}>
                    Emergency services
                  </div>
                </div>
              </button>
            </div>

            <div style={{
              fontSize: '11px',
              color: T.textFaint,
              textAlign: 'center',
              marginTop: '22px',
              letterSpacing: '0.02em',
            }}>
              Tap outside this dialog to dismiss
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 24-HOUR TIMELINE CHART
// ============================================================

function Timeline24h({ swallows, nudges }) {
  const { windowStart, windowEnd } = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    return { windowStart: start, windowEnd: end };
  }, []);

  const windowMs = windowEnd - windowStart;
  const positionFor = (date) => Math.max(0, Math.min(100, ((date - windowStart) / windowMs) * 100));

  const hourTicks = [];
  const tickStart = new Date(windowStart);
  tickStart.setMinutes(0, 0, 0);
  tickStart.setHours(tickStart.getHours() + 1);
  for (let t = tickStart.getTime(); t <= windowEnd.getTime(); t += 3 * 60 * 60 * 1000) {
    hourTicks.push(new Date(t));
  }

  const visibleSwallows = swallows.filter((s) => s >= windowStart && s <= windowEnd);
  const visibleNudges = nudges.filter((n) => n >= windowStart && n <= windowEnd);

  return (
    <div style={{
      background: T.canvas,
      borderRadius: '16px',
      padding: '22px 24px',
      border: `1px solid ${T.hairline}`,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '8px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <IconBadge color={T.tealPrimary} bg={T.tealWash}>{icons.activity}</IconBadge>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep }}>
              Swallow activity
            </div>
            <div style={{ fontSize: '12px', color: T.textMuted, marginTop: '2px' }}>
              Last 24 hours
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '14px', fontSize: '12px', color: T.textBody, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: T.tealPrimary }} />
            <span>Swallows</span>
            <span style={{ color: T.textDeep, fontWeight: 600 }}>{visibleSwallows.length}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '2px', height: '12px', background: T.coral }} />
            <span>Nudges</span>
            <span style={{ color: T.textDeep, fontWeight: 600 }}>{visibleNudges.length}</span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: '20px' }}>
        <div style={{ position: 'relative', height: '80px' }}>
          <div style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            height: '44px',
            background: T.tealTint,
            borderRadius: '6px',
          }} />
          {hourTicks.map((tick, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${positionFor(tick)}%`,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: '1px',
                height: '44px',
                background: 'rgba(45, 122, 110, 0.12)',
              }}
            />
          ))}
          {visibleSwallows.map((s, i) => (
            <div
              key={`s-${i}`}
              title={formatTimeWithSeconds(s)}
              style={{
                position: 'absolute',
                left: `${positionFor(s)}%`,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: T.tealPrimary,
                boxShadow: `0 0 0 2px ${T.canvas}`,
              }}
            />
          ))}
          {visibleNudges.map((n, i) => (
            <div
              key={`n-${i}`}
              title={`Nudge at ${formatTimeWithSeconds(n)}`}
              style={{
                position: 'absolute',
                left: `${positionFor(n)}%`,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: '2px',
                height: '54px',
                background: T.coral,
                borderRadius: '1px',
              }}
            />
          ))}
        </div>

        <div style={{
          position: 'relative',
          height: '16px',
          fontSize: '11px',
          color: T.textFaint,
          marginTop: '8px',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {hourTicks.map((tick, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${positionFor(tick)}%`,
                transform: 'translateX(-50%)',
              }}
            >
              {tick.getHours().toString().padStart(2, '0')}:00
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ALERT LOG
// ============================================================

function AlertLog({ nudges }) {
  const sorted = [...nudges].sort((a, b) => b - a);

  return (
    <div style={{
      background: T.canvas,
      borderRadius: '16px',
      border: `1px solid ${T.hairline}`,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      height: '100%',
      maxHeight: '440px',
    }}>
      <div style={{
        padding: '20px 22px 16px',
        borderBottom: `1px solid ${T.hairlineSoft}`,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
      }}>
        <IconBadge color={T.coral} bg={T.coralWash}>{icons.bell}</IconBadge>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep }}>
            Alert log
          </div>
          <div style={{ fontSize: '12px', color: T.textMuted, marginTop: '2px' }}>
            {sorted.length} haptic triggers today
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {sorted.length === 0 && (
          <div style={{ padding: '48px 22px', textAlign: 'center', color: T.textFaint, fontSize: '13px' }}>
            No haptic cues today.
          </div>
        )}
        {sorted.map((n, i) => {
          const minutesAgo = Math.floor((new Date() - n) / 60000);
          const timeLabel = minutesAgo < 60
            ? `${minutesAgo}m ago`
            : `${Math.floor(minutesAgo / 60)}h ${minutesAgo % 60}m`;

          return (
            <div
              key={i}
              style={{
                padding: '12px 22px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                borderBottom: i < sorted.length - 1 ? `1px solid ${T.hairlineSoft}` : 'none',
              }}
            >
              <div style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: T.coralWash,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: T.coral,
                flexShrink: 0,
              }}>
                {icons.bell}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '13px',
                  color: T.textDeep,
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 600,
                }}>
                  {formatTimeWithSeconds(n)}
                </div>
                <div style={{ fontSize: '11px', color: T.textMuted, marginTop: '2px' }}>
                  Haptic cue delivered
                </div>
              </div>
              <div style={{
                fontSize: '11px',
                color: T.textFaint,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}>
                {timeLabel}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// OVERVIEW PAGE
// ============================================================

function OverviewPage({ thresholds }) {
  const realLastSwallow = todaySwallows[todaySwallows.length - 1] || new Date();
  const [lastSwallowOverride, setLastSwallowOverride] = useState(null);
  const lastSwallow = lastSwallowOverride || realLastSwallow;

  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsSince = Math.max(0, Math.floor((now - lastSwallow) / 1000));
  const tier = secondsSince >= thresholds.tier4 ? 4
             : secondsSince >= thresholds.tier3 ? 3
             : secondsSince >= thresholds.tier2 ? 2
             : secondsSince >= thresholds.tier1 ? 1
             : 0;

  const handleReset = () => setLastSwallowOverride(new Date());

  const [calling, setCalling] = useState(null);
  useEffect(() => {
    if (!calling) return;
    const t = setTimeout(() => {
      setCalling(null);
      setLastSwallowOverride(new Date());
    }, 3000);
    return () => clearTimeout(t);
  }, [calling]);

  const hourOfDay = new Date().getHours();
  const expectedByNow = Math.round((yesterdaySwallows.length * hourOfDay) / 24);
  const delta = todaySwallows.length - expectedByNow;
  const deltaPct = Math.round((delta / Math.max(expectedByNow, 1)) * 100);

  const hourlySwallowCounts = Array.from({ length: 8 }, (_, i) => {
    const hourStart = new Date();
    hourStart.setHours(hourStart.getHours() - (7 - i), 0, 0, 0);
    const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
    return todaySwallows.filter((s) => s >= hourStart && s < hourEnd).length;
  });

  const sevenDaySwallowCounts = sevenDayHistory.map((d) => d.swallows);
  const sevenDayNudgeCounts = sevenDayHistory.map((d) => d.nudges);

  return (
    <>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '16px',
        marginBottom: '16px',
      }}>
        <CountdownHero
          lastSwallow={lastSwallow}
          secondsSince={secondsSince}
          tier={tier}
          thresholds={thresholds}
          onReset={handleReset}
        />

        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '16px',
        }}>
          <KPICard
            icon={icons.droplet}
            iconColor={T.tealPrimary}
            iconBg={T.tealWash}
            title="Today"
            value={todaySwallows.length}
            unit="swallows"
            delta={`${Math.abs(deltaPct)}%`}
            deltaDirection={delta >= 0 ? 'up' : 'down'}
            trend="vs expected"
            sparkline={<BarSparkline data={hourlySwallowCounts} color={T.tealPrimary} highlightIndex={hourlySwallowCounts.length - 1} />}
          />
          <KPICard
            icon={icons.calendar}
            iconColor={T.amber}
            iconBg={T.amberWash}
            title="Yesterday"
            value={yesterdaySwallows.length}
            unit="total"
            sparkline={<LineSparkline data={sevenDaySwallowCounts.slice(0, -1)} color={T.amber} />}
          />
          <KPICard
            icon={icons.trending}
            iconColor={T.success}
            iconBg={T.successWash}
            title="7-day average"
            value={sevenDayAverage}
            unit="per day"
            sparkline={<LineSparkline data={sevenDaySwallowCounts} color={T.success} />}
          />
          <KPICard
            icon={icons.bell}
            iconColor={T.coral}
            iconBg={T.coralWash}
            title="Nudges today"
            value={todayNudges.length}
            unit="triggers"
            sparkline={<BarSparkline data={sevenDayNudgeCounts} color={T.coral} highlightIndex={sevenDayNudgeCounts.length - 1} />}
          />
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.35fr 1fr',
        gap: '16px',
      }}>
        <Timeline24h swallows={todaySwallows} nudges={todayNudges} />
        <AlertLog nudges={todayNudges} />
      </div>

      {tier >= 4 && (
        <SOSOverlay
          secondsSince={secondsSince}
          calling={calling}
          onCall={setCalling}
          onDismiss={handleReset}
        />
      )}
    </>
  );
}

// ============================================================
// PATIENT HISTORY PAGE
// ============================================================

function StatCard({ icon, iconColor, iconBg, title, value, unit }) {
  return (
    <div style={{
      background: T.canvas,
      borderRadius: '16px',
      padding: '20px',
      border: `1px solid ${T.hairline}`,
      display: 'flex',
      alignItems: 'center',
      gap: '14px',
    }}>
      <IconBadge color={iconColor} bg={iconBg}>{icon}</IconBadge>
      <div>
        <div style={{ fontSize: '13px', color: T.textMuted, fontWeight: 500 }}>{title}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '4px' }}>
          <div style={{
            fontSize: '24px',
            fontWeight: 700,
            color: T.textDeep,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {value}
          </div>
          {unit && <div style={{ fontSize: '12px', color: T.textMuted }}>{unit}</div>}
        </div>
      </div>
    </div>
  );
}

function DayCard({ day }) {
  const dayStart = new Date(day.date);
  dayStart.setHours(7, 0, 0, 0);
  const dayEnd = new Date(day.date);
  dayEnd.setHours(22, 30, 0, 0);
  const windowMs = dayEnd - dayStart;
  const positionFor = (d) => Math.max(0, Math.min(100, ((d - dayStart) / windowMs) * 100));

  const today = new Date();
  const isToday = day.date.toDateString() === today.toDateString();

  return (
    <div style={{
      background: T.canvas,
      borderRadius: '16px',
      padding: '18px 22px',
      border: `1px solid ${T.hairline}`,
      display: 'flex',
      alignItems: 'center',
      gap: '20px',
    }}>
      <div style={{ width: '100px', flexShrink: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: T.textDeep }}>
          {isToday ? 'Today' : formatDayShort(day.date)}
        </div>
        <div style={{ fontSize: '11px', color: T.textMuted, marginTop: '2px' }}>
          {day.date.toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, position: 'relative', height: '40px' }}>
        <div style={{
          position: 'absolute',
          left: 0, right: 0, top: '50%', transform: 'translateY(-50%)',
          height: '24px',
          background: T.tealTint,
          borderRadius: '4px',
        }} />
        {day.swallows.map((s, i) => (
          <div key={`s${i}`} style={{
            position: 'absolute',
            left: `${positionFor(s)}%`,
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: '4px',
            height: '4px',
            borderRadius: '50%',
            background: T.tealPrimary,
          }} />
        ))}
        {day.nudges.map((n, i) => (
          <div key={`n${i}`} style={{
            position: 'absolute',
            left: `${positionFor(n)}%`,
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: '2px',
            height: '30px',
            background: T.coral,
            borderRadius: '1px',
          }} />
        ))}
      </div>

      <div style={{ display: 'flex', gap: '24px', flexShrink: 0 }}>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontSize: '18px',
            fontWeight: 700,
            color: T.textDeep,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1,
          }}>
            {day.swallows.length}
          </div>
          <div style={{ fontSize: '11px', color: T.textMuted, marginTop: '3px' }}>swallows</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontSize: '18px',
            fontWeight: 700,
            color: T.coral,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1,
          }}>
            {day.nudges.length}
          </div>
          <div style={{ fontSize: '11px', color: T.textMuted, marginTop: '3px' }}>nudges</div>
        </div>
      </div>
    </div>
  );
}

function PatientHistoryPage() {
  const maxSwallows = Math.max(...sevenDayHistory.map((d) => d.swallows), 1);
  const totalSwallows = sevenDayHistory.reduce((s, d) => s + d.swallows, 0);
  const totalNudges = sevenDayHistory.reduce((s, d) => s + d.nudges, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '16px',
      }}>
        <StatCard
          icon={icons.calendar}
          iconColor={T.tealPrimary}
          iconBg={T.tealWash}
          title="7-day total"
          value={totalSwallows}
          unit="swallows"
        />
        <StatCard
          icon={icons.trending}
          iconColor={T.success}
          iconBg={T.successWash}
          title="Daily average"
          value={sevenDayAverage}
          unit="per day"
        />
        <StatCard
          icon={icons.bell}
          iconColor={T.coral}
          iconBg={T.coralWash}
          title="Total nudges"
          value={totalNudges}
          unit="triggers"
        />
      </div>

      <div style={{
        background: T.canvas,
        borderRadius: '16px',
        padding: '22px 24px',
        border: `1px solid ${T.hairline}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '22px' }}>
          <IconBadge color={T.tealPrimary} bg={T.tealWash}>{icons.chart}</IconBadge>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep }}>
              Daily swallow totals
            </div>
            <div style={{ fontSize: '12px', color: T.textMuted, marginTop: '2px' }}>
              Past 7 days
            </div>
          </div>
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          height: '180px',
          gap: '14px',
        }}>
          {sevenDayHistory.map((d, i) => {
            const pct = (d.swallows / maxSwallows) * 100;
            const isToday = i === sevenDayHistory.length - 1;
            return (
              <div key={i} style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-end',
                height: '100%',
                gap: '8px',
              }}>
                <div style={{
                  fontSize: '12px',
                  color: T.textDeep,
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {d.swallows}
                </div>
                <div style={{
                  width: '100%',
                  background: isToday ? T.tealPrimary : T.tealLight,
                  height: `${pct}%`,
                  borderRadius: '6px',
                  minHeight: '4px',
                }} />
                <div style={{ fontSize: '11px', color: T.textMuted, fontWeight: 500 }}>
                  {formatDayShort(d.date)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {[...sevenDayDetailedHistory].reverse().map((day, i) => (
          <DayCard key={i} day={day} />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// ALERTS PAGE
// ============================================================

function AlertsPage() {
  const sorted = [...allNudgesDetailed].sort((a, b) => b.time - a.time);

  const groups = [];
  let currentGroup = null;
  sorted.forEach((n) => {
    const key = n.date.toDateString();
    if (!currentGroup || currentGroup.key !== key) {
      currentGroup = { key, date: n.date, items: [] };
      groups.push(currentGroup);
    }
    currentGroup.items.push(n);
  });

  const reasonFor = (n) => {
    if (n.gapSec == null) return 'Extended inactivity detected';
    return `Gap of ${n.gapSec}s exceeded 60s threshold`;
  };

  const dayLabel = (d) => {
    const today = new Date();
    const yest = new Date();
    yest.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{
        background: T.canvas,
        borderRadius: '16px',
        padding: '22px 24px',
        border: `1px solid ${T.hairline}`,
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
      }}>
        <IconBadge color={T.coral} bg={T.coralWash}>{icons.bell}</IconBadge>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '16px', fontWeight: 600, color: T.textDeep }}>
            All haptic triggers
          </div>
          <div style={{ fontSize: '12px', color: T.textMuted, marginTop: '2px' }}>
            {sorted.length} events across the past 7 days
          </div>
        </div>
        <div style={{ fontSize: '13px', color: T.textMuted }}>
          Threshold:{' '}
          <span style={{ color: T.textDeep, fontWeight: 600 }}>60s</span>
        </div>
      </div>

      {groups.length === 0 && (
        <div style={{
          background: T.canvas,
          borderRadius: '16px',
          padding: '48px',
          textAlign: 'center',
          color: T.textFaint,
          border: `1px solid ${T.hairline}`,
        }}>
          No haptic triggers recorded in the past 7 days.
        </div>
      )}

      {groups.map((group, gi) => (
        <div key={gi} style={{
          background: T.canvas,
          borderRadius: '16px',
          border: `1px solid ${T.hairline}`,
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '14px 22px',
            borderBottom: `1px solid ${T.hairlineSoft}`,
            fontSize: '13px',
            fontWeight: 600,
            color: T.textDeep,
            display: 'flex',
            justifyContent: 'space-between',
            background: T.tealTint,
          }}>
            <span>{dayLabel(group.date)}</span>
            <span style={{ color: T.textMuted, fontWeight: 500 }}>
              {group.items.length} {group.items.length === 1 ? 'alert' : 'alerts'}
            </span>
          </div>
          {group.items.map((n, i) => (
            <div key={i} style={{
              padding: '12px 22px',
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              borderBottom: i < group.items.length - 1 ? `1px solid ${T.hairlineSoft}` : 'none',
            }}>
              <div style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: T.coralWash,
                color: T.coral,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                {icons.bell}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: T.textDeep,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {formatTimeWithSeconds(n.time)}
                </div>
                <div style={{ fontSize: '12px', color: T.textMuted, marginTop: '2px' }}>
                  {reasonFor(n)}
                </div>
              </div>
              <div style={{
                fontSize: '11px',
                color: T.success,
                padding: '3px 8px',
                background: T.successWash,
                borderRadius: '6px',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}>
                Haptic delivered
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ============================================================
// PATIENT PROFILE PAGE
// ============================================================

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: '11px',
      fontWeight: 600,
      color: T.textMuted,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      marginBottom: '10px',
    }}>
      {children}
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '9px 0',
      borderBottom: `1px solid ${T.hairlineSoft}`,
      fontSize: '13px',
      gap: '16px',
    }}>
      <span style={{ color: T.textMuted, flexShrink: 0 }}>{label}</span>
      <span style={{ color: T.textDeep, fontWeight: 500, textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}

function PatientProfilePage() {
  const patient = {
    name: 'Robert Chen',
    initials: 'RC',
    id: 'Patient 0427',
    age: 67,
    sex: 'Male',
    diagnosis: "Parkinson's disease (idiopathic)",
    diagnosisDate: 'March 2021',
    stage: 'Hoehn & Yahr stage 2',
    caregiverName: 'Elena Chen',
    caregiverRelation: 'Wife',
    caregiverPhone: '(555) 842-0193',
    caregiverEmail: 'elena.chen@example.com',
    enrolledSince: 'January 2026',
  };

  const device = {
    id: 'CY-0427-A',
    firmware: 'v0.1 (2026-04-02)',
    battery: '78%',
    signal: 'Strong',
    lastSync: '2 min ago',
    wornSince: '7:14 AM today',
  };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1.2fr 1fr',
      gap: '16px',
      alignItems: 'start',
    }}>
      <div style={{
        background: T.canvas,
        borderRadius: '16px',
        border: `1px solid ${T.hairline}`,
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '28px 28px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: '20px',
          background: `linear-gradient(135deg, ${T.tealTint} 0%, ${T.tealWash} 100%)`,
          borderBottom: `1px solid ${T.hairline}`,
        }}>
          <div style={{
            width: '72px',
            height: '72px',
            borderRadius: '50%',
            background: `linear-gradient(135deg, ${T.tealSoft}, ${T.tealPrimary})`,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '26px',
            fontWeight: 700,
          }}>
            {patient.initials}
          </div>
          <div>
            <div style={{
              fontSize: '22px',
              fontWeight: 700,
              color: T.textDeep,
              letterSpacing: '-0.01em',
            }}>
              {patient.name}
            </div>
            <div style={{ fontSize: '13px', color: T.textMuted, marginTop: '4px' }}>
              {patient.id} · Enrolled {patient.enrolledSince}
            </div>
          </div>
        </div>

        <div style={{ padding: '22px 28px' }}>
          <SectionLabel>Demographics</SectionLabel>
          <InfoRow label="Age" value={`${patient.age} years`} />
          <InfoRow label="Sex" value={patient.sex} />

          <div style={{ height: '18px' }} />

          <SectionLabel>Diagnosis</SectionLabel>
          <InfoRow label="Condition" value={patient.diagnosis} />
          <InfoRow label="Diagnosed" value={patient.diagnosisDate} />
          <InfoRow label="Staging" value={patient.stage} />

          <div style={{ height: '18px' }} />

          <SectionLabel>Primary caregiver</SectionLabel>
          <InfoRow
            label="Name"
            value={`${patient.caregiverName} (${patient.caregiverRelation})`}
          />
          <InfoRow label="Phone" value={patient.caregiverPhone} />
          <InfoRow label="Email" value={patient.caregiverEmail} />
        </div>
      </div>

      <div style={{
        background: T.canvas,
        borderRadius: '16px',
        border: `1px solid ${T.hairline}`,
        padding: '22px 24px',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '18px',
        }}>
          <IconBadge color={T.tealPrimary} bg={T.tealWash}>
            {icons.activity}
          </IconBadge>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep }}>
              Device status
            </div>
            <div style={{ fontSize: '12px', color: T.textMuted, marginTop: '2px' }}>
              ChYme wearable
            </div>
          </div>
        </div>

        <div style={{
          padding: '14px 16px',
          background: T.successWash,
          borderRadius: '10px',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          <div style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: T.success,
            boxShadow: `0 0 0 4px ${T.success}33`,
          }} />
          <div style={{ fontSize: '13px', fontWeight: 600, color: T.success }}>
            Connected · {device.signal} signal
          </div>
        </div>

        <InfoRow label="Device ID" value={device.id} />
        <InfoRow label="Firmware" value={device.firmware} />
        <InfoRow label="Battery" value={device.battery} />
        <InfoRow label="Worn since" value={device.wornSince} />
        <InfoRow label="Last sync" value={device.lastSync} />
      </div>
    </div>
  );
}

// ============================================================
// REPORTS PAGE — clinician-facing
// ============================================================

function DailyCountLineChart({ data, avg }) {
  const W = 760, H = 260;
  const PL = 44, PR = 24, PT = 24, PB = 40;
  const innerW = W - PL - PR;
  const innerH = H - PT - PB;

  const counts = data.map((d) => d.count);
  const maxRaw = Math.max(...counts, 1);
  const maxY = Math.ceil((maxRaw * 1.15) / 50) * 50 || 50;

  const x = (i) => PL + (i / Math.max(data.length - 1, 1)) * innerW;
  const y = (v) => PT + innerH - (v / maxY) * innerH;

  const linePoints = data.map((d, i) => `${x(i)},${y(d.count)}`).join(' ');
  const areaPoints = `${x(0)},${PT + innerH} ${linePoints} ${x(data.length - 1)},${PT + innerH}`;

  const yTicks = [0, 0.25, 0.5, 0.75, 1.0];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="dailyCountArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={T.tealSoft} stopOpacity="0.32" />
          <stop offset="100%" stopColor={T.tealSoft} stopOpacity="0" />
        </linearGradient>
      </defs>

      {yTicks.map((p, i) => (
        <line
          key={i}
          x1={PL}
          x2={PL + innerW}
          y1={PT + innerH * (1 - p)}
          y2={PT + innerH * (1 - p)}
          stroke={T.hairlineSoft}
          strokeWidth="1"
        />
      ))}
      {yTicks.map((p, i) => (
        <text
          key={i}
          x={PL - 10}
          y={PT + innerH * (1 - p) + 4}
          textAnchor="end"
          fontSize="11"
          fill={T.textMuted}
        >
          {Math.round(maxY * p)}
        </text>
      ))}

      <polygon points={areaPoints} fill="url(#dailyCountArea)" />
      <polyline
        points={linePoints}
        fill="none"
        stroke={T.tealPrimary}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {data.map((d, i) => (
        <circle key={i} cx={x(i)} cy={y(d.count)} r="2.4" fill={T.tealPrimary} />
      ))}

      <line
        x1={PL}
        x2={PL + innerW}
        y1={y(avg)}
        y2={y(avg)}
        stroke={T.coral}
        strokeWidth="1.5"
        strokeDasharray="5 4"
      />
      <rect
        x={PL + innerW - 118}
        y={y(avg) - 20}
        width="114"
        height="18"
        rx="4"
        fill={T.canvas}
        stroke={T.coral}
        strokeWidth="1"
      />
      <text
        x={PL + innerW - 10}
        y={y(avg) - 7}
        textAnchor="end"
        fontSize="11"
        fill={T.coral}
        fontWeight="600"
      >
        30-day avg: {Math.round(avg)}
      </text>

      {data.map((d, i) => {
        if (i % 5 !== 0 && i !== data.length - 1) return null;
        return (
          <text
            key={i}
            x={x(i)}
            y={PT + innerH + 22}
            textAnchor="middle"
            fontSize="11"
            fill={T.textMuted}
          >
            {d.date.toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </text>
        );
      })}
    </svg>
  );
}

function GapHistogram({ buckets }) {
  const labels = ['0–30s', '30–60s', '60–120s', '120–240s', '240s+'];
  const W = 760, H = 260;
  const PL = 44, PR = 24, PT = 24, PB = 40;
  const innerW = W - PL - PR;
  const innerH = H - PT - PB;

  const max = Math.max(...buckets, 1);
  const slotW = innerW / buckets.length;
  const barW = slotW * 0.6;
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
      {yTicks.map((p, i) => (
        <line
          key={i}
          x1={PL}
          x2={PL + innerW}
          y1={PT + innerH * (1 - p)}
          y2={PT + innerH * (1 - p)}
          stroke={T.hairlineSoft}
          strokeWidth="1"
        />
      ))}
      {yTicks.map((p, i) => (
        <text
          key={i}
          x={PL - 10}
          y={PT + innerH * (1 - p) + 4}
          textAnchor="end"
          fontSize="11"
          fill={T.textMuted}
        >
          {Math.round(max * p)}
        </text>
      ))}

      {buckets.map((v, i) => {
        const barH = (v / max) * innerH;
        const bx = PL + i * slotW + (slotW - barW) / 2;
        const by = PT + innerH - barH;
        return (
          <g key={i}>
            <rect x={bx} y={by} width={barW} height={barH} rx="4" fill={T.tealPrimary} />
            {v > 0 && (
              <text
                x={bx + barW / 2}
                y={by - 6}
                textAnchor="middle"
                fontSize="11"
                fill={T.textDeep}
                fontWeight="600"
              >
                {v}
              </text>
            )}
            <text
              x={PL + i * slotW + slotW / 2}
              y={PT + innerH + 22}
              textAnchor="middle"
              fontSize="11"
              fill={T.textMuted}
            >
              {labels[i]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const CLINICAL_NOTES_KEY = 'chyme.clinicalNotes';
const DEFAULT_CLINICAL_NOTES =
  'Patient started Sinemet dose increase on April 10. Swallow frequency improved over following week.';

function ClinicalNotes() {
  const [notes, setNotes] = useState(() => {
    try {
      const stored = localStorage.getItem(CLINICAL_NOTES_KEY);
      return stored !== null ? stored : DEFAULT_CLINICAL_NOTES;
    } catch {
      return DEFAULT_CLINICAL_NOTES;
    }
  });

  useEffect(() => {
    try { localStorage.setItem(CLINICAL_NOTES_KEY, notes); } catch {}
  }, [notes]);

  return (
    <textarea
      value={notes}
      onChange={(e) => setNotes(e.target.value)}
      placeholder="Add observations about the patient's swallow patterns, medication changes, or care plan updates…"
      style={{
        width: '100%',
        minHeight: '140px',
        padding: '14px 16px',
        borderRadius: '10px',
        border: `1px solid ${T.hairline}`,
        fontSize: '14px',
        fontFamily: 'inherit',
        color: T.textDeep,
        background: T.tealTint,
        resize: 'vertical',
        lineHeight: 1.55,
        outline: 'none',
      }}
      onFocus={(e) => { e.currentTarget.style.borderColor = T.tealPrimary; }}
      onBlur={(e) => { e.currentTarget.style.borderColor = T.hairline; }}
    />
  );
}

function BigStat({ label, value, color }) {
  return (
    <div style={{
      padding: '18px 20px',
      background: T.canvas,
      border: `1px solid ${T.hairline}`,
      borderRadius: '12px',
      flex: 1,
      minWidth: '140px',
    }}>
      <div style={{
        fontSize: '11px',
        fontWeight: 600,
        color: T.textMuted,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        marginBottom: '10px',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: '36px',
        fontWeight: 700,
        color: color,
        letterSpacing: '-0.02em',
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
    </div>
  );
}

function ReportsPage() {
  const patientName = 'Robert Chen';
  const patientId = 'Patient 0427';
  const reportRef = useRef(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);

  const lineData = useMemo(
    () => thirtyDayDetailedHistory.map((d) => ({ date: d.date, count: d.swallows.length })),
    []
  );
  const avg = useMemo(
    () => lineData.reduce((s, d) => s + d.count, 0) / Math.max(lineData.length, 1),
    [lineData]
  );

  const startDate = thirtyDayDetailedHistory[0].date;
  const endDate = thirtyDayDetailedHistory[thirtyDayDetailedHistory.length - 1].date;
  const generatedAt = new Date();

  const fmtRange = (d) => d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
  const fmtGen = (d) => d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

  const handleDownload = async () => {
    if (!reportRef.current) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const canvas = await html2canvas(reportRef.current, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
      });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;

      let heightLeft = imgH;
      let position = 0;
      pdf.addImage(imgData, 'PNG', 0, position, imgW, imgH);
      heightLeft -= pageH;

      while (heightLeft > 0) {
        position = heightLeft - imgH;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, position, imgW, imgH);
        heightLeft -= pageH;
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      const slug = patientName.toLowerCase().replace(/\s+/g, '-');
      pdf.save(`swallow-report-${slug}-${dateStr}.pdf`);
    } catch (err) {
      console.error(err);
      setDownloadError('Could not generate PDF. Try again.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div ref={reportRef} style={{
        background: T.canvas,
        borderRadius: '16px',
        border: `1px solid ${T.hairline}`,
        padding: '32px 36px',
        display: 'flex',
        flexDirection: 'column',
        gap: '28px',
      }}>
        {/* 1. Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '20px',
          paddingBottom: '22px',
          borderBottom: `1px solid ${T.hairline}`,
        }}>
          <div>
            <div style={{
              fontSize: '11px',
              fontWeight: 700,
              color: T.tealPrimary,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              marginBottom: '10px',
            }}>
              ChYme clinical report
            </div>
            <div style={{
              fontSize: '26px',
              fontWeight: 700,
              color: T.textDeep,
              letterSpacing: '-0.01em',
              marginBottom: '8px',
            }}>
              Swallow Activity Report
            </div>
            <div style={{ fontSize: '13px', color: T.textMuted, lineHeight: 1.6 }}>
              <div><strong style={{ color: T.textDeep, fontWeight: 600 }}>{patientName}</strong> · {patientId}</div>
              <div>Reporting period: {fmtRange(startDate)} – {fmtRange(endDate)}</div>
              <div>Report generated: {fmtGen(generatedAt)}</div>
            </div>
          </div>
          <div style={{
            width: '56px',
            height: '56px',
            borderRadius: '14px',
            background: T.tealWash,
            color: T.tealPrimary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <div style={{ transform: 'scale(1.6)' }}>{icons.chart}</div>
          </div>
        </div>

        {/* 2. Line chart */}
        <div>
          <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep, marginBottom: '4px' }}>
            Daily swallow count
          </div>
          <div style={{ fontSize: '12px', color: T.textMuted, marginBottom: '14px' }}>
            Past 30 days. Dashed line shows the 30-day average.
          </div>
          <DailyCountLineChart data={lineData} avg={avg} />
        </div>

        {/* 3. Histogram */}
        <div>
          <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep, marginBottom: '4px' }}>
            Gap distribution: time between swallows
          </div>
          <div style={{ fontSize: '12px', color: T.textMuted, marginBottom: '14px' }}>
            Past 7 days. Bucketed in seconds between consecutive swallows.
          </div>
          <GapHistogram buckets={gapBuckets7d} />
        </div>

        {/* 4. Alert summary */}
        <div>
          <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep, marginBottom: '4px' }}>
            Alert summary
          </div>
          <div style={{ fontSize: '12px', color: T.textMuted, marginBottom: '14px' }}>
            Counts across the 30-day reporting window.
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <BigStat label="Gentle cues delivered" value={reportMetrics.gentleCues} color={T.coral} />
            <BigStat label="Tier 2 — caregiver attention" value={reportMetrics.tier2} color={T.tier2} />
            <BigStat label="Tier 3 — urgent" value={reportMetrics.tier3} color={T.tier3} />
            <BigStat label="Tier 4 — emergency SOS" value={reportMetrics.tier4} color={T.tier4} />
          </div>
        </div>

        {/* 5. Clinical notes */}
        <div>
          <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep, marginBottom: '4px' }}>
            Clinical notes
          </div>
          <div style={{ fontSize: '12px', color: T.textMuted, marginBottom: '14px' }}>
            Observations from the caregiver or clinician. Saved locally on this device.
          </div>
          <ClinicalNotes />
        </div>
      </div>

      {/* 6. Download button (outside the captured ref so it isn't in the PDF) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <button
          onClick={handleDownload}
          disabled={downloading}
          onMouseEnter={(e) => { if (!downloading) e.currentTarget.style.background = '#1f5a51'; }}
          onMouseLeave={(e) => { if (!downloading) e.currentTarget.style.background = T.tealPrimary; }}
          style={{
            padding: '14px 24px',
            borderRadius: '12px',
            border: 'none',
            background: downloading ? T.textFaint : T.tealPrimary,
            color: '#fff',
            fontSize: '14px',
            fontWeight: 600,
            cursor: downloading ? 'wait' : 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.01em',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '10px',
            boxShadow: `0 2px 10px ${T.tealPrimary}33`,
            transition: 'background 0.15s ease',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          {downloading ? 'Preparing PDF…' : 'Download PDF report'}
        </button>
        {downloadError && (
          <div style={{ fontSize: '13px', color: T.coral }}>{downloadError}</div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// COMING SOON PAGE
// ============================================================

function ComingSoonPage({ title, icon }) {
  return (
    <div style={{
      background: T.canvas,
      borderRadius: '16px',
      border: `1px solid ${T.hairline}`,
      padding: '80px 40px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      minHeight: '420px',
    }}>
      <div style={{
        width: '72px',
        height: '72px',
        borderRadius: '18px',
        background: T.tealWash,
        color: T.tealPrimary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: '20px',
      }}>
        <div style={{ transform: 'scale(2)' }}>{icon}</div>
      </div>
      <div style={{
        fontSize: '22px',
        fontWeight: 700,
        color: T.textDeep,
        letterSpacing: '-0.01em',
      }}>
        {title}
      </div>
      <div style={{
        fontSize: '14px',
        color: T.textMuted,
        marginTop: '8px',
        maxWidth: '360px',
        lineHeight: 1.5,
      }}>
        This section is coming soon. Check back shortly.
      </div>
    </div>
  );
}

// ============================================================
// SETTINGS PAGE
// ============================================================

function ThresholdInput({ label, sublabel, value, onChange }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '14px 0',
      borderBottom: `1px solid ${T.hairlineSoft}`,
      gap: '16px',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: T.textDeep }}>{label}</div>
        <div style={{ fontSize: '12px', color: T.textMuted, marginTop: '2px' }}>{sublabel}</div>
      </div>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexShrink: 0,
      }}>
        <input
          type="number"
          min="1"
          value={value}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          style={{
            width: '100px',
            padding: '9px 12px',
            borderRadius: '8px',
            border: `1px solid ${T.hairline}`,
            fontSize: '14px',
            fontFamily: 'inherit',
            color: T.textDeep,
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'right',
            background: T.canvas,
            outline: 'none',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = T.tealPrimary; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = T.hairline; }}
        />
        <span style={{ fontSize: '13px', color: T.textMuted, width: '32px' }}>sec</span>
      </div>
    </div>
  );
}

function SettingsPage({ thresholds, setThresholds }) {
  const [draft, setDraft] = useState(thresholds);
  const [status, setStatus] = useState(null);

  useEffect(() => { setDraft(thresholds); }, [thresholds]);

  const update = (key, val) => {
    setDraft((prev) => ({ ...prev, [key]: val }));
    setStatus(null);
  };

  const validate = (d) => {
    const keys = ['tier1', 'tier2', 'tier3', 'tier4'];
    for (const k of keys) {
      if (d[k] === '' || !Number.isFinite(d[k]) || d[k] < 1) {
        return `${k} must be a positive number.`;
      }
    }
    if (!(d.tier1 < d.tier2 && d.tier2 < d.tier3 && d.tier3 < d.tier4)) {
      return 'Thresholds must be strictly increasing (Tier 1 < Tier 2 < Tier 3 < Tier 4).';
    }
    return null;
  };

  const handleSave = () => {
    const err = validate(draft);
    if (err) {
      setStatus({ type: 'error', message: err });
      return;
    }
    setThresholds(draft);
    setStatus({ type: 'success', message: 'Saved.' });
    setTimeout(() => setStatus(null), 2000);
  };

  const handleRestore = () => {
    setDraft(DEFAULT_THRESHOLDS);
    setThresholds(DEFAULT_THRESHOLDS);
    setStatus({ type: 'success', message: 'Defaults restored.' });
    setTimeout(() => setStatus(null), 2000);
  };

  const isDirty = JSON.stringify(draft) !== JSON.stringify(thresholds);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '720px' }}>
      <div style={{
        background: T.canvas,
        borderRadius: '16px',
        border: `1px solid ${T.hairline}`,
        padding: '24px 28px',
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
      }}>
        <IconBadge color={T.tealPrimary} bg={T.tealWash}>{icons.settings}</IconBadge>
        <div>
          <div style={{ fontSize: '16px', fontWeight: 600, color: T.textDeep }}>Settings</div>
          <div style={{ fontSize: '12px', color: T.textMuted, marginTop: '2px' }}>
            Configuration for alerts and device behavior
          </div>
        </div>
      </div>

      <div style={{
        background: T.canvas,
        borderRadius: '16px',
        border: `1px solid ${T.hairline}`,
        padding: '24px 28px',
      }}>
        <div style={{ marginBottom: '4px' }}>
          <SectionLabel>Alert thresholds</SectionLabel>
        </div>
        <div style={{ fontSize: '13px', color: T.textMuted, marginBottom: '14px', lineHeight: 1.5 }}>
          Seconds since the last detected swallow before each escalation tier activates.
          Values must increase from Tier 1 to Tier 4.
        </div>

        <div>
          <ThresholdInput
            label="Tier 1 (gentle cue)"
            sublabel="Haptic nudge on the device"
            value={draft.tier1}
            onChange={(v) => update('tier1', v)}
          />
          <ThresholdInput
            label="Tier 2 (caregiver attention)"
            sublabel="Orange banner and Check patient button"
            value={draft.tier2}
            onChange={(v) => update('tier2', v)}
          />
          <ThresholdInput
            label="Tier 3 (urgent)"
            sublabel="Red card, pulsing border, Check patient button"
            value={draft.tier3}
            onChange={(v) => update('tier3', v)}
          />
          <ThresholdInput
            label="Tier 4 (emergency SOS)"
            sublabel="Full-screen overlay with call options"
            value={draft.tier4}
            onChange={(v) => update('tier4', v)}
          />
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginTop: '22px',
          flexWrap: 'wrap',
        }}>
          <button
            onClick={handleSave}
            disabled={!isDirty}
            style={{
              padding: '10px 20px',
              borderRadius: '10px',
              border: 'none',
              background: isDirty ? T.tealPrimary : T.hairline,
              color: isDirty ? '#fff' : T.textFaint,
              fontSize: '13px',
              fontWeight: 600,
              cursor: isDirty ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              transition: 'background 0.15s ease',
            }}
          >
            Save changes
          </button>
          <button
            onClick={handleRestore}
            style={{
              padding: '10px 18px',
              borderRadius: '10px',
              border: `1px solid ${T.hairline}`,
              background: T.canvas,
              color: T.textBody,
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Restore defaults
          </button>
          {status && (
            <div style={{
              fontSize: '13px',
              fontWeight: 500,
              color: status.type === 'error' ? T.coral : T.success,
              padding: '6px 12px',
              borderRadius: '8px',
              background: status.type === 'error' ? T.coralWash : T.successWash,
            }}>
              {status.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// MAIN DASHBOARD
// ============================================================

export default function App() {
  const [activePage, setActivePage] = useState('Overview');

  const [thresholds, setThresholdsState] = useState(() => {
    try {
      const stored = localStorage.getItem(THRESHOLDS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (
          parsed &&
          Number.isFinite(parsed.tier1) &&
          Number.isFinite(parsed.tier2) &&
          Number.isFinite(parsed.tier3) &&
          Number.isFinite(parsed.tier4)
        ) {
          return parsed;
        }
      }
    } catch {}
    return DEFAULT_THRESHOLDS;
  });

  const setThresholds = (next) => {
    setThresholdsState(next);
    try {
      localStorage.setItem(THRESHOLDS_STORAGE_KEY, JSON.stringify(next));
    } catch {}
  };

  const [currentTime, setCurrentTime] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setCurrentTime(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  let pageContent;
  switch (activePage) {
    case 'Overview':
      pageContent = <OverviewPage thresholds={thresholds} />;
      break;
    case 'Patient History':
      pageContent = <PatientHistoryPage />;
      break;
    case 'Alerts':
      pageContent = <AlertsPage />;
      break;
    case 'Patient Profile':
      pageContent = <PatientProfilePage />;
      break;
    case 'Live Monitor':
      pageContent = <ComingSoonPage title="Live Monitor" icon={icons.activity} />;
      break;
    case 'Reports':
      pageContent = <ReportsPage />;
      break;
    case 'Settings':
      pageContent = <SettingsPage thresholds={thresholds} setThresholds={setThresholds} />;
      break;
    default:
      pageContent = <OverviewPage />;
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        html, body, #root { margin: 0; padding: 0; width: 100%; min-height: 100vh; background: ${T.page}; }
        .chyme-root {
          font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        .chyme-root ::-webkit-scrollbar { width: 8px; }
        .chyme-root ::-webkit-scrollbar-track { background: transparent; }
        .chyme-root ::-webkit-scrollbar-thumb { background: ${T.hairline}; border-radius: 4px; }
        .chyme-root ::-webkit-scrollbar-thumb:hover { background: ${T.textFaint}; }

        @keyframes chyme-pulse-border {
          0%, 100% { box-shadow: 0 0 0 3px rgba(197, 48, 48, 1.0); }
          50%      { box-shadow: 0 0 0 3px rgba(197, 48, 48, 0.8); }
        }
        .chyme-pulse-border { animation: chyme-pulse-border 2s ease-in-out infinite; }

        @keyframes chyme-spin {
          to { transform: rotate(360deg); }
        }
        .chyme-spin { animation: chyme-spin 1s linear infinite; }

        @keyframes chyme-overlay-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .chyme-overlay { animation: chyme-overlay-in 200ms ease-out; }
      `}</style>

      <div
        className="chyme-root"
        style={{
          display: 'flex',
          minHeight: '100vh',
          background: T.page,
          width: '100%',
          color: T.textDeep,
        }}
      >
        <Sidebar activePage={activePage} setActivePage={setActivePage} />

        <main style={{
          flex: 1,
          padding: '28px 32px',
          overflow: 'auto',
          minWidth: 0,
        }}>
          <TopGreeting currentTime={currentTime} />
          {pageContent}
        </main>
      </div>
    </>
  );
}