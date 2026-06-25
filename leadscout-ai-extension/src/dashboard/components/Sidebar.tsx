import React from 'react'

export type NavSection =
  | 'overview'
  | 'search'
  | 'leads'
  | 'selected'
  | 'research'
  | 'research_results'
  | 'analytics'
  | 'import'
  | 'backup'
  | 'logs'
  | 'settings'

interface NavItem {
  id: NavSection
  label: string
  icon: string
  badge?: number
  dividerBefore?: boolean
}

interface SidebarProps {
  active: NavSection
  onChange: (section: NavSection) => void
  leadCount?: number
  researchCount?: number
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview',   label: 'Overview',       icon: '◈' },
  { id: 'search',     label: 'Search Console', icon: '⌕' },
  { id: 'leads',      label: 'Lead Database',  icon: '☰' },
  { id: 'selected',   label: 'Selected Leads', icon: '✓' },
  { id: 'research',         label: 'Research Queue',   icon: '⚗' },
  { id: 'research_results', label: 'Research Results',  icon: '◉' },
  { id: 'analytics',        label: 'Analytics',         icon: '▦', dividerBefore: true },
  { id: 'import',     label: 'Import CSV',     icon: '↑' },
  { id: 'backup',     label: 'Backup & Restore', icon: '⇅' },
  { id: 'logs',       label: 'Activity Logs',  icon: '≡', dividerBefore: true },
  { id: 'settings',   label: 'Settings',       icon: '⚙' },
]

export default function Sidebar({ active, onChange, leadCount, researchCount }: SidebarProps) {
  return (
    <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0 h-full">
      {/* Logo — height matches topbar h-14 */}
      <div className="h-14 px-4 flex items-center border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-sm shadow-lg shadow-blue-900/50">
            LS
          </div>
          <div>
            <div className="font-semibold text-sm text-white leading-none">LeadScout</div>
            <div className="text-xs text-blue-400 leading-none mt-0.5">AI</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const isActive = active === item.id
          const badge = item.id === 'leads' ? leadCount : item.id === 'research' ? researchCount : undefined
          return (
            <React.Fragment key={item.id}>
              {item.dividerBefore && <div className="mx-3 my-1.5 border-t border-gray-800" />}
              <button
                onClick={() => onChange(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all ${
                  isActive
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`}
              >
                <span className="text-base w-4 text-center">{item.icon}</span>
                <span className="flex-1 text-left font-medium">{item.label}</span>
                {badge !== undefined && badge > 0 && (
                  <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                    isActive ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-300'
                  }`}>
                    {badge > 999 ? '999+' : badge}
                  </span>
                )}
              </button>
            </React.Fragment>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-800">
        <div className="text-xs text-gray-600">LeadScout AI v1.0.0</div>
        <div className="text-xs text-gray-700">Phase 1 — Local Mode</div>
      </div>
    </aside>
  )
}
