import React, { useState, useEffect, useMemo } from 'react';

// ============================================================
// SIMULATED DATA — replace with real wearable data later
// ============================================================

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
    const gap = 90000 + Math.random() * 150000 + (Math.random() < 0.08 ? 60000 : 0);
    t += gap;
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

const sevenDayDetailedHistory = [6, 5, 4, 3, 2, 1, 0].map((d) => {
  const sws = generateSwallowsForDay(d);
  const nudges = generateNudges(sws);
  const date = new Date();
  date.setDate(date.getDate() - d);
  return { date, swallows: sws, nudges };
});

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

  // Lines
  hairline: '#edf0ef',
  hairlineSoft: '#f4f6f5',
};

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

function CountdownHero({ lastSwallow }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsSince = Math.floor((now - lastSwallow) / 1000);

  let state, label, description, ringColor, bgGradient, textColor;
  if (secondsSince < 30) {
    state = 'normal';
    label = 'Normal rhythm';
    description = 'Swallowing at a healthy interval';
    ringColor = T.tealPrimary;
    bgGradient = `linear-gradient(135deg, ${T.tealTint} 0%, ${T.tealWash} 100%)`;
    textColor = T.textDeep;
  } else if (secondsSince < 60) {
    state = 'watch';
    label = 'Extended interval';
    description = 'Slightly longer than baseline';
    ringColor = T.amber;
    bgGradient = `linear-gradient(135deg, #fdf8ec 0%, ${T.amberWash} 100%)`;
    textColor = T.textDeep;
  } else {
    state = 'alert';
    label = 'Nudge threshold';
    description = 'Gentle haptic cue delivered';
    ringColor = T.coral;
    bgGradient = `linear-gradient(135deg, #fdf0f0 0%, ${T.coralWash} 100%)`;
    textColor = T.textDeep;
  }

  const progress = Math.min(secondsSince / 90, 1);
  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progress);

  return (
    <div style={{
      background: bgGradient,
      borderRadius: '16px',
      padding: '24px',
      border: `1px solid ${T.hairline}`,
      display: 'flex',
      alignItems: 'center',
      gap: '24px',
      transition: 'background 0.8s ease',
    }}>
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
            color: textColor,
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
          color: textColor,
          marginBottom: '12px',
          border: `1px solid ${T.hairline}`,
        }}>
          <div style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: ringColor,
            boxShadow: state === 'alert' ? `0 0 0 3px ${ringColor}33` : 'none',
          }} />
          {state === 'normal' ? 'ALL CLEAR' : state === 'watch' ? 'MONITORING' : 'ALERT'}
        </div>
        <div style={{
          fontSize: '22px',
          fontWeight: 700,
          color: textColor,
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

        <div style={{ display: 'flex', gap: '20px' }}>
          <div>
            <div style={{ fontSize: '11px', color: T.textMuted, marginBottom: '2px' }}>Threshold</div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: T.textDeep, fontVariantNumeric: 'tabular-nums' }}>60s</div>
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

function OverviewPage() {
  const lastSwallow = todaySwallows[todaySwallows.length - 1] || new Date();

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
        <CountdownHero lastSwallow={lastSwallow} />

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
// MAIN DASHBOARD
// ============================================================

export default function App() {
  const [activePage, setActivePage] = useState('Overview');

  const [currentTime, setCurrentTime] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setCurrentTime(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  let pageContent;
  switch (activePage) {
    case 'Overview':
      pageContent = <OverviewPage />;
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
      pageContent = <ComingSoonPage title="Reports" icon={icons.chart} />;
      break;
    case 'Settings':
      pageContent = <ComingSoonPage title="Settings" icon={icons.settings} />;
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