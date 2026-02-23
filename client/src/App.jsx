import { useState, useEffect, useMemo } from 'react'

const API_BASE = import.meta.env.VITE_API_URL || ''
const TOKEN_KEY = 'spotify_token'

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [genre, setGenre] = useState('')
  const [loading, setLoading] = useState(false)
  const [playlistLoading, setPlaylistLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [playlistId, setPlaylistId] = useState(null)
  const [playlistUrl, setPlaylistUrl] = useState(null)
  const [playlistWarning, setPlaylistWarning] = useState(null)
  const [genres, setGenres] = useState([])
  const [showGenreSuggestions, setShowGenreSuggestions] = useState(false)

  const filteredGenres = useMemo(() => {
    if (!genres.length) return []
    const t = genre.trim().toLowerCase()
    const slug = t.replace(/\s+/g, '-')
    return genres
      .filter(
        (g) =>
          !t ||
          g.name.toLowerCase().includes(t) ||
          g.slug.toLowerCase().includes(slug)
      )
      .slice(0, 50)
  }, [genres, genre])

  // First suggestion whose name starts with the typed text — shown inline in the input
  const inlineSuggestion = useMemo(() => {
    const t = genre.trim()
    if (!t || !filteredGenres.length) return null
    const first = filteredGenres[0]
    return first.name.toLowerCase().startsWith(t.toLowerCase()) ? first.name : null
  }, [filteredGenres, genre])

  // Read token or error from URL after callback redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlToken = params.get('token')
    const urlError = params.get('error')
    if (urlToken) {
      localStorage.setItem(TOKEN_KEY, urlToken)
      setToken(urlToken)
      window.history.replaceState({}, '', window.location.pathname)
    }
    if (urlError) {
      setError(decodeURIComponent(urlError))
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  // Fetch AOTY genre list for autocomplete
  useEffect(() => {
    fetch(`${API_BASE}/api/genres`)
      .then((res) => res.json())
      .then((data) => data.genres && setGenres(data.genres))
      .catch(() => {})
  }, [])

  async function handleLogin() {
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/login`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to get login URL')
      if (!data.url) throw new Error('Server did not return a login URL. Is the backend running on port 5000?')
      window.location.href = data.url
    } catch (e) {
      setError(e.message || 'Login failed')
    }
  }

  async function handleGenerate() {
    const trimmed = genre.trim()
    if (!trimmed) {
      setError('Enter a genre')
      return
    }
    setError(null)
    setResult(null)
    setPlaylistId(null)
    setPlaylistUrl(null)
    setPlaylistWarning(null)
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/chart/${encodeURIComponent(trimmed)}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || data.message || 'Request failed')
        return
      }
      setResult(data)
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }

  async function handleCreatePlaylist() {
    if (!token || !result?.data?.length) return
    setError(null)
    setPlaylistWarning(null)
    setPlaylistLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/generate-playlist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          genre: result.genre,
          albums: result.data.map((item) => ({ artist: item.artist, album: item.album, albumUrl: item.albumUrl })),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.message || data.error || 'Failed to create playlist')
        if (res.status === 401) {
          localStorage.removeItem(TOKEN_KEY)
          setToken(null)
        }
        return
      }
      setPlaylistId(data.playlist_id)
      setPlaylistUrl(data.playlistUrl || `https://open.spotify.com/playlist/${data.playlist_id}`)
      if (data.message || (data.error && data.trackCount === 0)) {
        setPlaylistWarning(data.message || data.error)
      }
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setPlaylistLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#121212] text-white font-sans">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Genre Primer</h1>
        <p className="text-[#b3b3b3] text-sm mb-8">
          Essential albums by genre from AlbumOfTheYear.org — build a primer playlist on Spotify.
        </p>

        {!token ? (
          <div className="mb-8">
            <button
              onClick={handleLogin}
              className="px-6 py-3 bg-[#1db954] hover:bg-[#1ed760] rounded-full font-semibold text-black transition-colors flex items-center gap-2"
            >
              <span>Login with Spotify</span>
            </button>
            <p className="text-[#727272] text-sm mt-3">
              Log in to create playlists from the chart.
            </p>
          </div>
        ) : (
          <>
            <div className="flex gap-3 mb-8">
              <div
                className={`flex-1 relative rounded-lg border border-[#3e3e3e] bg-[#282828] transition-[border-radius] focus-within:ring-2 focus-within:ring-[#1db954] focus-within:border-transparent ${
                  showGenreSuggestions && filteredGenres.length > 0 ? 'rounded-b-none' : ''
                }`}
              >
                {/* Ghost inline completion — typed part is invisible for spacing, rest in grey */}
                {inlineSuggestion && (
                  <div
                    className="absolute inset-0 flex items-center px-4 pr-10 pointer-events-none overflow-hidden whitespace-nowrap"
                    aria-hidden="true"
                    style={{ font: 'inherit', letterSpacing: 'inherit' }}
                  >
                    <span className="text-transparent">{genre}</span>
                    <span className="text-[#555]">{inlineSuggestion.slice(genre.length)}</span>
                  </div>
                )}

                <input
                  type="text"
                  value={genre}
                  onChange={(e) => {
                    setGenre(e.target.value)
                    setShowGenreSuggestions(true)
                  }}
                  onFocus={() => setShowGenreSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowGenreSuggestions(false), 150)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Tab' || e.key === 'ArrowRight') && inlineSuggestion) {
                      e.preventDefault()
                      setGenre(inlineSuggestion)
                      setShowGenreSuggestions(false)
                    } else if (e.key === 'Enter') {
                      handleGenerate()
                    } else if (e.key === 'Escape') {
                      setShowGenreSuggestions(false)
                    }
                  }}
                  placeholder="Search genres… e.g. shoegaze, post-punk"
                  className="relative w-full bg-transparent border-0 rounded-lg px-4 py-3 pr-10 text-white placeholder-[#727272] focus:outline-none focus:ring-0 disabled:opacity-50"
                  disabled={loading}
                  autoComplete="off"
                  aria-autocomplete="both"
                  aria-expanded={showGenreSuggestions && filteredGenres.length > 0}
                  aria-controls="genre-listbox"
                  id="genre-search"
                  spellCheck={false}
                />

                {/* Search icon */}
                <span className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#727272]" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                </span>

                {/* Dropdown for browsing all matches */}
                {showGenreSuggestions && filteredGenres.length > 0 && (
                  <ul
                    id="genre-listbox"
                    role="listbox"
                    className="absolute z-10 left-0 right-0 top-full max-h-60 overflow-y-auto rounded-b-lg border border-t-0 border-[#3e3e3e] bg-[#282828] py-1"
                    style={{ boxShadow: '0 10px 25px -5px rgba(0,0,0,0.4)' }}
                  >
                    {filteredGenres.map((g, i) => (
                      <li
                        key={g.slug}
                        role="option"
                        className={`px-4 py-2.5 cursor-pointer text-sm hover:bg-[#3e3e3e] active:bg-[#404040] ${i === 0 && inlineSuggestion ? 'text-white' : 'text-[#b3b3b3]'}`}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setGenre(g.name)
                          setShowGenreSuggestions(false)
                        }}
                      >
                        {inlineSuggestion && i === 0 ? (
                          <>
                            <span className="text-white">{genre}</span>
                            <span className="text-[#727272]">{g.name.slice(genre.length)}</span>
                          </>
                        ) : (
                          g.name
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                onClick={handleGenerate}
                disabled={loading}
                className="px-6 py-3 bg-[#1db954] hover:bg-[#1ed760] disabled:opacity-50 disabled:cursor-not-allowed rounded-full font-semibold text-black transition-colors"
              >
                {loading ? 'Loading…' : 'Generate'}
              </button>
            </div>

            {error && (
              <div className="mb-6 p-4 bg-[#282828] border border-red-500/50 rounded-lg text-red-400 text-sm">
                {error}
              </div>
            )}

            {result && !playlistId && (
              <div className="bg-[#181818] rounded-xl overflow-hidden border border-[#282828] mb-6">
                <div className="px-6 py-4 border-b border-[#282828] flex items-center justify-between">
                  <span className="text-[#b3b3b3] text-sm">
                    {result.cached ? 'From cache' : 'Just scraped'} · {result.data?.length ?? 0} albums
                  </span>
                  <span className="text-[#1db954] font-medium capitalize">{result.genre}</span>
                </div>
                <ul className="divide-y divide-[#282828] max-h-[50vh] overflow-y-auto">
                  {result.data?.map((item) => (
                    <li
                      key={`${item.rank}-${item.artist}-${item.album}`}
                      className="px-6 py-3 flex items-center gap-4 hover:bg-[#282828] transition-colors"
                    >
                      <span className="text-[#727272] w-8 text-right text-sm tabular-nums">
                        {item.rank}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{item.album}</p>
                        <p className="text-[#b3b3b3] text-sm truncate">{item.artist}</p>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="px-6 py-4 border-t border-[#282828] bg-[#1a1a1a]">
                  <button
                    onClick={handleCreatePlaylist}
                    disabled={playlistLoading}
                    className="w-full py-3 bg-[#1db954] hover:bg-[#1ed760] disabled:opacity-50 disabled:cursor-not-allowed rounded-full font-semibold text-black transition-colors"
                  >
                    {playlistLoading ? 'Creating playlist…' : 'Create Spotify Playlist'}
                  </button>
                </div>
              </div>
            )}

            {playlistId && (
              <div className="bg-[#181818] rounded-xl overflow-hidden border border-[#282828] shadow-xl">
                <div className="px-6 py-5 border-b border-[#282828]">
                  <p className="text-[#1db954] font-semibold text-lg mb-1">Success!</p>
                  <p className="text-[#b3b3b3] text-sm">
                    {playlistWarning ? 'Playlist created. You can open it and add songs manually.' : 'Your playlist has been created and added to your Spotify account.'}
                  </p>
                  {playlistWarning && (
                    <p className="text-amber-400 text-sm mt-2">
                      Note: {playlistWarning}
                    </p>
                  )}
                </div>
                <div className="p-4">
                  <iframe
                    src={`https://open.spotify.com/embed/playlist/${playlistId}`}
                    width="100%"
                    height="380"
                    frameBorder="0"
                    allow="encrypted-media"
                    title="Spotify playlist"
                    className="rounded-lg"
                  />
                </div>
                <div className="px-6 py-4 border-t border-[#282828] bg-[#1a1a1a]">
                  <a
                    href={playlistUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center w-full py-3 bg-[#1db954] hover:bg-[#1ed760] rounded-full font-semibold text-black transition-colors"
                  >
                    Open in Spotify
                  </a>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
