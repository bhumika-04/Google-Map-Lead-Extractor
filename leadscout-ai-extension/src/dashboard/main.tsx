import React from 'react'
import ReactDOM from 'react-dom/client'
import Dashboard from './Dashboard'
import '@/styles/global.css'

// Light theme is the default. Apply it before first paint so there's no dark
// flash; the Dashboard reverts to dark only if the user has saved that preference.
document.documentElement.classList.add('light')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>
)
