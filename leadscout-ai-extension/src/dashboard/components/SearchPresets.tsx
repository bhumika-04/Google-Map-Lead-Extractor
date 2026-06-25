import React, { useState } from 'react'
import type { SearchPreset } from '@/types/settings'
import { useSettingsStore } from '@/state/useSettingsStore'
import { toast } from '@/state/useToastStore'

interface SearchPresetsProps {
  city: string
  keyword: string
  maxResults?: number
  onLoad: (city: string, keyword: string) => void
}

export default function SearchPresets({ city, keyword, maxResults, onLoad }: SearchPresetsProps) {
  const { settings, update } = useSettingsStore()
  const presets = settings.searchPresets ?? []
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  async function handleSave() {
    if (!name.trim()) return
    if (!city.trim() || !keyword.trim()) {
      toast.warning('Enter city and keyword before saving a preset')
      return
    }
    const preset: SearchPreset = {
      id: Date.now().toString(36),
      name: name.trim(),
      city: city.trim(),
      keyword: keyword.trim(),
      maxResults,
    }
    await update({ searchPresets: [...presets, preset] })
    toast.success(`Preset "${preset.name}" saved`)
    setName('')
    setNaming(false)
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    await update({ searchPresets: presets.filter((p) => p.id !== id) })
    toast.info('Preset deleted')
  }

  if (presets.length === 0 && !naming) {
    return (
      <div className="flex items-center gap-2 mt-2">
        <span className="text-xs text-gray-600">No presets saved.</span>
        {city && keyword && (
          <button
            onClick={() => setNaming(true)}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            + Save current as preset
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2 mt-2">
      {/* Preset chips */}
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <div
              key={p.id}
              className="group flex items-center gap-1 px-2.5 py-1 bg-gray-800 hover:bg-gray-700
                border border-gray-700 hover:border-gray-600 rounded-lg cursor-pointer transition-colors"
              onClick={() => { onLoad(p.city, p.keyword); toast.info(`Loaded: ${p.name}`) }}
              title={`${p.keyword} in ${p.city}`}
            >
              <span className="text-xs text-gray-300 font-medium">{p.name}</span>
              <span className="text-xs text-gray-600">({p.city})</span>
              <button
                onClick={(e) => handleDelete(p.id, e)}
                className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400
                  transition-all text-sm leading-none ml-0.5"
                title="Delete preset"
              >×</button>
            </div>
          ))}
        </div>
      )}

      {/* Save button / name input */}
      {naming ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setNaming(false) }}
            placeholder="Preset name…"
            className="flex-1 bg-gray-800 border border-gray-700 text-white text-xs px-2.5 py-1.5 rounded-lg
              placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
          <button onClick={handleSave}
            className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
            Save
          </button>
          <button onClick={() => setNaming(false)}
            className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors border border-gray-700">
            Cancel
          </button>
        </div>
      ) : (
        city && keyword && (
          <button
            onClick={() => { setName(`${keyword} in ${city}`); setNaming(true) }}
            className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
          >
            + Save current as preset
          </button>
        )
      )}
    </div>
  )
}
