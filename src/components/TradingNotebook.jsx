import { useState, useEffect, useCallback } from 'react';

const SECTIONS = [
  { id: 'rules',      label: 'Rules',      icon: '📋', color: '#00d4aa', desc: 'Your trading rules & discipline guidelines' },
  { id: 'strategy',   label: 'Strategy',   icon: '📐', color: '#818cf8', desc: 'Strategy documentation & setups' },
  { id: 'notes',      label: 'Notes',      icon: '📝', color: '#38bdf8', desc: 'General market notes & observations' },
  { id: 'lessons',    label: 'Lessons',    icon: '🎯', color: '#f59e0b', desc: 'Lessons learned from trades' },
  { id: 'psychology', label: 'Psychology', icon: '🧠', color: '#a78bfa', desc: 'Mindset, emotions & mental notes' },
  { id: 'risk',       label: 'Risk',       icon: '⚖️', color: '#ef4444', desc: 'Risk management rules & limits' },
];

const LS_KEY = 'forex_notebook_v1';

function loadData() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}

function saveData(data) {
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtRelative(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)  return `${days}d ago`;
  return fmtDate(iso);
}

// ── Entry Editor (modal-like overlay) ────────────────────────────────────────
function EntryEditor({ entry, section, onSave, onCancel }) {
  const [title,   setTitle]   = useState(entry?.title   ?? '');
  const [content, setContent] = useState(entry?.content ?? '');
  const [tag,     setTag]     = useState(entry?.tag     ?? '');

  const isValid = content.trim().length > 0;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: 16,
    }}>
      <div style={{
        background: '#0f172a', border: `1px solid ${section.color}44`,
        borderRadius: 16, width: '100%', maxWidth: 620,
        boxShadow: `0 0 40px ${section.color}22`, padding: '20px 24px',
        display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '90vh',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>{section.icon}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#f8fafc' }}>
              {entry ? 'Edit Entry' : `New ${section.label} Entry`}
            </div>
            <div style={{ fontSize: 11, color: '#475569' }}>{section.desc}</div>
          </div>
          <button onClick={onCancel} style={{
            background: 'none', border: 'none', color: '#64748b', fontSize: 22,
            cursor: 'pointer', lineHeight: 1, padding: 4,
          }}>×</button>
        </div>

        {/* Title */}
        <input
          placeholder="Title (optional)…"
          value={title}
          onChange={e => setTitle(e.target.value)}
          style={{
            background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155',
            borderRadius: 8, padding: '10px 14px', fontSize: 14, fontWeight: 600,
            outline: 'none',
          }}
        />

        {/* Tag */}
        <input
          placeholder="Tag (e.g. ICT, Risk, Gold)…"
          value={tag}
          onChange={e => setTag(e.target.value)}
          style={{
            background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155',
            borderRadius: 8, padding: '8px 14px', fontSize: 12, outline: 'none',
          }}
        />

        {/* Content */}
        <textarea
          autoFocus
          placeholder={`Write your ${section.label.toLowerCase()} here…\n\nTips:\n• Be specific and actionable\n• Add examples where possible\n• Review and update regularly`}
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={10}
          style={{
            background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155',
            borderRadius: 8, padding: '12px 14px', fontSize: 13, lineHeight: 1.7,
            resize: 'vertical', outline: 'none', fontFamily: 'inherit',
          }}
        />

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            padding: '9px 20px', borderRadius: 8, background: '#1e293b',
            border: '1px solid #334155', color: '#94a3b8', fontSize: 13,
            cursor: 'pointer', fontWeight: 600,
          }}>Cancel</button>
          <button
            onClick={() => isValid && onSave({ title: title.trim(), content: content.trim(), tag: tag.trim() })}
            disabled={!isValid}
            style={{
              padding: '9px 24px', borderRadius: 8,
              background: isValid ? section.color : '#1e293b',
              border: 'none', color: isValid ? '#080c14' : '#475569',
              fontSize: 13, cursor: isValid ? 'pointer' : 'not-allowed', fontWeight: 700,
              transition: 'background 0.15s',
            }}
          >
            {entry ? 'Save Changes' : 'Add Entry'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Single entry card ─────────────────────────────────────────────────────────
function EntryCard({ entry, section, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const lines = entry.content.split('\n');
  const preview = lines.slice(0, 3).join('\n');
  const needsExpand = lines.length > 3 || entry.content.length > 200;

  return (
    <div style={{
      background: '#1e293b', borderRadius: 12, padding: '14px 16px',
      marginBottom: 10, borderLeft: `3px solid ${section.color}`,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {entry.title && (
            <div style={{ fontSize: 14, fontWeight: 700, color: '#f8fafc', marginBottom: 4 }}>
              {entry.title}
            </div>
          )}
          <pre style={{
            margin: 0, fontSize: 13, color: '#cbd5e1', lineHeight: 1.65,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit',
          }}>
            {expanded || !needsExpand ? entry.content : preview + (needsExpand ? '…' : '')}
          </pre>
          {needsExpand && (
            <button onClick={() => setExpanded(e => !e)} style={{
              background: 'none', border: 'none', color: section.color,
              fontSize: 11, cursor: 'pointer', padding: '4px 0', fontWeight: 600,
            }}>
              {expanded ? '▲ Show less' : '▼ Show more'}
            </button>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {entry.tag && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
            background: section.color + '22', color: section.color,
          }}>{entry.tag}</span>
        )}
        <span style={{ fontSize: 10, color: '#475569' }} title={fmtDate(entry.createdAt)}>
          {fmtRelative(entry.createdAt)}
          {entry.updatedAt !== entry.createdAt && ' · edited'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => onEdit(entry)} style={{
            background: 'none', border: '1px solid #334155', color: '#64748b',
            fontSize: 11, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
          }}>Edit</button>
          <button onClick={() => onDelete(entry.id)} style={{
            background: 'none', border: '1px solid #334155', color: '#ef444477',
            fontSize: 11, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
          }}>Del</button>
        </div>
      </div>
    </div>
  );
}

// ── Section view ──────────────────────────────────────────────────────────────
function SectionView({ section, entries, onAdd, onEdit, onDelete, search }) {
  const filtered = entries.filter(e => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return e.title?.toLowerCase().includes(q) ||
      e.content.toLowerCase().includes(q) ||
      e.tag?.toLowerCase().includes(q);
  });

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 80px 0' }}>
      {/* Section header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        paddingBottom: 14, borderBottom: '1px solid #1e293b',
      }}>
        <span style={{ fontSize: 28 }}>{section.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#f8fafc' }}>{section.label}</div>
          <div style={{ fontSize: 11, color: '#475569' }}>{section.desc}</div>
        </div>
        <span style={{ fontSize: 12, color: '#475569' }}>{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
        <button onClick={onAdd} style={{
          padding: '8px 18px', borderRadius: 8, background: section.color,
          border: 'none', color: '#080c14', fontSize: 12, fontWeight: 700,
          cursor: 'pointer',
        }}>+ New</button>
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '50px 20px', color: '#475569' }}>
          {search.trim() ? (
            <>
              <div style={{ fontSize: 28, marginBottom: 10 }}>🔍</div>
              <div style={{ fontSize: 13 }}>No entries match "{search}"</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 36, marginBottom: 12 }}>{section.icon}</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#64748b', marginBottom: 6 }}>
                No {section.label.toLowerCase()} yet
              </div>
              <div style={{ fontSize: 12, color: '#334155', marginBottom: 18 }}>{section.desc}</div>
              <button onClick={onAdd} style={{
                padding: '10px 24px', borderRadius: 8, background: section.color,
                border: 'none', color: '#080c14', fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}>Write your first entry</button>
            </>
          )}
        </div>
      ) : (
        filtered.map(entry => (
          <EntryCard key={entry.id} entry={entry} section={section} onEdit={onEdit} onDelete={onDelete} />
        ))
      )}
    </div>
  );
}

// ── Stats overview ────────────────────────────────────────────────────────────
function OverviewGrid({ data, onSelectSection }) {
  const totalEntries = Object.values(data).flat().length;
  const lastEdited = Object.values(data).flat()
    .map(e => new Date(e.updatedAt || e.createdAt))
    .sort((a, b) => b - a)[0];

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: '#f8fafc' }}>Trading Notebook</div>
        <div style={{ fontSize: 12, color: '#475569', marginTop: 3 }}>
          {totalEntries} total entries
          {lastEdited && ` · last updated ${fmtRelative(lastEdited.toISOString())}`}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {SECTIONS.map(section => {
          const entries = data[section.id] || [];
          const last = entries[entries.length - 1];
          return (
            <div
              key={section.id}
              onClick={() => onSelectSection(section.id)}
              style={{
                background: '#1e293b', borderRadius: 12, padding: '14px 16px',
                cursor: 'pointer', borderTop: `3px solid ${section.color}`,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#253347'}
              onMouseLeave={e => e.currentTarget.style.background = '#1e293b'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 20 }}>{section.icon}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc' }}>{section.label}</span>
              </div>
              <div style={{ fontSize: 26, fontWeight: 900, color: entries.length > 0 ? section.color : '#334155' }}>
                {entries.length}
              </div>
              <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>
                {entries.length === 0
                  ? 'No entries yet'
                  : last ? `Last: ${fmtRelative(last.updatedAt || last.createdAt)}` : ''}
              </div>
            </div>
          );
        })}
      </div>

      {/* Quick tips */}
      <div style={{ marginTop: 20, background: '#1e293b', borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 10 }}>
          💡 Quick Tips
        </div>
        {[
          ['📋 Rules', 'Write 1 rule per entry. Keep them short and actionable.'],
          ['📐 Strategy', 'Document your exact setup criteria and entry triggers.'],
          ['🎯 Lessons', 'Review after every losing trade — what went wrong?'],
          ['🧠 Psychology', 'Track emotions before, during and after sessions.'],
        ].map(([t, d]) => (
          <div key={t} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #0f172a' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#e2e8f0' }}>{t}</span>
            <span style={{ fontSize: 11, color: '#475569' }}> — {d}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function TradingNotebook() {
  const [data,       setData]       = useState(loadData);
  const [activeId,   setActiveId]   = useState(null); // null = overview
  const [editing,    setEditing]    = useState(null);  // entry being edited or 'new'
  const [search,     setSearch]     = useState('');
  const [confirmDel, setConfirmDel] = useState(null);  // id to delete

  const activeSection = SECTIONS.find(s => s.id === activeId);
  const entries = activeId ? (data[activeId] || []) : [];

  const persist = useCallback((next) => {
    setData(next);
    saveData(next);
  }, []);

  const handleSave = useCallback(({ title, content, tag }) => {
    const now = new Date().toISOString();
    const next = { ...data };
    if (!next[activeId]) next[activeId] = [];

    if (editing && editing !== 'new') {
      next[activeId] = next[activeId].map(e =>
        e.id === editing.id ? { ...e, title, content, tag, updatedAt: now } : e
      );
    } else {
      next[activeId] = [
        ...next[activeId],
        { id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`, title, content, tag, createdAt: now, updatedAt: now },
      ];
    }
    persist(next);
    setEditing(null);
  }, [data, activeId, editing, persist]);

  const handleDelete = useCallback((id) => {
    const next = { ...data };
    next[activeId] = (next[activeId] || []).filter(e => e.id !== id);
    persist(next);
    setConfirmDel(null);
  }, [data, activeId, persist]);

  const totalEntries = Object.values(data).flat().length;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 120px)', overflow: 'hidden', background: '#080c14' }}>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <div style={{
        width: 200, flexShrink: 0, background: '#0a1020',
        borderRight: '1px solid #1e293b', display: 'flex', flexDirection: 'column',
        overflowY: 'auto',
      }}>
        {/* Logo */}
        <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid #1e293b' }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#f8fafc' }}>📓 Notebook</div>
          <div style={{ fontSize: 10, color: '#334155', marginTop: 2 }}>{totalEntries} entries</div>
        </div>

        {/* Overview */}
        <button
          onClick={() => setActiveId(null)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
            background: activeId === null ? '#1e293b' : 'transparent',
            border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left',
            borderLeft: activeId === null ? '3px solid #00d4aa' : '3px solid transparent',
            color: activeId === null ? '#f8fafc' : '#64748b',
            fontSize: 13, fontWeight: activeId === null ? 700 : 500,
          }}
        >
          <span>🏠</span> Overview
        </button>

        {/* Section nav */}
        <div style={{ padding: '8px 0' }}>
          {SECTIONS.map(s => {
            const count = (data[s.id] || []).length;
            const isActive = activeId === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setActiveId(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px',
                  background: isActive ? '#1e293b' : 'transparent',
                  border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left',
                  borderLeft: isActive ? `3px solid ${s.color}` : '3px solid transparent',
                  color: isActive ? '#f8fafc' : '#64748b',
                  fontSize: 12, fontWeight: isActive ? 700 : 500,
                }}
              >
                <span style={{ fontSize: 16 }}>{s.icon}</span>
                <span style={{ flex: 1 }}>{s.label}</span>
                {count > 0 && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                    background: isActive ? s.color + '33' : '#1e293b', color: isActive ? s.color : '#334155',
                  }}>{count}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div style={{ padding: '8px 12px', marginTop: 'auto', borderTop: '1px solid #1e293b' }}>
          <input
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%', background: '#1e293b', color: '#e2e8f0',
              border: '1px solid #334155', borderRadius: 7, padding: '7px 10px',
              fontSize: 11, outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', position: 'relative' }}>
        {activeId === null ? (
          <OverviewGrid data={data} onSelectSection={setActiveId} />
        ) : (
          <SectionView
            section={activeSection}
            entries={entries.slice().reverse()}
            onAdd={() => setEditing('new')}
            onEdit={(entry) => setEditing(entry)}
            onDelete={(id) => setConfirmDel(id)}
            search={search}
          />
        )}

        {/* Floating new entry button (when in a section) */}
        {activeId && (
          <button
            onClick={() => setEditing('new')}
            style={{
              position: 'fixed', bottom: 36, right: 28,
              width: 52, height: 52, borderRadius: '50%',
              background: activeSection?.color || '#00d4aa',
              border: 'none', color: '#080c14', fontSize: 26,
              cursor: 'pointer', boxShadow: `0 4px 24px ${activeSection?.color || '#00d4aa'}66`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 700, zIndex: 100,
            }}
            title={`New ${activeSection?.label} Entry`}
          >
            +
          </button>
        )}
      </div>

      {/* ── Entry editor overlay ─────────────────────────────────────────────── */}
      {editing && activeSection && (
        <EntryEditor
          entry={editing === 'new' ? null : editing}
          section={activeSection}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}

      {/* ── Delete confirm ───────────────────────────────────────────────────── */}
      {confirmDel && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: '#0f172a', border: '1px solid #334155', borderRadius: 14,
            padding: '24px 28px', maxWidth: 340, textAlign: 'center',
          }}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>🗑️</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#f8fafc', marginBottom: 8 }}>Delete Entry?</div>
            <div style={{ fontSize: 12, color: '#475569', marginBottom: 20 }}>This action cannot be undone.</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={() => setConfirmDel(null)} style={{
                padding: '8px 20px', borderRadius: 8, background: '#1e293b',
                border: '1px solid #334155', color: '#94a3b8', fontSize: 12, cursor: 'pointer', fontWeight: 600,
              }}>Cancel</button>
              <button onClick={() => handleDelete(confirmDel)} style={{
                padding: '8px 20px', borderRadius: 8, background: '#ef4444',
                border: 'none', color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 700,
              }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
