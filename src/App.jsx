import React, { useState, useEffect, useMemo, useRef } from 'react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

// ============================================================
// SIMULATED DATA. Replace with real wearable data later.
// ============================================================

// Inter-swallow gap distribution during waking hours.
// Targets ~300-350 waking swallows/day, with rare 420s+ gaps driving SOS events.
function randomWakingGapMs() {
  const r = Math.random();
  if (r < 0.25) return 30000 + Math.random() * 30000;     // 30–60s   (25%)
  if (r < 0.50) return 60000 + Math.random() * 60000;     // 60–120s  (25%)
  if (r < 0.72) return 120000 + Math.random() * 120000;   // 120–240s (22%)
  if (r < 0.9988) return 240000 + Math.random() * 180000; // 240–420s (27.9%)
  return 420000 + Math.random() * 180000;                 // 420–600s (0.12%) SOS
}

// Overnight (11pm–7am). Natural physiology: saliva swallows still occur,
// but sparsely. ~6–10 per 8h sleep period.
function randomSleepGapMs() {
  return 2700000 + Math.random() * 2700000; // 45–90 min
}

function isSleepHour(hour) {
  return hour >= 23 || hour < 7;
}

function generateSwallowsForDay(dayOffset = 0) {
  const swallows = [];
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setDate(dayStart.getDate() - dayOffset);
  dayStart.setHours(0, 0, 0, 0);

  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const endTime = dayOffset === 0 ? Math.min(now.getTime(), dayEnd.getTime()) : dayEnd.getTime();

  // Subtle 90-day trend: gentle improvement in the most recent days.
  // dayOffset 0 (today) -> factor 1.0 (baseline).
  // dayOffset 89 (~90 days ago) -> factor 0.88 (gaps ~14% longer, fewer swallows).
  const trendFactor = 1 - Math.min(dayOffset, 89) / 90 * 0.12;
  const gapMultiplier = 1 / trendFactor;

  let t = dayStart.getTime();
  while (t < endTime) {
    swallows.push(new Date(t));
    const hour = new Date(t).getHours();
    const rawGap = isSleepHour(hour) ? randomSleepGapMs() : randomWakingGapMs();
    t += rawGap * gapMultiplier;
  }
  return swallows;
}

const NUDGE_THRESHOLD_MS = 60000;
const SOS_THRESHOLD_MS = 420000;

function generateNudges(swallows) {
  const nudges = [];
  for (let i = 1; i < swallows.length; i++) {
    const gap = swallows[i].getTime() - swallows[i - 1].getTime();
    if (gap <= NUDGE_THRESHOLD_MS) continue;
    const nudgeTime = new Date(swallows[i - 1].getTime() + NUDGE_THRESHOLD_MS + Math.random() * 5000);
    if (isSleepHour(nudgeTime.getHours())) continue;
    if (Math.random() < 0.05) nudges.push(nudgeTime);
  }
  return nudges;
}

// SOS events: the device fires one whenever a waking gap crosses the 420s
// threshold. Returns the timestamp at which the SOS would have triggered.
function generateSOSEvents(swallows) {
  const events = [];
  for (let i = 1; i < swallows.length; i++) {
    const gap = swallows[i].getTime() - swallows[i - 1].getTime();
    if (gap < SOS_THRESHOLD_MS) continue;
    const t = new Date(swallows[i - 1].getTime() + SOS_THRESHOLD_MS);
    if (isSleepHour(t.getHours())) continue;
    events.push(t);
  }
  return events;
}

// 90 days, ordered oldest-to-newest (index 0 = 89 days ago, index 89 = today)
const ninetyDayDetailedHistory = Array.from({ length: 90 }, (_, i) => {
  const d = 89 - i;
  const sws = generateSwallowsForDay(d);
  const nudges = generateNudges(sws);
  const sosEvents = generateSOSEvents(sws);
  const date = new Date();
  date.setDate(date.getDate() - d);
  return { date, swallows: sws, nudges, sosEvents };
});

// Existing 30-day and 7-day slices (most recent)
const thirtyDayDetailedHistory = ninetyDayDetailedHistory.slice(-30);
const sevenDayDetailedHistory = ninetyDayDetailedHistory.slice(-7);

const todaySwallows = sevenDayDetailedHistory[6].swallows;
const yesterdaySwallows = sevenDayDetailedHistory[5].swallows;
const todayNudges = sevenDayDetailedHistory[6].nudges;
const todaySosEvents = sevenDayDetailedHistory[6].sosEvents;
const yesterdayNudges = sevenDayDetailedHistory[5].nudges;
const yesterdaySosEvents = sevenDayDetailedHistory[5].sosEvents;

const sevenDayHistory = sevenDayDetailedHistory.map((d) => ({
  date: d.date,
  swallows: d.swallows.length,
  nudges: d.nudges.length,
}));

const sevenDayAverage = Math.round(
  sevenDayHistory.reduce((sum, d) => sum + d.swallows, 0) / 7
);

// Average across the 6 days BEFORE today, used for "X% above/below" comparisons
const weekAverageExToday = Math.round(
  sevenDayHistory.slice(0, 6).reduce((sum, d) => sum + d.swallows, 0) / 6
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
// Tier counts reflect device-delivered events.
// - Tier 1 = gentle cues actually delivered (nudges)
// - Tier 2/3 = delivered nudges whose surrounding gap continued past 120s/240s
// - Tier 4 = SOS events (device-fired extended-inactivity alerts)
const reportMetrics = (() => {
  let gentleCues = 0;
  let tier2 = 0, tier3 = 0, tier4 = 0;
  for (const day of thirtyDayDetailedHistory) {
    gentleCues += day.nudges.length;
    tier4 += day.sosEvents.length;
    for (const nudge of day.nudges) {
      let before = null, after = null;
      for (const s of day.swallows) {
        if (s <= nudge) before = s;
        else { after = s; break; }
      }
      if (before && after) {
        const gapSec = (after.getTime() - before.getTime()) / 1000;
        if (gapSec >= 120) tier2++;
        if (gapSec >= 240) tier3++;
      }
    }
  }
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

const DEFAULT_THRESHOLDS = { tier1: 50, tier2: 80, tier3: 110, tier4: 110 };
const THRESHOLDS_STORAGE_KEY = 'chyme.thresholds';
const CAREGIVER_PHONE_KEY = 'chyme_caregiver_phone';

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
        padding: '0 14px 24px',
        display: 'flex',
        justifyContent: 'flex-start',
        alignItems: 'center',
        gap: '12px',
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
                justifyContent: 'flex-start',
                alignItems: 'center',
                textAlign: 'left',
                gap: '12px',
                transition: 'background 0.15s ease',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{item.icon}</span>
              <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
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
      <div style={{ textAlign: 'left' }}>
        <div style={{
          fontSize: '24px',
          fontWeight: 700,
          color: T.textDeep,
          lineHeight: 1.2,
          margin: 0,
          padding: 0,
          textAlign: 'left',
        }}>
          Welcome back, Maria
        </div>
        <div style={{
          fontSize: '14px',
          color: T.textMuted,
          marginTop: '4px',
          lineHeight: 1.2,
          padding: 0,
          marginLeft: 0,
          textAlign: 'left',
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
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
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

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        flex: 1,
      }}>
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
          <div style={{
            minHeight: '22px',
            marginTop: delta ? '10px' : '0',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            {delta && (
              <>
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
              </>
            )}
          </div>
        </div>
        {sparkline && (
          <div style={{
            width: '90px',
            height: '44px',
            flexShrink: 0,
            alignSelf: 'center',
          }}>
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
// CIRCULAR COUNTDOWN: PROMINENT HERO CARD
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
  const radius = 58;
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
      <div style={{ position: 'relative', width: '144px', height: '144px', flexShrink: 0 }}>
        <svg width="144" height="144" viewBox="0 0 144 144">
          {/* Decorative outer dashed ring */}
          <circle
            cx="72"
            cy="72"
            r={radius + 10}
            fill="none"
            stroke={ringColor}
            strokeWidth="1"
            strokeDasharray="2 5"
            opacity="0.3"
          />
          {/* White inner background */}
          <circle cx="72" cy="72" r={radius} fill={T.canvas} />
          {/* Background track */}
          <circle
            cx="72"
            cy="72"
            r={radius}
            fill="none"
            stroke={`${ringColor}20`}
            strokeWidth="5"
          />
          {/* Progress */}
          <circle
            cx="72"
            cy="72"
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 72 72)"
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
            fontSize: '38px',
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
            marginTop: '5px',
            color: T.textMuted,
            fontWeight: 600,
          }}>
            seconds
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          display: 'inline-flex',
          alignSelf: 'flex-start',
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

function SOSOverlay({ secondsSince, onDismiss }) {
  const minutes = Math.floor(secondsSince / 60);
  const seconds = secondsSince % 60;

  // State machine: 'idle' | 'noPhone' | 'pending' | 'success' | 'failure' | 'fake911'
  const [status, setStatus] = useState('idle');
  const [errorMsg, setErrorMsg] = useState(null);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Auto-dismiss the whole overlay after a hang-time on success or fake 911
  useEffect(() => {
    if (status !== 'success' && status !== 'fake911') return;
    const t = setTimeout(() => { onDismiss(); }, 3000);
    return () => clearTimeout(t);
  }, [status, onDismiss]);

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

  const readPhone = () => {
    try { return localStorage.getItem(CAREGIVER_PHONE_KEY) || '+17655329594'; }
    catch { return '+17655329594'; }
  };

  const handleCaregiver = async (e) => {
    e.stopPropagation();
    const phone = readPhone();
    if (!phone) {
      setStatus('noPhone');
      return;
    }
    setErrorMsg(null);
    setStatus('pending');
    try {
      const res = await fetch('/api/trigger-sos-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone }),
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        let detail = `Request failed with status ${res.status}.`;
        try {
          const data = await res.json();
          detail = data.error || detail;
        } catch {}
        setErrorMsg(detail);
        setStatus('failure');
        return;
      }
      setStatus('success');
    } catch (err) {
      if (!mountedRef.current) return;
      setErrorMsg((err && err.message) || 'Network error reaching the server.');
      setStatus('failure');
    }
  };

  const handle911 = (e) => {
    e.stopPropagation();
    setStatus('fake911');
  };

  const handleDismissError = (e) => {
    e.stopPropagation();
    setStatus('idle');
    setErrorMsg(null);
  };

  const handleDismissNoPhone = (e) => {
    e.stopPropagation();
    onDismiss();
  };

  const secondaryButtonStyle = {
    padding: '12px 22px',
    borderRadius: '10px',
    border: `1px solid ${T.tier4}55`,
    background: 'transparent',
    color: T.tier4,
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };

  const primaryButtonStyle = {
    padding: '12px 22px',
    borderRadius: '10px',
    border: 'none',
    background: T.tier4,
    color: '#fff',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };

  let content;
  if (status === 'pending' || status === 'fake911') {
    const headline = status === 'fake911' ? 'Calling 911…' : 'Calling caregiver…';
    content = (
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
          {headline}
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
        {status === 'fake911' && (
          <div style={{ fontSize: '12px', color: T.textFaint, marginTop: '22px' }}>
            This dialog will close automatically.
          </div>
        )}
      </div>
    );
  } else if (status === 'success') {
    content = (
      <div style={{ textAlign: 'center', padding: '24px 0' }}>
        <div style={{
          fontSize: '11px',
          color: T.success,
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          fontWeight: 700,
          marginBottom: '14px',
        }}>
          Request sent
        </div>
        <div style={{
          fontSize: '26px',
          fontWeight: 700,
          color: T.textDeep,
          letterSpacing: '-0.01em',
          marginBottom: '10px',
        }}>
          Call initiated. Hang tight.
        </div>
        <div style={{ fontSize: '12px', color: T.textFaint, marginTop: '18px' }}>
          This dialog will close automatically.
        </div>
      </div>
    );
  } else if (status === 'noPhone') {
    content = (
      <>
        <div style={{
          fontSize: '22px',
          fontWeight: 700,
          color: T.textDeep,
          letterSpacing: '-0.01em',
          marginBottom: '10px',
        }}>
          No caregiver phone set.
        </div>
        <div style={{
          fontSize: '14px',
          color: T.textMuted,
          lineHeight: 1.5,
          marginBottom: '24px',
        }}>
          Please add a number in Settings.
        </div>
        <button onClick={handleDismissNoPhone} style={primaryButtonStyle}>
          OK
        </button>
      </>
    );
  } else if (status === 'failure') {
    content = (
      <>
        <div style={{
          fontSize: '22px',
          fontWeight: 700,
          color: T.textDeep,
          letterSpacing: '-0.01em',
          marginBottom: '10px',
        }}>
          Call failed. Please try again or call manually.
        </div>
        {errorMsg && (
          <div style={{
            fontSize: '12px',
            color: T.textFaint,
            lineHeight: 1.5,
            marginBottom: '22px',
            wordBreak: 'break-word',
          }}>
            {errorMsg}
          </div>
        )}
        <button onClick={handleDismissError} style={secondaryButtonStyle}>
          Close
        </button>
      </>
    );
  } else {
    // idle — main emergency screen
    content = (
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
            onClick={handleCaregiver}
            onMouseEnter={(e) => { e.currentTarget.style.background = T.tier4Dark; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = T.tier4; }}
            style={buttonStyle}
          >
            {callIcon}
            <div>
              <div style={{ fontSize: '16px', fontWeight: 700 }}>Call caregiver</div>
              <div style={{ fontSize: '13px', fontWeight: 500, opacity: 0.9, marginTop: '2px' }}>
                Contact the saved caregiver number
              </div>
            </div>
          </button>

          <button
            onClick={handle911}
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
    );
  }

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
        {content}
      </div>
    </div>
  );
}

// ============================================================
// 24-HOUR TIMELINE CHART
// ============================================================

function formatHourLabel(date) {
  const h = date.getHours();
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

// Deterministic jitter. Same dot gets the same vertical offset every render.
function swallowJitter(ms) {
  const x = Math.sin(ms * 0.00017) * 43758.5453;
  return ((x - Math.floor(x)) - 0.5) * 36; // ±18px
}

function TimelineLegend() {
  const Marker = ({ shape, color }) => {
    if (shape === 'dot') {
      return <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: color }} />;
    }
    if (shape === 'diamond') {
      return <div style={{ width: '9px', height: '9px', background: color, transform: 'rotate(45deg)' }} />;
    }
    return (
      <div style={{
        width: '11px', height: '11px', background: color,
        border: '1.5px solid #fff', borderRadius: '2px',
        boxShadow: `0 0 0 1px ${T.hairline}`,
      }} />
    );
  };
  return (
    <div style={{
      display: 'flex',
      gap: '14px',
      fontSize: '12px',
      color: T.textBody,
      alignItems: 'center',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Marker shape="dot" color={T.tealPrimary} />
        <span>Swallows</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Marker shape="diamond" color={T.coral} />
        <span>Nudges</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Marker shape="square" color={T.tier4} />
        <span>SOS</span>
      </div>
    </div>
  );
}

function TimelineTooltip({ hovered }) {
  if (!hovered) return null;
  const timeStr = formatTime(hovered.time);
  let text;
  if (hovered.type === 'density') {
    const r = hovered.rate;
    text = `${timeStr}: approximately ${r} swallow${r === 1 ? '' : 's'} per hour`;
  } else if (hovered.type === 'nudge') {
    text = hovered.gap != null
      ? `Haptic nudge delivered · ${timeStr} · ${hovered.gap}s gap`
      : `Haptic nudge delivered · ${timeStr}`;
  } else {
    text = hovered.gap != null
      ? `SOS triggered · ${timeStr} · ${hovered.gap}s without swallow`
      : `SOS triggered · ${timeStr}`;
  }

  const below = hovered.placement === 'below';

  const wrapperStyle = below
    ? {
        position: 'absolute',
        left: `${hovered.xPercent}%`,
        top: `${hovered.yPx + 12}px`,
        transform: 'translateX(-50%)',
        pointerEvents: 'none',
        zIndex: 100,
      }
    : {
        position: 'absolute',
        left: `${hovered.xPercent}%`,
        top: `${hovered.yPx - 14}px`,
        transform: 'translate(-50%, -100%)',
        pointerEvents: 'none',
        zIndex: 100,
      };

  return (
    <div style={wrapperStyle}>
      {below && (
        <div style={{
          position: 'absolute',
          left: '50%',
          top: '-5px',
          transform: 'translateX(-50%)',
          width: 0, height: 0,
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          borderBottom: `5px solid ${T.textDeep}`,
        }} />
      )}
      <div style={{
        background: T.textDeep,
        color: '#fff',
        padding: '7px 11px',
        borderRadius: '6px',
        fontSize: '11.5px',
        fontWeight: 500,
        whiteSpace: 'nowrap',
        letterSpacing: '0.01em',
        boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
      }}>
        {text}
      </div>
      {!below && (
        <div style={{
          position: 'absolute',
          left: '50%',
          bottom: '-5px',
          transform: 'translateX(-50%)',
          width: 0, height: 0,
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          borderTop: `5px solid ${T.textDeep}`,
        }} />
      )}
    </div>
  );
}

// Catmull-Rom → cubic Bezier smoothing for a sequence of (x,y) points
function smoothLinePath(points) {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0][0]},${points[0][1]}`;
  let d = `M ${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2[0]},${p2[1]}`;
  }
  return d;
}

function Timeline24h({ swallows, nudges, sosEvents, todayCount, weekAverage }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  const [hovered, setHovered] = useState(null);

  const windowMs = 24 * 60 * 60 * 1000;
  const windowStart = new Date(now.getTime() - windowMs);
  const positionFor = (date) => Math.max(0, Math.min(100, ((date - windowStart) / windowMs) * 100));

  const visibleNudges = nudges.filter((n) => n >= windowStart && n <= now);
  const visibleSos = sosEvents.filter((s) => s >= windowStart && s <= now);

  // Hourly bins. Each bucket count IS the swallows/hour rate.
  const N_BUCKETS = 24;
  const bucketMs = windowMs / N_BUCKETS;
  const buckets = new Array(N_BUCKETS).fill(0);
  for (const s of swallows) {
    if (s < windowStart || s > now) continue;
    const idx = Math.min(N_BUCKETS - 1, Math.floor((s - windowStart) / bucketMs));
    buckets[idx]++;
  }
  const maxRate = Math.max(...buckets, 10);

  // Device-event gap lookup
  const allSwallowsSorted = [...swallows].sort((a, b) => a - b);
  const findGap = (eventTime) => {
    let before = null, after = null;
    for (const s of allSwallowsSorted) {
      if (s < eventTime) before = s;
      else { after = s; break; }
    }
    if (before && after) return Math.round((after - before) / 1000);
    return null;
  };

  // Axis: 9 labels, every 3 hours, last one is "Now"
  const axisLabels = Array.from({ length: 9 }, (_, i) => {
    const hoursBack = (8 - i) * 3;
    const t = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
    return {
      xPercent: (i / 8) * 100,
      label: i === 8 ? 'Now' : formatHourLabel(t),
    };
  });
  const gridPositions = axisLabels.map((a) => a.xPercent);

  // Comparison
  let comparisonText, comparisonColor;
  if (weekAverage > 0 && todayCount > 0) {
    const pct = Math.round(((todayCount - weekAverage) / weekAverage) * 100);
    if (pct > 1) {
      comparisonText = `${pct}% above your 7-day average`;
      comparisonColor = T.tealPrimary;
    } else if (pct < -1) {
      comparisonText = `${Math.abs(pct)}% below your 7-day average`;
      comparisonColor = T.coral;
    } else {
      comparisonText = 'On par with your 7-day average';
      comparisonColor = T.textMuted;
    }
  } else {
    comparisonText = 'Building today\'s baseline';
    comparisonColor = T.textMuted;
  }

  // Chart geometry
  const CHART_HEIGHT = 180;      // total chart container
  const TOP_STRIP_H = 26;         // strip for nudge/SOS markers
  const PLOT_H = CHART_HEIGHT - TOP_STRIP_H;
  const PLOT_PADDING_TOP = 10;
  const SVG_W = 1000;             // SVG viewBox width for path math
  const SVG_H = PLOT_H;

  const points = buckets.map((count, i) => {
    const x = ((i + 0.5) / N_BUCKETS) * SVG_W;
    const usableH = SVG_H - PLOT_PADDING_TOP;
    const y = SVG_H - (count / maxRate) * usableH;
    return [x, y];
  });

  const linePath = smoothLinePath(points);
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1][0]},${SVG_H} L ${points[0][0]},${SVG_H} Z`
    : '';

  const handleDensityMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPxLocal = e.clientY - rect.top;
    const clampedX = Math.max(0, Math.min(rect.width, xPx));
    const xPercent = (clampedX / rect.width) * 100;
    const timeMs = windowStart.getTime() + (clampedX / rect.width) * windowMs;
    const time = new Date(timeMs);
    const idx = Math.min(N_BUCKETS - 1, Math.max(0, Math.floor((timeMs - windowStart.getTime()) / bucketMs)));
    const rate = buckets[idx];
    // Mouse Y in chart-container coords; clamp so tooltip never overlaps the top marker strip
    const mouseChartY = yPxLocal + TOP_STRIP_H;
    const MIN_TOOLTIP_ANCHOR = TOP_STRIP_H + 54;
    const tooltipY = Math.max(MIN_TOOLTIP_ANCHOR, mouseChartY);
    setHovered({
      type: 'density',
      time,
      rate,
      xPercent,
      yPx: tooltipY,
    });
  };

  return (
    <div style={{
      background: T.canvas,
      borderRadius: '16px',
      padding: '22px 24px',
      border: `1px solid ${T.hairline}`,
    }}>
      {/* Header: title + comparison + legend */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <IconBadge color={T.tealPrimary} bg={T.tealWash}>{icons.activity}</IconBadge>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep }}>
              Swallow activity
            </div>
            <div style={{
              fontSize: '12px',
              color: comparisonColor,
              marginTop: '3px',
              fontWeight: 500,
            }}>
              {comparisonText}
            </div>
          </div>
        </div>
        <TimelineLegend />
      </div>

      {/* Chart container */}
      <div style={{
        position: 'relative',
        height: `${CHART_HEIGHT}px`,
        marginTop: '22px',
        background: '#FAFAF7',
        borderRadius: '10px',
        border: `1px solid ${T.hairlineSoft}`,
      }}>
        {/* Gridlines */}
        {gridPositions.map((p, i) => (
          <div key={`g-${i}`} style={{
            position: 'absolute',
            left: `${p}%`,
            top: 0, bottom: 0,
            width: '1px',
            background: 'rgba(0,0,0,0.035)',
          }} />
        ))}

        {/* Top-strip separator */}
        <div style={{
          position: 'absolute',
          left: 0, right: 0,
          top: `${TOP_STRIP_H}px`,
          height: '1px',
          background: 'rgba(0,0,0,0.04)',
        }} />

        {/* Density area + line (SVG) */}
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          preserveAspectRatio="none"
          style={{
            position: 'absolute',
            left: 0, right: 0,
            top: `${TOP_STRIP_H}px`,
            width: '100%',
            height: `${PLOT_H}px`,
            pointerEvents: 'none',
          }}
        >
          {areaPath && (
            <path d={areaPath} fill="#9FE1CB" fillOpacity="0.4" />
          )}
          {points.length > 0 && (
            <path
              d={linePath}
              fill="none"
              stroke="#1D9E75"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {/* Density hover layer, sits over the area, below markers */}
        <div
          onMouseMove={handleDensityMove}
          onMouseLeave={() => setHovered(null)}
          style={{
            position: 'absolute',
            top: `${TOP_STRIP_H}px`,
            left: 0, right: 0, bottom: 0,
            cursor: 'crosshair',
            zIndex: 1,
          }}
        />

        {/* Crosshair on density hover */}
        {hovered?.type === 'density' && (
          <div style={{
            position: 'absolute',
            left: `${hovered.xPercent}%`,
            top: `${TOP_STRIP_H}px`,
            bottom: 0,
            width: '1px',
            background: 'rgba(29, 158, 117, 0.35)',
            pointerEvents: 'none',
            zIndex: 2,
          }} />
        )}

        {/* Nudges: centered in top strip */}
        {visibleNudges.map((n, i) => {
          const cx = positionFor(n);
          return (
            <div
              key={`n-${i}`}
              onMouseEnter={() => setHovered({
                type: 'nudge',
                time: n,
                xPercent: cx,
                yPx: TOP_STRIP_H / 2,
                gap: findGap(n),
                placement: 'below',
              })}
              onMouseLeave={() => setHovered(null)}
              style={{
                position: 'absolute',
                left: `${cx}%`,
                top: `${TOP_STRIP_H / 2}px`,
                transform: 'translate(-50%, -50%) rotate(45deg)',
                width: '10px',
                height: '10px',
                background: T.coral,
                cursor: 'pointer',
                zIndex: 3,
                boxShadow: '0 0 0 1.5px #FAFAF7',
              }}
            />
          );
        })}

        {/* SOS: centered in top strip */}
        {visibleSos.map((s, i) => {
          const cx = positionFor(s);
          return (
            <div
              key={`sos-${i}`}
              onMouseEnter={() => setHovered({
                type: 'sos',
                time: s,
                xPercent: cx,
                yPx: TOP_STRIP_H / 2,
                gap: findGap(s),
                placement: 'below',
              })}
              onMouseLeave={() => setHovered(null)}
              style={{
                position: 'absolute',
                left: `${cx}%`,
                top: `${TOP_STRIP_H / 2}px`,
                transform: 'translate(-50%, -50%)',
                width: '14px',
                height: '14px',
                background: T.tier4,
                border: '2px solid #ffffff',
                borderRadius: '2px',
                cursor: 'pointer',
                zIndex: 4,
                boxShadow: `0 0 0 1px ${T.tier4Dark}`,
              }}
            />
          );
        })}

        <TimelineTooltip hovered={hovered} />
      </div>

      {/* X-axis labels */}
      <div style={{
        position: 'relative',
        height: '16px',
        marginTop: '10px',
        fontSize: '11px',
        color: T.textFaint,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {axisLabels.map((a, i) => (
          <div key={i} style={{
            position: 'absolute',
            left: `${a.xPercent}%`,
            transform:
              i === 0
                ? 'translateX(0)'
                : i === axisLabels.length - 1
                ? 'translateX(-100%)'
                : 'translateX(-50%)',
            whiteSpace: 'nowrap',
            fontWeight: a.label === 'Now' ? 600 : 400,
            color: a.label === 'Now' ? T.textBody : T.textFaint,
          }}>
            {a.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// OVERVIEW SUMMARY CARDS (below the timeline)
// ============================================================

function OverviewSummaryCard({ label, value, caption, captionColor }) {
  return (
    <div style={{
      padding: '16px 18px',
      background: T.canvas,
      borderRadius: '12px',
      border: `1px solid ${T.hairline}`,
    }}>
      <div style={{
        fontSize: '11px',
        fontWeight: 600,
        color: T.textMuted,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: '22px',
        fontWeight: 700,
        color: T.textDeep,
        letterSpacing: '-0.01em',
        marginTop: '8px',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      <div style={{
        fontSize: '11px',
        color: captionColor,
        marginTop: '6px',
        fontWeight: 500,
      }}>
        {caption}
      </div>
    </div>
  );
}

function OverviewSummaryRow({ todaySwallows }) {
  // Waking-only gaps: include a gap only if its starting swallow is during waking hours.
  const wakingGaps = [];
  for (let i = 1; i < todaySwallows.length; i++) {
    const prev = todaySwallows[i - 1];
    if (isSleepHour(prev.getHours())) continue;
    wakingGaps.push((todaySwallows[i].getTime() - prev.getTime()) / 1000);
  }

  const longestGapSec = wakingGaps.length ? Math.max(...wakingGaps) : 0;
  const avgGapSec = wakingGaps.length ? wakingGaps.reduce((a, b) => a + b, 0) / wakingGaps.length : 0;

  const formatGap = (sec) => {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m ${s}s`;
  };

  const longestTriggeredSos = longestGapSec >= 420;

  let avgCaption, avgColor;
  if (!wakingGaps.length) {
    avgCaption = 'No data yet';
    avgColor = T.textMuted;
  } else if (avgGapSec < 120) {
    avgCaption = 'Within healthy range';
    avgColor = T.success;
  } else if (avgGapSec <= 240) {
    avgCaption = 'Elevated';
    avgColor = T.amber;
  } else {
    avgCaption = 'Concerning';
    avgColor = T.coral;
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '14px',
      width: '100%',
    }}>
      <OverviewSummaryCard
        label="Longest gap (waking)"
        value={wakingGaps.length ? formatGap(longestGapSec) : '-'}
        caption={
          !wakingGaps.length
            ? 'No waking data yet'
            : longestTriggeredSos
            ? 'Triggered SOS'
            : 'No intervention needed'
        }
        captionColor={longestTriggeredSos ? T.tier4 : T.textMuted}
      />
      <OverviewSummaryCard
        label="Average gap (waking hours)"
        value={wakingGaps.length ? formatGap(avgGapSec) : '-'}
        caption={avgCaption}
        captionColor={avgColor}
      />
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
              <div style={{
                flex: 1,
                minWidth: 0,
                height: '32px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
              }}>
                <div style={{
                  fontSize: '13px',
                  color: T.textDeep,
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 600,
                  lineHeight: 1.15,
                }}>
                  {formatTimeWithSeconds(n)}
                </div>
                <div style={{
                  fontSize: '11px',
                  color: T.textMuted,
                  marginTop: '2px',
                  lineHeight: 1.15,
                }}>
                  Haptic cue delivered
                </div>
              </div>
              <div style={{
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                fontSize: '11px',
                color: T.textFaint,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
                lineHeight: 1.15,
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
// LIVE DEVICE TELEMETRY HOOK
// Polls /api/telemetry on Vercel (same origin) at 5Hz. UNO Q pushes
// state to that endpoint every 200ms. Also maintains a rolling history
// of the last 30 seconds of samples for the Live Monitor charts.
// ============================================================

const TELEMETRY_API = '/api/telemetry';
const POLL_INTERVAL_MS = 200;          // 5Hz polling
const HISTORY_SIZE = 180;              // 180 × 200ms = 36s rolling window

function useDeviceTelemetry() {
  const [connected, setConnected] = useState(false);
  const [telemetry, setTelemetry] = useState(null);
  const [stale, setStale] = useState(false);
  const [ageMs, setAgeMs] = useState(null);
  const [history, setHistory] = useState([]);
  const historyRef = useRef([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1000);
        const r = await fetch(TELEMETRY_API, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (cancelled) return;

        if (data.hasData) {
          const t = data.telemetry;
          setTelemetry(t);
          setConnected(!data.stale);
          setStale(!!data.stale);
          setAgeMs(data.ageMs);

          // Append to rolling history if connection is fresh
          if (!data.stale) {
            const sample = { ts: Date.now(), ...t };
            historyRef.current = [...historyRef.current, sample].slice(-HISTORY_SIZE);
            setHistory(historyRef.current);
          }
        } else {
          setConnected(false);
          setStale(false);
          setTelemetry(null);
          setAgeMs(null);
        }
      } catch (e) {
        if (cancelled) return;
        setConnected(false);
      }
    };
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return { connected, telemetry, stale, ageMs, history };
}

// Compact status chip shown at top-right of Overview when device connected
function LiveDeviceBadge({ connected, telemetry, stale, ageMs }) {
  let label, bg, color, border, dotColor;
  if (connected) {
    label = 'LIVE · ChYme device';
    bg = T.successWash; color = T.success;
    border = '#a7d9bf'; dotColor = T.success;
  } else if (stale) {
    label = `STALE · last update ${Math.round((ageMs || 0) / 1000)}s ago`;
    bg = T.amberWash; color = T.amber;
    border = '#e4c98a'; dotColor = T.amber;
  } else {
    label = 'Device offline (sim mode)';
    bg = '#f4f4f5'; color = T.textMuted;
    border = T.hairline; dotColor = T.textMuted;
  }

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 12px',
      borderRadius: '999px',
      background: bg,
      color,
      fontSize: '12px',
      fontWeight: 600,
      border: `1px solid ${border}`,
    }}>
      <span style={{
        width: '8px', height: '8px', borderRadius: '50%',
        background: dotColor,
        boxShadow: connected ? `0 0 0 3px ${dotColor}30` : 'none',
      }}/>
      {label}
      {connected && telemetry && (
        <span style={{ color: T.textMuted, fontWeight: 500, marginLeft: '4px' }}>
          · idle {telemetry.idle_s}s · {telemetry.swallow_count} swallows
        </span>
      )}
    </div>
  );
}

// Live sensor panel — shown when device is connected. Surfaces real-time
// ML classification probabilities and MPU-6050 accelerometer magnitudes.
function LiveSensorPanel({ telemetry }) {
  const probs = telemetry.probs || {};
  const classes = ['swallow', 'idle', 'cough', 'speech'];
  const classColors = {
    swallow: T.tealPrimary,
    idle:    T.textMuted,
    cough:   T.coral,
    speech:  T.amber,
  };
  const top = classes.reduce((a, b) => (probs[b] || 0) > (probs[a] || 0) ? b : a, 'idle');

  return (
    <div style={{
      background: T.canvas,
      borderRadius: '16px',
      padding: '18px 22px',
      border: `1px solid ${T.hairline}`,
      marginBottom: '16px',
      display: 'grid',
      gridTemplateColumns: '1.3fr 1fr',
      gap: '22px',
    }}>
      {/* --- LEFT: ML classification --- */}
      <div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          marginBottom: '14px',
        }}>
          <IconBadge color={T.tealPrimary} bg={T.tealWash}>{icons.activity}</IconBadge>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: T.textDeep }}>
              Live ML classification
            </div>
            <div style={{ fontSize: '12px', color: T.textMuted, marginTop: '2px' }}>
              Edge Impulse · 4-class · <span style={{ fontWeight: 600, color: classColors[top], textTransform: 'capitalize' }}>{top}</span>
            </div>
          </div>
        </div>
        {classes.map((cls) => {
          const p = probs[cls] || 0;
          return (
            <div key={cls} style={{
              display: 'grid',
              gridTemplateColumns: '72px 1fr 48px',
              alignItems: 'center',
              gap: '12px',
              padding: '4px 0',
            }}>
              <span style={{
                fontSize: '12px',
                fontWeight: 600,
                color: classColors[cls],
                textTransform: 'capitalize',
              }}>
                {cls}
              </span>
              <div style={{
                height: '8px',
                background: T.hairlineSoft,
                borderRadius: '999px',
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: `${Math.max(p * 100, 2)}%`,
                  background: classColors[cls],
                  borderRadius: '999px',
                  transition: 'width 0.4s ease-out',
                }}/>
              </div>
              <span style={{
                fontSize: '12px',
                fontWeight: 500,
                color: T.textMuted,
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right',
              }}>
                {(p * 100).toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>

      {/* --- RIGHT: MPU-6050 accelerometer values --- */}
      <div>
        <div style={{
          fontSize: '11px',
          fontWeight: 600,
          color: T.textMuted,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          marginBottom: '12px',
        }}>
          Accelerometer (RMS, g)
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <SensorReading label="Throat" value={telemetry.throat_rms} color={T.tealPrimary} />
          <SensorReading label="Sternum" value={telemetry.sternum_rms} color={T.amber} />
          <SensorReading label="T/S Ratio" value={telemetry.ratio} color={T.textDeep} dimensionless />
        </div>
      </div>
    </div>
  );
}

function SensorReading({ label, value, color, dimensionless }) {
  const v = typeof value === 'number' ? value : 0;
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      padding: '7px 10px',
      background: T.tealTint,
      borderRadius: '8px',
      borderLeft: `3px solid ${color}`,
    }}>
      <span style={{ fontSize: '12px', color: T.textMuted, fontWeight: 500 }}>{label}</span>
      <span style={{
        fontSize: '16px',
        fontWeight: 700,
        color: T.textDeep,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {v.toFixed(dimensionless ? 2 : 3)}
      </span>
    </div>
  );
}


// ============================================================
// LIVE MONITOR PAGE — in-depth real-time data visualization
// ============================================================

// Generic SVG multi-series line chart for time-series data
function MultiLineChart({
  history,
  series,              // [{key, color, label}]
  height = 200,
  yMin = 0,
  yMax = 1,
  yTicks = [0, 0.25, 0.5, 0.75, 1],
  formatY = (v) => v.toFixed(2),
  title,
  subtitle,
  windowMs = 30000,
}) {
  const now = Date.now();
  const W = 1000;  // SVG viewBox width
  const PL = 44, PR = 14, PT = 8, PB = 24;
  const innerW = W - PL - PR;
  const innerH = height - PT - PB;

  const xAt = (ts) => PL + ((ts - (now - windowMs)) / windowMs) * innerW;
  const yAt = (v) => PT + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const recent = history.filter((s) => s.ts >= now - windowMs);

  const makePath = (key) => {
    if (recent.length === 0) return '';
    let d = '';
    recent.forEach((s, i) => {
      const rawVal = key.split('.').reduce((o, k) => o?.[k], s);
      const v = typeof rawVal === 'number' ? rawVal : 0;
      const x = xAt(s.ts);
      const y = yAt(Math.max(yMin, Math.min(yMax, v)));
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
    });
    return d;
  };

  return (
    <div style={{
      background: T.canvas,
      borderRadius: '16px',
      padding: '18px 22px',
      border: `1px solid ${T.hairline}`,
    }}>
      {title && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          marginBottom: '10px',
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: T.textDeep }}>
              {title}
            </div>
            {subtitle && (
              <div style={{ fontSize: '12px', color: T.textMuted, marginTop: '2px' }}>
                {subtitle}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {series.map((s) => (
              <div key={s.key} style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '11px', color: T.textBody,
              }}>
                <div style={{
                  width: '10px', height: '3px', borderRadius: '2px',
                  background: s.color,
                }}/>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <svg viewBox={`0 0 ${W} ${height}`} width="100%" style={{ display: 'block' }}>
        {/* Y gridlines + labels */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line
              x1={PL} x2={PL + innerW}
              y1={yAt(v)} y2={yAt(v)}
              stroke={T.hairlineSoft} strokeWidth="1"
            />
            <text
              x={PL - 8} y={yAt(v) + 4}
              textAnchor="end" fontSize="10" fill={T.textMuted}
              fontFamily="ui-monospace, Consolas, monospace"
            >
              {formatY(v)}
            </text>
          </g>
        ))}
        {/* X-axis baseline */}
        <line
          x1={PL} x2={PL + innerW}
          y1={PT + innerH} y2={PT + innerH}
          stroke={T.hairline} strokeWidth="1"
        />
        {/* Time labels */}
        <text x={PL} y={height - 6} fontSize="10" fill={T.textMuted}
              fontFamily="ui-monospace, Consolas, monospace">
          -{Math.round(windowMs/1000)}s
        </text>
        <text x={PL + innerW} y={height - 6} textAnchor="end" fontSize="10" fill={T.textMuted}
              fontFamily="ui-monospace, Consolas, monospace">
          now
        </text>
        {/* Data lines */}
        {series.map((s) => (
          <path
            key={s.key}
            d={makePath(s.key)}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  );
}

// Big current-classification gauge
function ClassificationGauge({ telemetry }) {
  const probs = telemetry?.probs || {};
  const classes = ['swallow', 'idle', 'cough', 'speech'];
  const colors = {
    swallow: T.tealPrimary, idle: T.textMuted,
    cough: T.coral, speech: T.amber,
  };
  const top = classes.reduce((a, b) => (probs[b] || 0) > (probs[a] || 0) ? b : a, 'idle');
  const conf = probs[top] || 0;

  // Arc gauge
  const size = 160;
  const radius = 64;
  const cx = size / 2, cy = size / 2;
  const arcLen = Math.PI * radius;  // half circle
  const filled = arcLen * conf;

  return (
    <div style={{
      background: T.canvas, borderRadius: '16px', padding: '22px',
      border: `1px solid ${T.hairline}`,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
    }}>
      <div style={{
        fontSize: '11px', fontWeight: 700, color: T.textMuted,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        marginBottom: '10px',
      }}>
        Current classification
      </div>
      <svg width={size} height={size * 0.65} viewBox={`0 0 ${size} ${size * 0.65}`}>
        {/* Background arc */}
        <path
          d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
          fill="none" stroke={T.hairlineSoft} strokeWidth="10" strokeLinecap="round"
        />
        {/* Filled arc */}
        <path
          d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
          fill="none" stroke={colors[top]} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${filled} ${arcLen}`}
          style={{ transition: 'stroke-dasharray 0.3s ease-out, stroke 0.5s' }}
        />
        {/* Center text */}
        <text x={cx} y={cy - 8} textAnchor="middle" fontSize="13"
              fontWeight="700" fill={colors[top]}
              style={{ textTransform: 'capitalize' }}>
          {top}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize="22"
              fontWeight="800" fill={T.textDeep}
              fontFamily="ui-monospace, Consolas, monospace">
          {(conf * 100).toFixed(0)}%
        </text>
      </svg>
      <div style={{ marginTop: '12px', width: '100%' }}>
        {classes.map((cls) => (
          <div key={cls} style={{
            display: 'grid',
            gridTemplateColumns: '56px 1fr 36px',
            alignItems: 'center',
            gap: '8px',
            padding: '3px 0',
          }}>
            <span style={{
              fontSize: '11px', color: colors[cls], fontWeight: 600,
              textTransform: 'capitalize',
            }}>
              {cls}
            </span>
            <div style={{
              height: '5px', background: T.hairlineSoft, borderRadius: '999px',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${Math.max((probs[cls] || 0) * 100, 2)}%`,
                background: colors[cls],
                transition: 'width 0.3s ease-out',
              }}/>
            </div>
            <span style={{
              fontSize: '10px', color: T.textMuted,
              fontFamily: 'ui-monospace, Consolas, monospace',
              textAlign: 'right',
            }}>
              {((probs[cls] || 0) * 100).toFixed(0)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Idle countdown + next tier ETA
function IdleCountdownCard({ telemetry, thresholds }) {
  if (!telemetry) return null;
  const idle = telemetry.idle_s || 0;
  const level = telemetry.alert_level || 0;
  const tierNames = ['Normal', 'Watch', 'Attention', 'Urgent', 'SOS'];
  const tierColors = [T.success, T.amber, T.tier2, T.tier3, T.tier4];

  const nextThresh =
    idle < thresholds.tier1 ? thresholds.tier1 :
    idle < thresholds.tier2 ? thresholds.tier2 :
    idle < thresholds.tier3 ? thresholds.tier3 :
    idle < thresholds.tier4 ? thresholds.tier4 : null;
  const nextTierIdx = Math.min(level + 1, 4);
  const toNext = nextThresh ? Math.max(0, nextThresh - idle) : 0;

  return (
    <div style={{
      background: T.canvas, borderRadius: '16px', padding: '22px',
      border: `1px solid ${T.hairline}`,
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    }}>
      <div style={{
        fontSize: '11px', fontWeight: 700, color: T.textMuted,
        letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '8px',
      }}>
        Idle countdown
      </div>
      <div style={{
        fontSize: '56px', fontWeight: 800, color: tierColors[level],
        lineHeight: 1, letterSpacing: '-2px',
        fontFamily: 'ui-monospace, Consolas, monospace',
      }}>
        {idle}<span style={{ fontSize: '22px', opacity: 0.6, marginLeft: '4px' }}>s</span>
      </div>
      <div style={{
        marginTop: '6px', fontSize: '14px', fontWeight: 700,
        color: tierColors[level],
      }}>
        Tier {level} · {tierNames[level]}
      </div>
      {nextThresh && (
        <div style={{
          marginTop: '14px',
          padding: '10px 12px', borderRadius: '8px',
          background: T.tealTint,
          fontSize: '12px', color: T.textBody,
        }}>
          <div style={{ color: T.textMuted, fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Next escalation
          </div>
          <div style={{
            marginTop: '2px', fontVariantNumeric: 'tabular-nums',
            fontWeight: 600, color: T.textDeep,
          }}>
            Tier {nextTierIdx} in <span style={{ color: tierColors[nextTierIdx] }}>{toNext}s</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Status indicators card
function SystemHealthCard({ telemetry, connected, stale }) {
  if (!telemetry) {
    return (
      <div style={{
        background: T.canvas, borderRadius: '16px', padding: '22px',
        border: `1px solid ${T.hairline}`,
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: T.textMuted,
          letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '14px' }}>
          System health
        </div>
        <div style={{ fontSize: '12px', color: T.textFaint }}>
          No telemetry yet. Waiting for UNO Q to connect...
        </div>
      </div>
    );
  }

  const mpuStatus = telemetry.mpu_status || 0;
  const throatOK = (mpuStatus & 1) > 0;
  const sternumOK = (mpuStatus & 2) > 0;
  const modelOK = !!telemetry.model_loaded;

  const Row = ({ label, ok, detail }) => (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '8px 0', borderBottom: `1px solid ${T.hairlineSoft}`,
    }}>
      <span style={{ fontSize: '12px', color: T.textBody }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '11px', color: T.textMuted }}>{detail}</span>
        <div style={{
          width: '8px', height: '8px', borderRadius: '50%',
          background: ok ? T.success : T.coral,
          boxShadow: ok ? `0 0 0 3px ${T.success}25` : 'none',
        }}/>
      </div>
    </div>
  );

  return (
    <div style={{
      background: T.canvas, borderRadius: '16px', padding: '22px',
      border: `1px solid ${T.hairline}`,
    }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: T.textMuted,
        letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '10px' }}>
        System health
      </div>
      <Row label="Network link" ok={connected && !stale}
           detail={connected ? 'live' : stale ? 'stale' : 'offline'} />
      <Row label="Throat MPU (0x68)" ok={throatOK}
           detail={throatOK ? 'streaming' : 'no data'} />
      <Row label="Sternum MPU (0x69)" ok={sternumOK}
           detail={sternumOK ? 'streaming' : 'no data'} />
      <Row label="Edge Impulse model" ok={modelOK}
           detail={modelOK ? 'loaded' : 'not ready'} />
      <div style={{
        marginTop: '12px', fontSize: '11px', color: T.textMuted,
        fontFamily: 'ui-monospace, Consolas, monospace',
      }}>
        Uptime: {Math.floor((telemetry.uptime_s || 0) / 60)}m{(telemetry.uptime_s || 0) % 60}s
        · {telemetry.swallow_count || 0} swallows
      </div>
    </div>
  );
}

// Live event stream — derives events from history
function LiveEventStream({ history, maxEvents = 15 }) {
  const eventsRef = useRef([]);
  const lastLevelRef = useRef(0);
  const lastCountRef = useRef(null);

  useEffect(() => {
    if (history.length === 0) return;
    const latest = history[history.length - 1];
    const now = latest.ts;

    // Detect tier change
    const currLevel = latest.alert_level || 0;
    if (currLevel !== lastLevelRef.current) {
      if (currLevel > lastLevelRef.current) {
        eventsRef.current.unshift({
          id: `tier-${now}`, ts: now,
          type: 'alert',
          text: `Tier ${currLevel} alert fired`,
        });
      } else if (currLevel === 0) {
        eventsRef.current.unshift({
          id: `rec-${now}`, ts: now,
          type: 'recovery',
          text: 'Alert cleared — swallow detected',
        });
      }
      lastLevelRef.current = currLevel;
    }

    // Detect swallow (count increment)
    const currCount = latest.swallow_count;
    if (lastCountRef.current !== null && currCount > lastCountRef.current) {
      const p = latest.probs?.swallow || 0;
      eventsRef.current.unshift({
        id: `sw-${now}`, ts: now,
        type: 'swallow',
        text: `Swallow detected (p=${p.toFixed(2)})`,
      });
    }
    lastCountRef.current = currCount;

    // Trim
    eventsRef.current = eventsRef.current.slice(0, maxEvents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

  const events = eventsRef.current;
  const typeStyle = {
    alert:    { color: T.coral, bg: T.coralWash,    badge: 'ALERT' },
    recovery: { color: T.success, bg: T.successWash,badge: 'RECOVERY' },
    swallow:  { color: T.tealPrimary, bg: T.tealWash,badge: 'SWALLOW' },
  };

  const fmtAgo = (ts) => {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  };

  return (
    <div style={{
      background: T.canvas, borderRadius: '16px',
      border: `1px solid ${T.hairline}`,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '18px 22px 14px',
        borderBottom: `1px solid ${T.hairlineSoft}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: T.textDeep }}>
            Live event stream
          </div>
          <div style={{ fontSize: '11px', color: T.textMuted, marginTop: '2px' }}>
            Derived from UNO Q telemetry · rolling 36s window
          </div>
        </div>
        <div style={{ fontSize: '11px', color: T.textFaint }}>
          {events.length} events
        </div>
      </div>
      <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
        {events.length === 0 && (
          <div style={{
            padding: '32px 22px', textAlign: 'center',
            color: T.textFaint, fontSize: '12px',
          }}>
            Monitoring... events appear here as they happen.
          </div>
        )}
        {events.map((e) => {
          const s = typeStyle[e.type];
          return (
            <div key={e.id} style={{
              padding: '10px 22px',
              display: 'grid',
              gridTemplateColumns: '90px 1fr 80px',
              gap: '12px',
              alignItems: 'center',
              borderBottom: `1px solid ${T.hairlineSoft}`,
              fontSize: '12px',
            }}>
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em',
                padding: '3px 8px', borderRadius: '6px', textAlign: 'center',
                background: s.bg, color: s.color,
              }}>
                {s.badge}
              </span>
              <span style={{ color: T.textDeep, fontWeight: 500 }}>
                {e.text}
              </span>
              <span style={{
                fontSize: '11px', color: T.textMuted,
                fontFamily: 'ui-monospace, Consolas, monospace',
                textAlign: 'right',
              }}>
                {fmtAgo(e.ts)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LiveMonitorPage({ thresholds }) {
  const { connected, telemetry, history, stale } = useDeviceTelemetry();

  // Auto-scale the accelerometer chart based on observed values
  const maxRms = Math.max(
    1.3,
    ...history.map((s) => Math.max(s.throat_rms || 0, s.sternum_rms || 0))
  );
  const maxRatio = Math.max(
    2.0,
    ...history.map((s) => s.ratio || 0)
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '14px 20px',
        background: T.canvas,
        borderRadius: '14px', border: `1px solid ${T.hairline}`,
      }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: T.textDeep }}>
            Live Monitor
          </div>
          <div style={{ fontSize: '12px', color: T.textMuted, marginTop: '2px' }}>
            Real-time ML inference and biomechanical sensor data at 5&nbsp;Hz
          </div>
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '8px',
          padding: '6px 12px', borderRadius: '999px',
          background: connected ? T.successWash : stale ? T.amberWash : '#f4f4f5',
          color: connected ? T.success : stale ? T.amber : T.textMuted,
          border: `1px solid ${connected ? '#a7d9bf' : T.hairline}`,
          fontSize: '12px', fontWeight: 700,
          letterSpacing: '0.05em',
        }}>
          <span style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: 'currentColor',
            boxShadow: connected ? `0 0 0 3px ${T.success}30` : 'none',
          }}/>
          {connected ? 'LIVE · 5 Hz' : stale ? 'STALE' : 'OFFLINE'}
          <span style={{ color: T.textMuted, fontWeight: 500, marginLeft: '4px' }}>
            · {history.length} samples buffered
          </span>
        </div>
      </div>

      {/* Row 1 — ML classification time series, full width */}
      <MultiLineChart
        history={history}
        title="ML classification probabilities"
        subtitle="Edge Impulse · 4-class spectral model · updates every 200ms"
        height={220}
        yMin={0} yMax={1}
        yTicks={[0, 0.25, 0.5, 0.75, 1]}
        formatY={(v) => v.toFixed(2)}
        series={[
          { key: 'probs.swallow', color: T.tealPrimary, label: 'swallow' },
          { key: 'probs.idle',    color: T.textFaint,   label: 'idle' },
          { key: 'probs.cough',   color: T.coral,       label: 'cough' },
          { key: 'probs.speech',  color: T.amber,       label: 'speech' },
        ]}
      />

      {/* Row 2 — Accelerometer + Ratio side by side */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '16px',
      }}>
        <MultiLineChart
          history={history}
          title="Accelerometer RMS (g)"
          subtitle="Throat (MPU 0x68) and Sternum (MPU 0x69)"
          height={180}
          yMin={0} yMax={maxRms}
          yTicks={[0, maxRms * 0.5, maxRms].map((v) => Number(v.toFixed(2)))}
          formatY={(v) => v.toFixed(2)}
          series={[
            { key: 'throat_rms',  color: T.tealPrimary, label: 'throat' },
            { key: 'sternum_rms', color: T.amber,       label: 'sternum' },
          ]}
        />
        <MultiLineChart
          history={history}
          title="Throat / Sternum ratio"
          subtitle="Signature biomarker — spikes during swallow events"
          height={180}
          yMin={0} yMax={maxRatio}
          yTicks={[0, maxRatio * 0.5, maxRatio].map((v) => Number(v.toFixed(1)))}
          formatY={(v) => v.toFixed(1)}
          series={[
            { key: 'ratio', color: T.tier2, label: 'ratio' },
          ]}
        />
      </div>

      {/* Row 3 — Classification gauge, idle countdown, system health */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: '16px',
      }}>
        <ClassificationGauge telemetry={telemetry} />
        <IdleCountdownCard telemetry={telemetry} thresholds={thresholds} />
        <SystemHealthCard telemetry={telemetry} connected={connected} stale={stale} />
      </div>

      {/* Row 4 — Live event stream, full width */}
      <LiveEventStream history={history} />
    </div>
  );
}

// ============================================================
// OVERVIEW PAGE
// ============================================================

function OverviewPage({ thresholds }) {
  const { connected: deviceConnected, telemetry: deviceTelemetry, stale: deviceStale, ageMs: deviceAgeMs } = useDeviceTelemetry();

  // ========== ChYme voice alerts (Gemini → ElevenLabs) ==========
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('');
  const [lastSpokenText, setLastSpokenText] = useState('');
  const lastSpokenTierRef = useRef(0);
  const playingRef = useRef(false);

  const playVoiceAlert = async (tier, opts = {}) => {
    const { testMode = false } = opts;
    if (playingRef.current) return;
    playingRef.current = true;
    try {
      setVoiceStatus(testMode ? 'Testing voice...' : `Speaking Tier ${tier} alert...`);
      const res = await fetch('/api/voice-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier,
          patientName: 'Maria',
          testMode,
        }),
      });
      if (!res.ok) {
        let err;
        try { err = await res.json(); } catch { err = { error: `HTTP ${res.status}` }; }
        setVoiceStatus(`Voice failed: ${err.error || 'unknown'}`);
        setTimeout(() => setVoiceStatus(''), 4000);
        return;
      }
      const message = decodeURIComponent(res.headers.get('X-Voice-Message') || '');
      setLastSpokenText(message);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      await audio.play();
      setVoiceStatus(`Speaking: "${message}"`);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setTimeout(() => setVoiceStatus(''), 2000);
      };
    } catch (e) {
      setVoiceStatus(`Audio error: ${e.message}`);
      setTimeout(() => setVoiceStatus(''), 4000);
    } finally {
      playingRef.current = false;
    }
  };

  const enableVoice = async () => {
    // Browsers require a user gesture to unlock audio. We play a test message
    // on click so future auto-triggered alerts work.
    setVoiceEnabled(true);
    await playVoiceAlert(1, { testMode: true });
  };

  // Auto-speak when tier escalates (only if voice enabled)
  useEffect(() => {
    if (!voiceEnabled || !deviceConnected || !deviceTelemetry) return;
    const currentTier = deviceTelemetry.alert_level || 0;
    if (currentTier > lastSpokenTierRef.current && currentTier >= 1) {
      lastSpokenTierRef.current = currentTier;
      playVoiceAlert(currentTier);
    } else if (currentTier === 0) {
      lastSpokenTierRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceTelemetry?.alert_level, voiceEnabled, deviceConnected]);
  // ============================================================

  const realLastSwallow = todaySwallows[todaySwallows.length - 1] || new Date();
  const [lastSwallowOverride, setLastSwallowOverride] = useState(null);
  const lastSwallow = lastSwallowOverride || realLastSwallow;

  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // When device is connected, OVERRIDE the fake counter with real UNO Q idle_s.
  // When offline, fall back to the simulated behaviour.
  const simSecondsSince = Math.max(0, Math.floor((now - lastSwallow) / 1000));
  const secondsSince = deviceConnected && deviceTelemetry
    ? deviceTelemetry.idle_s
    : simSecondsSince;

  const tier = secondsSince >= thresholds.tier4 ? 4
             : secondsSince >= thresholds.tier3 ? 3
             : secondsSince >= thresholds.tier2 ? 2
             : secondsSince >= thresholds.tier1 ? 1
             : 0;

  const handleReset = () => setLastSwallowOverride(new Date());

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
        marginBottom: '12px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '12px',
        flexWrap: 'wrap',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          flexWrap: 'wrap',
        }}>
          <button
            onClick={voiceEnabled ? () => setVoiceEnabled(false) : enableVoice}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 14px',
              borderRadius: '999px',
              border: `1px solid ${voiceEnabled ? '#a7d9bf' : T.hairline}`,
              background: voiceEnabled ? T.successWash : T.canvas,
              color: voiceEnabled ? T.success : T.textBody,
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {voiceEnabled ? '🔊 Voice alerts ON' : '🔇 Enable voice alerts'}
          </button>
          {voiceStatus && (
            <span style={{
              fontSize: '12px',
              color: T.textMuted,
              fontStyle: 'italic',
              maxWidth: '420px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {voiceStatus}
            </span>
          )}
        </div>
        <LiveDeviceBadge
          connected={deviceConnected}
          telemetry={deviceTelemetry}
          stale={deviceStale}
          ageMs={deviceAgeMs}
        />
      </div>
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
            title={deviceConnected ? "Today · LIVE" : "Today"}
            value={deviceConnected && deviceTelemetry
              ? deviceTelemetry.swallow_count
              : todaySwallows.length}
            unit="swallows"
            delta={deviceConnected ? undefined : `${Math.abs(deltaPct)}%`}
            deltaDirection={delta >= 0 ? 'up' : 'down'}
            trend={deviceConnected ? "from device" : "vs expected"}
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

      {deviceConnected && deviceTelemetry && (
        <LiveSensorPanel telemetry={deviceTelemetry} />
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.35fr 1fr',
        gap: '16px',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 }}>
          <Timeline24h
            swallows={[...yesterdaySwallows, ...todaySwallows]}
            nudges={[...yesterdayNudges, ...todayNudges]}
            sosEvents={[...yesterdaySosEvents, ...todaySosEvents]}
            todayCount={todaySwallows.length}
            weekAverage={weekAverageExToday}
          />
          <OverviewSummaryRow todaySwallows={todaySwallows} />
        </div>
        <div style={{ position: 'relative', minWidth: 0 }}>
          <div style={{ position: 'absolute', inset: 0 }}>
            <AlertLog nudges={todayNudges} />
          </div>
        </div>
      </div>

      {tier >= 4 && (
        <SOSOverlay
          secondsSince={secondsSince}
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
      padding: '24px',
      border: `1px solid ${T.hairline}`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '14px',
      textAlign: 'center',
    }}>
      <IconBadge color={iconColor} bg={iconBg}>{icon}</IconBadge>
      <div>
        <div style={{ fontSize: '13px', color: T.textMuted, fontWeight: 500 }}>{title}</div>
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'center',
          gap: '6px',
          marginTop: '6px',
        }}>
          <div style={{
            fontSize: '26px',
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
  // Full calendar day window (00:00–24:00)
  const dayStart = new Date(day.date);
  dayStart.setHours(0, 0, 0, 0);
  const windowMs = 24 * 60 * 60 * 1000;
  const positionFor = (d) => Math.max(0, Math.min(100, ((d - dayStart) / windowMs) * 100));

  const today = new Date();
  const isToday = day.date.toDateString() === today.toDateString();

  const [hovered, setHovered] = useState(null);

  const CHART_H = 56;
  const TOP_STRIP_H = 16;
  const PLOT_H = CHART_H - TOP_STRIP_H;
  const SVG_W = 1000;
  const gridPositions = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (h / 24) * 100);
  const sosEvents = day.sosEvents || [];

  const ROW_H = CHART_H;

  // Hourly buckets for density curve
  const N_BUCKETS = 24;
  const bucketMs = windowMs / N_BUCKETS;
  const buckets = new Array(N_BUCKETS).fill(0);
  for (const s of day.swallows) {
    const idx = Math.floor((s.getTime() - dayStart.getTime()) / bucketMs);
    if (idx >= 0 && idx < N_BUCKETS) buckets[idx]++;
  }
  const maxRate = Math.max(...buckets, 3);

  const points = buckets.map((count, i) => {
    const x = ((i + 0.5) / N_BUCKETS) * SVG_W;
    const usableH = PLOT_H - 3;
    const y = PLOT_H - (count / maxRate) * usableH;
    return [x, y];
  });
  const linePath = smoothLinePath(points);
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1][0]},${PLOT_H} L ${points[0][0]},${PLOT_H} Z`
    : '';

  const allSwallowsSorted = [...day.swallows].sort((a, b) => a - b);
  const findGap = (eventTime) => {
    let before = null, after = null;
    for (const s of allSwallowsSorted) {
      if (s < eventTime) before = s;
      else { after = s; break; }
    }
    if (before && after) return Math.round((after - before) / 1000);
    return null;
  };

  const handleDensityMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPxLocal = e.clientY - rect.top;
    const clampedX = Math.max(0, Math.min(rect.width, xPx));
    const xPercent = (clampedX / rect.width) * 100;
    const timeMs = dayStart.getTime() + (clampedX / rect.width) * windowMs;
    const time = new Date(timeMs);
    const idx = Math.min(N_BUCKETS - 1, Math.max(0, Math.floor((timeMs - dayStart.getTime()) / bucketMs)));
    const rate = buckets[idx];
    setHovered({
      type: 'density',
      time,
      rate,
      xPercent,
      yPx: yPxLocal + TOP_STRIP_H,
    });
  };

  return (
    <div style={{
      background: T.canvas,
      borderRadius: '16px',
      padding: '16px 22px',
      border: `1px solid ${T.hairline}`,
      display: 'grid',
      gridTemplateColumns: '100px 1fr auto',
      columnGap: '20px',
      alignItems: 'center',
      position: 'relative',
    }}>
      <div style={{
        minHeight: `${ROW_H}px`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
      }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: T.textDeep, lineHeight: 1.15 }}>
          {isToday ? 'Today' : formatDayShort(day.date)}
        </div>
        <div style={{ fontSize: '11px', color: T.textMuted, marginTop: '3px', lineHeight: 1.15 }}>
          {day.date.toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </div>
      </div>

      <div style={{
        position: 'relative',
        height: `${CHART_H}px`,
        background: '#FAFAF7',
        borderRadius: '8px',
        border: `1px solid ${T.hairlineSoft}`,
      }}>
        {gridPositions.map((p, i) => (
          <div key={`g${i}`} style={{
            position: 'absolute',
            left: `${p}%`,
            top: 0, bottom: 0,
            width: '1px',
            background: 'rgba(0,0,0,0.03)',
          }} />
        ))}

        {/* Top strip / plot separator */}
        <div style={{
          position: 'absolute',
          left: 0, right: 0,
          top: `${TOP_STRIP_H}px`,
          height: '1px',
          background: 'rgba(0,0,0,0.04)',
        }} />

        {/* Density area + line */}
        <svg
          viewBox={`0 0 ${SVG_W} ${PLOT_H}`}
          preserveAspectRatio="none"
          style={{
            position: 'absolute',
            left: 0, right: 0,
            top: `${TOP_STRIP_H}px`,
            width: '100%',
            height: `${PLOT_H}px`,
            pointerEvents: 'none',
          }}
        >
          {areaPath && <path d={areaPath} fill="#9FE1CB" fillOpacity="0.4" />}
          {points.length > 0 && (
            <path
              d={linePath}
              fill="none"
              stroke="#1D9E75"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {/* Density hover layer */}
        <div
          onMouseMove={handleDensityMove}
          onMouseLeave={() => setHovered(null)}
          style={{
            position: 'absolute',
            top: `${TOP_STRIP_H}px`,
            left: 0, right: 0, bottom: 0,
            cursor: 'crosshair',
            zIndex: 1,
          }}
        />

        {/* Nudges at top strip */}
        {day.nudges.map((n, i) => {
          const cx = positionFor(n);
          return (
            <div
              key={`n${i}`}
              onMouseEnter={() => setHovered({
                type: 'nudge',
                time: n,
                xPercent: cx,
                yPx: TOP_STRIP_H / 2,
                gap: findGap(n),
              })}
              onMouseLeave={() => setHovered(null)}
              style={{
                position: 'absolute',
                left: `${cx}%`,
                top: `${TOP_STRIP_H / 2}px`,
                transform: 'translate(-50%, -50%) rotate(45deg)',
                width: '8px',
                height: '8px',
                background: T.coral,
                boxShadow: '0 0 0 1.5px #FAFAF7',
                zIndex: 3,
                cursor: 'pointer',
              }}
            />
          );
        })}

        {/* SOS at top strip */}
        {sosEvents.map((s, i) => {
          const cx = positionFor(s);
          return (
            <div
              key={`sos${i}`}
              onMouseEnter={() => setHovered({
                type: 'sos',
                time: s,
                xPercent: cx,
                yPx: TOP_STRIP_H / 2,
                gap: findGap(s),
              })}
              onMouseLeave={() => setHovered(null)}
              style={{
                position: 'absolute',
                left: `${cx}%`,
                top: `${TOP_STRIP_H / 2}px`,
                transform: 'translate(-50%, -50%)',
                width: '10px',
                height: '10px',
                background: T.tier4,
                border: '2px solid #ffffff',
                borderRadius: '2px',
                boxShadow: `0 0 0 1px ${T.tier4Dark}`,
                zIndex: 4,
                cursor: 'pointer',
              }}
            />
          );
        })}

        <TimelineTooltip hovered={hovered} />
      </div>

      <div style={{
        minHeight: `${ROW_H}px`,
        display: 'flex',
        alignItems: 'center',
        gap: '24px',
      }}>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontSize: '18px',
            fontWeight: 700,
            color: T.textDeep,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1.15,
          }}>
            {day.swallows.length}
          </div>
          <div style={{ fontSize: '11px', color: T.textMuted, marginTop: '3px', lineHeight: 1.15 }}>swallows</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontSize: '18px',
            fontWeight: 700,
            color: T.coral,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1.15,
          }}>
            {day.nudges.length}
          </div>
          <div style={{ fontSize: '11px', color: T.textMuted, marginTop: '3px', lineHeight: 1.15 }}>nudges</div>
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
// REPORTS PAGE, clinician-facing
// ============================================================

function DailyCountLineChart({ data, onVisibleAvgChange }) {
  const DAY_WIDTH = 22;
  const WINDOW_DAYS = 30;
  const H = 260;
  const PT = 24, PB = 40;
  const innerH = H - PT - PB;

  const chartW = data.length * DAY_WIDTH;

  const counts = data.map((d) => d.count);
  const maxRaw = Math.max(...counts, 1);
  const step = 100;
  const maxY = Math.max(step, Math.ceil((maxRaw * 1.1) / step) * step);
  const tickValues = [];
  for (let v = 0; v <= maxY; v += step) tickValues.push(v);

  const xAt = (i) => i * DAY_WIDTH + DAY_WIDTH / 2;
  const yAt = (v) => PT + innerH - (v / maxY) * innerH;

  const linePoints = data.map((d, i) => `${xAt(i)},${yAt(d.count)}`).join(' ');
  const areaPoints = `${xAt(0)},${PT + innerH} ${linePoints} ${xAt(data.length - 1)},${PT + innerH}`;

  const scrollRef = useRef(null);
  const [visible, setVisible] = useState({
    start: Math.max(0, data.length - WINDOW_DAYS),
    end: data.length,
    avg: 0,
  });
  const [hovered, setHovered] = useState(null);

  const updateVisible = () => {
    if (!scrollRef.current) return;
    const { scrollLeft, clientWidth } = scrollRef.current;
    const start = Math.max(0, Math.floor(scrollLeft / DAY_WIDTH));
    const end = Math.min(data.length, Math.ceil((scrollLeft + clientWidth) / DAY_WIDTH));
    const slice = data.slice(start, end);
    const a = slice.length ? slice.reduce((s, d) => s + d.count, 0) / slice.length : 0;
    setVisible({ start, end, avg: a });
  };

  useEffect(() => {
    if (!scrollRef.current) return;
    // default to rightmost (most recent)
    scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    updateVisible();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onVisibleAvgChange?.(visible.avg);
  }, [visible.avg, onVisibleAvgChange]);

  const scrollBy = (days) => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollBy({ left: days * DAY_WIDTH, behavior: 'smooth' });
  };

  const visibleStartX = visible.start * DAY_WIDTH;
  const visibleEndX = visible.end * DAY_WIDTH;

  const navButtonStyle = {
    width: '32px',
    flexShrink: 0,
    alignSelf: 'stretch',
    border: `1px solid ${T.hairline}`,
    background: T.canvas,
    color: T.textBody,
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: '6px' }}>
      {/* Fixed Y-axis column */}
      <svg width="44" height={H} style={{ display: 'block', flexShrink: 0, overflow: 'visible' }}>
        {tickValues.map((v, i) => (
          <text
            key={`yt-${i}`}
            x={40}
            y={yAt(v) + 4}
            textAnchor="end"
            fontSize="11"
            fill={T.textMuted}
          >
            {v}
          </text>
        ))}
      </svg>

      {/* Older button */}
      <button
        onClick={() => scrollBy(-15)}
        onMouseEnter={(e) => { e.currentTarget.style.background = T.tealTint; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = T.canvas; }}
        aria-label="Scroll to older data"
        style={navButtonStyle}
      >
        ‹
      </button>

      {/* Scrollable chart area */}
      <div
        ref={scrollRef}
        onScroll={updateVisible}
        style={{
          flex: 1,
          minWidth: 0,
          overflowX: 'auto',
          overflowY: 'hidden',
          position: 'relative',
        }}
      >
        <div style={{ position: 'relative', width: `${chartW}px`, height: `${H}px` }}>
          <svg viewBox={`0 0 ${chartW} ${H}`} width={chartW} height={H} style={{ display: 'block' }}>
            <defs>
              <linearGradient id="dailyCountArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={T.tealSoft} stopOpacity="0.32" />
                <stop offset="100%" stopColor={T.tealSoft} stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Gridlines (inside scroll area so they span full chart) */}
            {tickValues.map((v, i) => (
              <line
                key={`gl-${i}`}
                x1={0}
                x2={chartW}
                y1={yAt(v)}
                y2={yAt(v)}
                stroke={T.hairlineSoft}
                strokeWidth="1"
              />
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
              <circle
                key={i}
                cx={xAt(i)}
                cy={yAt(d.count)}
                r="3"
                fill={T.tealPrimary}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHovered({ i, date: d.date, count: d.count, x: xAt(i), y: yAt(d.count) })}
                onMouseLeave={() => setHovered(null)}
              />
            ))}

            {/* Dashed average line, only over visible window */}
            {visible.end > visible.start && (
              <line
                x1={visibleStartX}
                x2={visibleEndX}
                y1={yAt(visible.avg)}
                y2={yAt(visible.avg)}
                stroke={T.coral}
                strokeWidth="1.5"
                strokeDasharray="5 4"
              />
            )}

            {/* X-axis labels every 10 days */}
            {data.map((d, i) => {
              if (i % 10 !== 0 && i !== data.length - 1) return null;
              return (
                <text
                  key={`xl-${i}`}
                  x={xAt(i)}
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

          {/* Tooltip on hovered point */}
          {hovered && (
            <div style={{
              position: 'absolute',
              left: `${hovered.x}px`,
              top: `${hovered.y - 10}px`,
              transform: 'translate(-50%, -100%)',
              pointerEvents: 'none',
              zIndex: 10,
            }}>
              <div style={{
                background: T.textDeep,
                color: '#fff',
                padding: '7px 11px',
                borderRadius: '6px',
                fontSize: '11.5px',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                letterSpacing: '0.01em',
                boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
              }}>
                {hovered.date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}: {hovered.count} swallows
              </div>
              <div style={{
                position: 'absolute',
                left: '50%',
                bottom: '-5px',
                transform: 'translateX(-50%)',
                width: 0, height: 0,
                borderLeft: '5px solid transparent',
                borderRight: '5px solid transparent',
                borderTop: `5px solid ${T.textDeep}`,
              }} />
            </div>
          )}
        </div>
      </div>

      {/* Newer button */}
      <button
        onClick={() => scrollBy(15)}
        onMouseEnter={(e) => { e.currentTarget.style.background = T.tealTint; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = T.canvas; }}
        aria-label="Scroll to newer data"
        style={navButtonStyle}
      >
        ›
      </button>
    </div>
  );
}

function GapHistogram({ buckets }) {
  const labels = ['0–30s', '30–60s', '60–120s', '120–240s', '240s+'];
  const W = 760, H = 260;
  const PL = 44, PR = 44, PT = 24, PB = 40;
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
        textAlign: 'left',
        display: 'block',
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
    () => ninetyDayDetailedHistory.map((d) => ({ date: d.date, count: d.swallows.length })),
    []
  );
  const [visibleAvg, setVisibleAvg] = useState(0);

  const startDate = thirtyDayDetailedHistory[0].date;
  const endDate = thirtyDayDetailedHistory[thirtyDayDetailedHistory.length - 1].date;
  const generatedAt = new Date();

  const fmtShort = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

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
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '28px',
      }}>
        {/* 1. Header */}
        <div style={{ paddingBottom: '20px', borderBottom: `1px solid ${T.hairline}` }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: '16px',
          }}>
            <div style={{
              fontSize: '24px',
              fontWeight: 500,
              color: T.textDeep,
              letterSpacing: '-0.01em',
            }}>
              Swallow Activity Report
            </div>
            <div style={{ fontSize: '12px', color: T.textMuted, whiteSpace: 'nowrap' }}>
              Generated {fmtShort(generatedAt)}
            </div>
          </div>
          <div style={{ fontSize: '13px', color: T.textMuted, marginTop: '6px' }}>
            {patientName} · {patientId} · Report period {fmtShort(startDate)} – {fmtShort(endDate)}
          </div>
        </div>

        {/* 2. Line chart */}
        <div>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: '16px',
            marginBottom: '4px',
          }}>
            <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep }}>
              Daily swallow count
            </div>
            <div style={{ fontSize: '12px', color: T.textMuted, whiteSpace: 'nowrap' }}>
              30-day window average: {Math.round(visibleAvg)} swallows/day
            </div>
          </div>
          <div style={{ fontSize: '12px', color: T.textMuted, marginBottom: '14px' }}>
            Past 90 days. Scroll horizontally to see up to 90 days of history. Dashed line shows the visible window average.
          </div>
          <DailyCountLineChart data={lineData} onVisibleAvgChange={setVisibleAvg} />
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
            <BigStat label="Tier 2: caregiver attention" value={reportMetrics.tier2} color={T.tier2} />
            <BigStat label="Tier 3: urgent" value={reportMetrics.tier3} color={T.tier3} />
            <BigStat label="Tier 4: emergency SOS" value={reportMetrics.tier4} color={T.tier4} />
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
      <button
        onClick={handleDownload}
        disabled={downloading}
        onMouseEnter={(e) => { if (!downloading) e.currentTarget.style.background = '#1f5a51'; }}
        onMouseLeave={(e) => { if (!downloading) e.currentTarget.style.background = T.tealPrimary; }}
        style={{
          width: '100%',
          padding: '16px 24px',
          borderRadius: '12px',
          border: 'none',
          background: downloading ? T.textFaint : T.tealPrimary,
          color: '#fff',
          fontSize: '14px',
          fontWeight: 600,
          cursor: downloading ? 'wait' : 'pointer',
          fontFamily: 'inherit',
          letterSpacing: '0.01em',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
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
        <div style={{ fontSize: '13px', color: T.coral, textAlign: 'center' }}>{downloadError}</div>
      )}
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
      textAlign: 'left',
    }}>
      <div style={{
        flex: 1,
        minWidth: 0,
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
      }}>
        <div style={{
          fontSize: '14px',
          fontWeight: 600,
          color: T.textDeep,
          textAlign: 'left',
          width: '100%',
        }}>{label}</div>
        <div style={{
          fontSize: '12px',
          color: T.textMuted,
          marginTop: '2px',
          textAlign: 'left',
          width: '100%',
        }}>{sublabel}</div>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '720px' }}>
      <div style={{ textAlign: 'left' }}>
        <div style={{
          fontSize: '20px',
          fontWeight: 600,
          color: T.textDeep,
          letterSpacing: '-0.01em',
        }}>
          Settings
        </div>
        <div style={{ fontSize: '13px', color: T.textMuted, marginTop: '4px' }}>
          Configuration for alerts and device behavior
        </div>
      </div>

      <div style={{
        background: T.canvas,
        borderRadius: '16px',
        border: `1px solid ${T.hairline}`,
        padding: '24px',
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
              height: '40px',
              padding: '0 22px',
              borderRadius: '10px',
              border: 'none',
              background: T.tealPrimary,
              color: '#fff',
              fontSize: '13px',
              fontWeight: 600,
              cursor: isDirty ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              opacity: isDirty ? 1 : 0.5,
              transition: 'opacity 0.15s ease',
            }}
          >
            Save changes
          </button>
          <button
            onClick={handleRestore}
            style={{
              height: '40px',
              padding: '0 22px',
              borderRadius: '10px',
              border: `1px solid ${T.tealPrimary}55`,
              background: 'transparent',
              color: T.tealPrimary,
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

      <EmergencyContactSection />
    </div>
  );
}

function EmergencyContactSection() {
  const [phone, setPhone] = useState(() => {
    try {
      const stored = localStorage.getItem(CAREGIVER_PHONE_KEY);
      if (stored) return stored;
      // Default for demo — saves it so the SOS overlay can call it immediately
      const demo = '+17655329594';
      localStorage.setItem(CAREGIVER_PHONE_KEY, demo);
      return demo;
    }
    catch { return ''; }
  });
  const [status, setStatus] = useState(null);

  const E164 = /^\+[1-9]\d{7,14}$/;

  const handleSave = () => {
    const trimmed = phone.trim();
    if (trimmed && !E164.test(trimmed)) {
      setStatus({ type: 'error', message: 'Use E.164 format like "+15551234567".' });
      return;
    }
    try {
      if (trimmed) localStorage.setItem(CAREGIVER_PHONE_KEY, trimmed);
      else localStorage.removeItem(CAREGIVER_PHONE_KEY);
      setPhone(trimmed);
      setStatus({ type: 'success', message: 'Saved.' });
      setTimeout(() => setStatus(null), 2000);
    } catch {
      setStatus({ type: 'error', message: 'Could not save to this browser.' });
    }
  };

  return (
    <div style={{
      background: T.canvas,
      borderRadius: '16px',
      border: `1px solid ${T.hairline}`,
      padding: '24px',
    }}>
      <div style={{ marginBottom: '4px' }}>
        <SectionLabel>Emergency contact</SectionLabel>
      </div>
      <div style={{
        fontSize: '13px',
        color: T.textMuted,
        marginBottom: '16px',
        lineHeight: 1.5,
      }}>
        This number will be called automatically when Tier 4 SOS triggers.
        Use international format with country code.
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 0',
        borderBottom: `1px solid ${T.hairlineSoft}`,
        gap: '16px',
        textAlign: 'left',
      }}>
        <div style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
        }}>
          <div style={{
            fontSize: '14px',
            fontWeight: 600,
            color: T.textDeep,
            textAlign: 'left',
            width: '100%',
          }}>
            Caregiver phone number
          </div>
          <div style={{
            fontSize: '12px',
            color: T.textMuted,
            marginTop: '2px',
            textAlign: 'left',
            width: '100%',
          }}>
            E.164 format, e.g. +15551234567
          </div>
        </div>
        <input
          type="tel"
          value={phone}
          onChange={(e) => { setPhone(e.target.value); setStatus(null); }}
          placeholder="+15551234567"
          style={{
            width: '200px',
            padding: '9px 12px',
            borderRadius: '8px',
            border: `1px solid ${T.hairline}`,
            fontSize: '14px',
            fontFamily: 'inherit',
            color: T.textDeep,
            fontVariantNumeric: 'tabular-nums',
            background: T.canvas,
            outline: 'none',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = T.tealPrimary; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = T.hairline; }}
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
          style={{
            height: '40px',
            padding: '0 22px',
            borderRadius: '10px',
            border: 'none',
            background: T.tealPrimary,
            color: '#fff',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Save
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
      pageContent = <LiveMonitorPage thresholds={thresholds} />;
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