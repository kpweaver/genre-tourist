import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import SpotifyWebApi from 'spotify-web-api-node';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { supabase } from './supabaseClient.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, '.spotify-tokens.json');

chromium.use(StealthPlugin());

// Shared Playwright launch options — always headless + no-sandbox in production (required for Railway/Linux)
const PLAYWRIGHT_LAUNCH_OPTS = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
};

const app = express();
const PORT = process.env.PORT || 8888;
const IS_PROD = process.env.NODE_ENV === 'production';

// In production use APP_URL (Railway public URL), otherwise local dev default
const REDIRECT_URI = IS_PROD
  ? `${process.env.APP_URL}/api/callback`
  : (process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8888/api/callback');

const SPOTIFY_SCOPES = ['playlist-modify-public', 'playlist-modify-private'];

// Frontend origin: production public URL or local Vite port
const FRONTEND_ORIGIN = IS_PROD
  ? process.env.APP_URL
  : (process.env.FRONTEND_URL || 'http://localhost:3000');

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: REDIRECT_URI,
});

let spotifyAccessToken = null;
let spotifyRefreshToken = null;

/** Load stored Spotify tokens from disk (survives restarts). */
function loadTokens() {
  try {
    const raw = fs.readFileSync(TOKENS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.access_token) {
      spotifyAccessToken = data.access_token;
      spotifyRefreshToken = data.refresh_token || spotifyRefreshToken;
      spotifyApi.setAccessToken(spotifyAccessToken);
      if (spotifyRefreshToken) spotifyApi.setRefreshToken(spotifyRefreshToken);
      console.log('Loaded stored Spotify tokens');
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Could not load Spotify tokens:', e.message);
  }
}

/** Persist Spotify tokens to disk. */
function saveTokens() {
  try {
    fs.writeFileSync(
      TOKENS_FILE,
      JSON.stringify({
        access_token: spotifyAccessToken,
        refresh_token: spotifyRefreshToken,
        updated_at: new Date().toISOString(),
      }, null, 2),
      'utf8'
    );
    console.log('Stored Spotify tokens');
  } catch (e) {
    console.warn('Could not save Spotify tokens:', e.message);
  }
}

loadTokens();

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, same-origin) and the configured frontend
    const allowed = [FRONTEND_ORIGIN, 'http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:8888'];
    if (!origin || allowed.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/** Format genre for AOTY URL: lowercase, spaces to hyphens (e.g. "synth pop" -> "synth-pop") */
function formatGenreSlug(genre) {
  return genre
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

const TOP_N = 20;
const SCRAPE_TIMEOUT_MS = 60000;

/**
 * TIER 1: Scrape AOTY with Playwright.
 * Returns { albums, success, notFound }. albums are { rank, artist, album }[].
 */
async function scrapeAotyWithPlaywright(genreSlug) {
  const url = `https://www.albumoftheyear.org/ratings/user-highest-rated/all/${genreSlug}/`;
  let browser;

  try {
    browser = await chromium.launch(PLAYWRIGHT_LAUNCH_OPTS);

    const page = await browser.newPage();
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: SCRAPE_TIMEOUT_MS,
    });

    if (response && response.status() === 404) {
      return { albums: [], success: false, notFound: true };
    }

    await page.waitForSelector('a[href*="/album/"]', {
      timeout: 20000,
      state: 'attached',
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 2000));

    const albums = await page.evaluate((limit) => {
      const albumEls = Array.from(document.querySelectorAll('.albumTitle')).slice(0, limit);
      const artistEls = Array.from(document.querySelectorAll('.artistTitle')).slice(0, limit);
      if (albumEls.length > 0 || artistEls.length > 0) {
        return albumEls.length >= artistEls.length
          ? albumEls.map((albumEl, i) => {
              const album = albumEl?.textContent?.trim() || '';
              const container = albumEl.closest('li, tr, [class*="album"], [class*="row"], div');
              const artistEl = container?.querySelector?.('.artistTitle');
              const artist = (artistEl?.textContent?.trim()) || (artistEls[i]?.textContent?.trim()) || '';
              const albumLink = container?.querySelector?.('a[href*="/album/"]');
              const albumUrl = albumLink?.getAttribute?.('href') || null;
              return { rank: i + 1, artist, album, albumUrl };
            }).filter(({ artist, album }) => artist || album)
          : artistEls.map((artistEl, i) => {
              const artist = artistEl?.textContent?.trim() || '';
              const container = artistEl.closest('li, tr, [class*="album"], [class*="row"], div');
              const albumEl = container?.querySelector?.('.albumTitle');
              const album = (albumEl?.textContent?.trim()) || (albumEls[i]?.textContent?.trim()) || '';
              const albumLink = container?.querySelector?.('a[href*="/album/"]');
              const albumUrl = albumLink?.getAttribute?.('href') || null;
              return { rank: i + 1, artist, album, albumUrl };
            }).filter(({ artist, album }) => artist || album);
      }
      const links = Array.from(document.querySelectorAll('a[href*="/album/"]'))
        .filter((a) => (a.textContent || '').includes(' - '))
        .slice(0, limit);
      return links.map((a, i) => {
        const text = a?.textContent?.trim() || '';
        const idx = text.indexOf(' - ');
        const artist = idx > 0 ? text.slice(0, idx).trim() : '';
        const album = idx > 0 ? text.slice(idx + 3).trim() : text;
        const albumUrl = a?.getAttribute?.('href') || null;
        return { rank: i + 1, artist, album, albumUrl };
      }).filter(({ artist, album }) => artist || album);
    }, TOP_N);

    const notFound = albums.length === 0;
    return { albums, success: albums.length > 0, notFound };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * FALLBACK: Scrape AOTY via ZenRows API; parse with cheerio.
 * Returns { albums, success }. albums are { rank, artist, album }[] (same format as Playwright).
 */
async function scrapeAotyWithZenRows(genreSlug) {
  const apiKey = process.env.ZENROWS_API_KEY;
  if (!apiKey) {
    console.log('ZENROWS_API_KEY not set, skipping ZenRows fallback.');
    return { albums: [], success: false };
  }

  const url = `https://www.albumoftheyear.org/ratings/user-highest-rated/all/${genreSlug}/`;
  const params = new URLSearchParams({
    apikey: apiKey,
    url,
    js_render: 'true',
    premium_proxy: 'true',
  });

  try {
    const { data: html } = await axios.get(`https://api.zenrows.com/v1/?${params.toString()}`, {
      timeout: 90000,
    });

    const $ = cheerio.load(html);
    const albums = [];
    const albumEls = $('.albumTitle').slice(0, TOP_N);
    const artistEls = $('.artistTitle').slice(0, TOP_N);

    if (albumEls.length > 0 || artistEls.length > 0) {
      const n = Math.max(albumEls.length, artistEls.length);
      for (let i = 0; i < n; i++) {
        const album = $(albumEls[i]).text().trim() || '';
        const artist = $(artistEls[i]).text().trim() || '';
        const albumUrl = $(albumEls[i]).closest('li, tr, [class*="row"], div').find('a[href*="/album/"]').attr('href') || null;
        if (artist || album) albums.push({ rank: i + 1, artist, album, albumUrl });
      }
    } else {
      $('a[href*="/album/"]').each((i, el) => {
        if (i >= TOP_N) return false;
        const text = $(el).text().trim();
        if (!text.includes(' - ')) return;
        const idx = text.indexOf(' - ');
        albums.push({
          rank: i + 1,
          artist: text.slice(0, idx).trim(),
          album: text.slice(idx + 3).trim(),
          albumUrl: $(el).attr('href') || null,
        });
      });
    }

    return { albums, success: albums.length > 0 };
  } catch (err) {
    console.error('ZenRows fallback error:', err.message);
    return { albums: [], success: false };
  }
}

/**
 * Tiered getChartData: Try Playwright, then ZenRows. Returns { albums } in a single format.
 */
async function getChartData(genreSlug) {
  try {
    const result = await scrapeAotyWithPlaywright(genreSlug);
    if (result.success && result.albums.length > 0) {
      console.log('Tier 1 Success.');
      return { albums: result.albums };
    }
  } catch (err) {
    console.error('Tier 1 Playwright error:', err.message);
  }

  console.log('Tier 1 Playwright failed, escalating to ZenRows...');
  const zenRows = await scrapeAotyWithZenRows(genreSlug);
  if (zenRows.success && zenRows.albums.length > 0) {
    console.log('ZenRows fallback success.');
    return { albums: zenRows.albums };
  }

  return { albums: [] };
}

const AOTY_BASE = 'https://www.albumoftheyear.org';

/**
 * Scrape track list from a single AOTY album page, ordered by user rating (most popular first).
 * Uses the track list table: col 1 = #, col 2 = "TrackName" + "Duration", col 3 = rating.
 * @param {string} albumPath - e.g. "/album/224348-fiona-apple-fetch-the-bolt-cutters.php"
 * @returns {Promise<string[]>} Track names in order of AOTY rating (highest first), or [] if unavailable.
 */
async function scrapeAotyAlbumTracks(albumPath) {
  if (!albumPath || typeof albumPath !== 'string') return [];
  const pathNorm = albumPath.startsWith('/') ? albumPath : `/${albumPath}`;
  const url = `${AOTY_BASE}${pathNorm}`;
  let browser;
  try {
    browser = await chromium.launch(PLAYWRIGHT_LAUNCH_OPTS);
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1500));

    const trackNames = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('tr'));
        const parsed = rows.map((tr) => {
          const tds = tr.querySelectorAll('td');
          return Array.from(tds).map((td) => (td.textContent || '').trim());
        }).filter((row) => row.length >= 3);
        if (parsed.length < 2) continue;
        const withRating = [];
        for (const row of parsed) {
          const rating = parseInt(row[2], 10);
          if (Number.isNaN(rating) || rating < 0 || rating > 100) continue;
          const nameAndDuration = row[1] || '';
          const name = nameAndDuration.replace(/\d{1,2}:\d{2}$/, '').trim();
          if (!name) continue;
          withRating.push({ name, rating });
        }
        if (withRating.length >= 2) {
          withRating.sort((a, b) => b.rating - a.rating);
          return withRating.map((x) => x.name);
        }
      }
      return [];
    });

    return Array.isArray(trackNames) ? trackNames : [];
  } catch (err) {
    console.warn('scrapeAotyAlbumTracks failed:', url, err.message);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

let genresCache = null;
let genresCacheTime = 0;
const GENRES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function slugToDisplayName(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Scrape AOTY genre.php for all genre links. Returns { name, slug }[].
 */
async function fetchAotyGenres() {
  const url = `${AOTY_BASE}/genre.php`;
  let browser;
  try {
    browser = await chromium.launch(PLAYWRIGHT_LAUNCH_OPTS);
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1500));

    const list = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      const links = document.querySelectorAll('a[href*="/genre/"]');
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/genre\/\d+-([^/]+)\/?$/);
        if (!match) continue;
        const slug = match[1];
        if (seen.has(slug)) continue;
        let name = (a.textContent || '').trim();
        if (name === 'View More' || !name) {
          let prev = a.previousElementSibling;
          while (prev) {
            if (prev.tagName === 'H2' || prev.tagName === 'H1') {
              name = (prev.textContent || '').trim();
              break;
            }
            prev = prev.previousElementSibling;
          }
          if (!name) name = slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }
        seen.add(slug);
        out.push({ slug, name: name || slug });
      }
      return out;
    });

    const genres = (list || [])
      .filter((g) => g.slug && g.name)
      .map((g) => ({ name: g.name || slugToDisplayName(g.slug), slug: g.slug }));
    return genres;
  } catch (err) {
    console.warn('fetchAotyGenres failed:', err.message);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

app.get('/api/genres', async (req, res) => {
  try {
    if (genresCache && Date.now() - genresCacheTime < GENRES_CACHE_TTL_MS) {
      return res.json({ genres: genresCache });
    }
    const genres = await fetchAotyGenres();
    if (genres.length > 0) {
      genresCache = genres;
      genresCacheTime = Date.now();
    } else if (genresCache) {
      // Keep previous cache on scrape failure
    } else {
      genresCache = [];
    }
    res.json({ genres: genresCache });
  } catch (err) {
    console.error('GET /api/genres error:', err);
    res.status(500).json({ error: 'Failed to load genres', genres: genresCache || [] });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.get('/api/chart/:genre', async (req, res) => {
  try {
    const rawGenre = req.params.genre?.trim();
    if (!rawGenre) {
      return res.status(400).json({ error: 'Genre parameter is required' });
    }

    const genreSlug = formatGenreSlug(rawGenre);
    const genreKey = rawGenre.toLowerCase().trim();

    const { data: cachedData, error: cacheError } = await supabase
      .from('rym_charts_cache')
      .select('*')
      .eq('genre', genreKey)
      .single();

    if (cacheError && cacheError.code !== 'PGRST116') {
      console.error('Error checking cache:', cacheError);
    }

    if (cachedData && cachedData.data) {
      const cacheTime = new Date(cachedData.updated_at || cachedData.created_at);
      const hoursSinceUpdate = (Date.now() - cacheTime) / (1000 * 60 * 60);
      if (hoursSinceUpdate < 24) {
        return res.json({
          genre: genreKey,
          data: cachedData.data,
          cached: true,
          cachedAt: cacheTime.toISOString(),
        });
      }
    }

    console.log(`Scraping AOTY chart for genre: ${genreSlug}`);
    const { albums } = await getChartData(genreSlug);

    if (!albums || albums.length === 0) {
      return res.status(404).json({
        error: 'Genre not found. Try a different spelling or check AlbumOfTheYear.org for valid genre names (e.g. rock, hip-hop, shoegaze).',
        genre: genreKey,
      });
    }

    const chartPayload = {
      genre: genreKey,
      data: albums,
      updated_at: new Date().toISOString(),
    };

    if (cachedData) {
      await supabase.from('rym_charts_cache').update(chartPayload).eq('genre', genreKey);
    } else {
      await supabase.from('rym_charts_cache').insert(chartPayload);
    }

    res.json({
      genre: genreKey,
      data: albums,
      cached: false,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error fetching chart:', err);
    res.status(500).json({
      error: 'Failed to fetch chart data',
      message: err.message,
    });
  }
});

app.get('/api/auth/url', (req, res) => {
  const url = spotifyApi.createAuthorizeURL(SPOTIFY_SCOPES, null);
  res.json({ url });
});

/** Login flow: returns Spotify auth URL for frontend to redirect to */
app.get('/api/login', (req, res) => {
  const url = spotifyApi.createAuthorizeURL(SPOTIFY_SCOPES, null);
  res.json({ url });
});

/** Callback for login flow: exchange code, redirect to frontend with token in URL */
app.get('/api/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.redirect(`${FRONTEND_ORIGIN}?error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect(`${FRONTEND_ORIGIN}?error=missing_code`);
  }
  try {
    const data = await spotifyApi.authorizationCodeGrant(code);
    const accessToken = data.body.access_token;
    spotifyAccessToken = accessToken;
    spotifyRefreshToken = data.body.refresh_token;
    spotifyApi.setAccessToken(spotifyAccessToken);
    spotifyApi.setRefreshToken(spotifyRefreshToken);
    saveTokens();
    res.redirect(`${FRONTEND_ORIGIN}?token=${encodeURIComponent(accessToken)}`);
  } catch (err) {
    console.error('Spotify callback error:', err);
    res.redirect(`${FRONTEND_ORIGIN}?error=${encodeURIComponent(err.message || 'auth_failed')}`);
  }
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.redirect(`/?error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.status(400).send('Missing code');
  }
  try {
    const data = await spotifyApi.authorizationCodeGrant(code);
    spotifyAccessToken = data.body.access_token;
    spotifyRefreshToken = data.body.refresh_token;
    spotifyApi.setAccessToken(spotifyAccessToken);
    spotifyApi.setRefreshToken(spotifyRefreshToken);
    saveTokens();
    res.redirect(process.env.FRONTEND_URL || 'http://localhost:3000/?spotify=ok');
  } catch (err) {
    console.error('Spotify callback error:', err);
    res.redirect(`/?error=${encodeURIComponent(err.message || 'auth_failed')}`);
  }
});

/** Get current user profile (for allowlist: add this email in Dashboard → Settings → Users and access). */
app.get('/api/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Send Authorization: Bearer <access_token>' });
  }
  try {
    spotifyApi.setAccessToken(authHeader.slice(7));
    const me = await spotifyApi.getMe();
    const body = me?.body;
    if (!body) return res.status(500).json({ error: 'Could not load profile' });
    res.json({
      id: body.id,
      display_name: body.display_name,
      email: body.email || null,
      hint: 'In Dashboard → your app → Settings → Users and access, add the email above (or your Spotify account email if this is null). App owner must have Spotify Premium in development mode.',
    });
  } catch (err) {
    const status = err.statusCode || 500;
    const msg = err?.body?.error?.message ?? err?.message;
    res.status(status).json({ error: msg || 'Failed to get profile' });
  }
});

const TRACKS_PER_ALBUM = 3;

/**
 * Fetch all tracks for an album (paginated). Uses axios so we explicitly set limit=50 and follow next.
 * Returns full array of simplified track objects. Throws on 401/403 so caller can prompt re-login.
 */
async function getAllAlbumTracks(spotifyApi, albumId) {
  const token = spotifyApi.getAccessToken();
  if (!token) return [];
  const all = [];
  let url = `https://api.spotify.com/v1/albums/${albumId}/tracks?limit=50&offset=0`;
  while (url) {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
    const status = res?.status;
    if (status === 401 || status === 403) {
      const err = new Error(res?.data?.error?.message || 'Spotify auth failed');
      err.statusCode = status;
      err.body = res?.data;
      throw err;
    }
    if (!res?.data?.items?.length) break;
    all.push(...res.data.items);
    url = res.data.next || null;
  }
  return all;
}

/**
 * Get up to N track URIs from an album's tracks, ordered by Spotify popularity (highest first).
 * Falls back to first N in album order if fetching full track details fails.
 */
async function getTopTrackUrisByPopularity(spotifyApi, albumTrackItems, n = 3) {
  const take = Math.min(n, albumTrackItems.length);
  if (take === 0) return [];
  const ids = albumTrackItems.slice(0, 50).map((t) => t.id).filter(Boolean);
  if (ids.length === 0) {
    return albumTrackItems.slice(0, take).map((t) => t.uri).filter(Boolean);
  }
  try {
    const res = await spotifyApi.getTracks(ids);
    const tracks = res?.body?.tracks || [];
    const withPopularity = tracks.filter((t) => t && t.uri).map((t) => ({ uri: t.uri, popularity: t.popularity ?? 0 }));
    withPopularity.sort((a, b) => b.popularity - a.popularity);
    const uris = withPopularity.slice(0, take).map((t) => t.uri);
    if (uris.length >= take) return uris;
    const used = new Set(uris);
    for (const t of albumTrackItems) {
      if (uris.length >= take) break;
      if (t.uri && !used.has(t.uri)) {
        uris.push(t.uri);
        used.add(t.uri);
      }
    }
    return uris;
  } catch (e) {
    return albumTrackItems.slice(0, take).map((t) => t.uri).filter(Boolean);
  }
}

/** Generate playlist from genre + albums (search Spotify, create playlist, add tracks). Returns playlist_id. */
app.post('/api/generate-playlist', async (req, res) => {
  try {
    const { genre, albums } = req.body;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Not authenticated',
        message: 'Send Authorization: Bearer <access_token>. Log in via /api/login first.',
      });
    }
    spotifyApi.setAccessToken(authHeader.slice(7));

    if (!genre || !Array.isArray(albums) || albums.length === 0) {
      return res.status(400).json({ error: 'Request body must include genre and a non-empty albums array' });
    }

    const playlistName = `[${genre}] Genre Primer (AOTY)`;
    const trackUris = [];
    const ADD_TRACKS_CHUNK = 100;
    let authError = null;

    function norm(s) {
      return (s || '')
        .toLowerCase()
        .replace(/\s*\([^)]*\)/g, '')
        .replace(/\s*[–—-]\s*.*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    function findMatch(aotyName, spotifyNormToUri) {
      const n = norm(aotyName);
      const uri = spotifyNormToUri.get(n);
      if (uri) return uri;
      for (const [spotifyNorm, u] of spotifyNormToUri) {
        if (spotifyNorm.includes(n) || n.includes(spotifyNorm)) return u;
        if (n.length >= 4 && spotifyNorm.startsWith(n)) return u;
      }
      return null;
    }

    for (const item of albums) {
      try {
        const q = `artist:${(item.artist || '').trim()} album:${(item.album || '').trim()}`;
        const search = await spotifyApi.searchAlbums(q, { limit: 1 });
        const first = search?.body?.albums?.items?.[0];
        if (!first?.id) continue;

        const items = await getAllAlbumTracks(spotifyApi, first.id);
        if (items.length === 0) continue;
        if (items.length < TRACKS_PER_ALBUM) {
          console.log(`Album "${item.artist} – ${item.album}" has only ${items.length} track(s), taking all`);
        }

        let urisToAdd = [];
        const aotyOrder = item.albumUrl ? await scrapeAotyAlbumTracks(item.albumUrl) : [];
        if (!item.albumUrl) {
          console.log(`No albumUrl for ${item.artist} – ${item.album}, using top ${TRACKS_PER_ALBUM} by Spotify popularity`);
          urisToAdd = await getTopTrackUrisByPopularity(spotifyApi, items, TRACKS_PER_ALBUM);
        } else if (aotyOrder.length === 0) {
          console.log(`AOTY returned no rated tracks for ${item.artist} – ${item.album}, using top ${TRACKS_PER_ALBUM} by Spotify popularity`);
          urisToAdd = await getTopTrackUrisByPopularity(spotifyApi, items, TRACKS_PER_ALBUM);
        } else {
          const byNorm = new Map(items.map((t) => [norm(t.name), t.uri]).filter(([k]) => k));
          for (let i = 0; i < Math.min(TRACKS_PER_ALBUM, aotyOrder.length); i++) {
            const uri = findMatch(aotyOrder[i], byNorm);
            if (uri && !urisToAdd.includes(uri)) urisToAdd.push(uri);
          }
          if (urisToAdd.length > 0) {
            console.log(`AOTY top-rated for ${item.artist} – ${item.album}: ${urisToAdd.length}/${TRACKS_PER_ALBUM} matched (AOTY order: ${aotyOrder.slice(0, 3).join(' | ')})`);
          } else {
            console.log(`AOTY names did not match Spotify for ${item.artist} – ${item.album}; Spotify: ${items.slice(0, 3).map((t) => t.name).join(' | ')}`);
          }
        }
        if (urisToAdd.length < TRACKS_PER_ALBUM) {
          const used = new Set(urisToAdd);
          for (const t of items) {
            if (urisToAdd.length >= TRACKS_PER_ALBUM) break;
            if (t.uri && !used.has(t.uri)) {
              urisToAdd.push(t.uri);
              used.add(t.uri);
            }
          }
        }
        if (urisToAdd.length < TRACKS_PER_ALBUM && items.length >= TRACKS_PER_ALBUM) {
          console.warn(`Only ${urisToAdd.length}/${TRACKS_PER_ALBUM} tracks for ${item.artist} – ${item.album} (album has ${items.length} tracks)`);
        }
        for (const uri of urisToAdd) trackUris.push(uri);
      } catch (e) {
        const status = e.statusCode ?? e.response?.status;
        if ((status === 401 || status === 403) && !authError) authError = e;
        console.warn(`Spotify search skip: ${item.artist} - ${item.album}`, e.message);
      }
    }

    if (trackUris.length === 0) {
      if (authError && (authError.statusCode === 401 || authError.statusCode === 403)) {
        return res.status(401).json({
          error: 'Token expired or invalid',
          message: 'Please log in again (click Log in with Spotify, then try creating the playlist again).',
        });
      }
      return res.status(422).json({
        error: 'No matching tracks found',
        message: 'Could not resolve any albums to Spotify tracks. Try logging in again (token may have expired), or try a different genre.',
      });
    }

    const playlist = await spotifyApi.createPlaylist(playlistName, {
      description: `Genre primer: top ${genre} albums from AlbumOfTheYear.org`,
      public: true,
    });
    const playlistId = playlist?.body?.id;
    if (!playlistId) {
      return res.status(500).json({ error: 'Failed to create playlist' });
    }

    // Use new /items endpoint (Development Mode); library uses deprecated /tracks which can 403
    const accessToken = spotifyApi.getAccessToken();
    let tracksAdded = 0;
    let addTracksError = null;
    try {
      for (let i = 0; i < trackUris.length; i += ADD_TRACKS_CHUNK) {
        const chunk = trackUris.slice(i, i + ADD_TRACKS_CHUNK);
        const itemsRes = await axios.post(
          `https://api.spotify.com/v1/playlists/${playlistId}/items`,
          { uris: chunk },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
          }
        );
        if (itemsRes.status === 201) tracksAdded += chunk.length;
      }
    } catch (addErr) {
      const body = addErr?.response?.data;
      addTracksError = body?.error?.message ?? addErr?.message ?? 'Unknown error';
      console.error('Add tracks to playlist failed (playlist was created):', addErr?.response?.status, addTracksError, body);
    }

    const playlistUrl = playlist?.body?.external_urls?.spotify || `https://open.spotify.com/playlist/${playlistId}`;
    res.status(201).json({
      playlist_id: playlistId,
      playlistUrl,
      trackCount: tracksAdded,
      requestedTrackCount: trackUris.length,
      ...(addTracksError && { error: addTracksError, message: 'Playlist created but adding tracks failed. You can open it and add songs manually.' }),
    });
  } catch (err) {
    const status = err.statusCode || 500;
    const spotifyMsg = err?.body?.error?.message ?? err?.body?.error ?? err?.message;
    console.error('Generate playlist error:', status, spotifyMsg, err?.body);
    if (status === 403 && (spotifyMsg === 'Forbidden' || /not registered|insufficient/i.test(String(spotifyMsg)))) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Your Spotify user must be in this app’s allowlist. In Dashboard → your app → Settings → Users and access, add the exact email of the account you use to log in (if you use Facebook login, use that email). The app owner must have Spotify Premium. Call GET /api/me with your token to see which account you’re using.',
        spotifyMessage: spotifyMsg,
      });
    }
    if (err?.body?.error?.message || err?.body?.error) {
      return res.status(status).json({
        error: err.body?.error?.message ?? err.body?.error,
        message: err.body?.error?.message ?? err.body?.error,
      });
    }
    res.status(500).json({
      error: 'Failed to create playlist',
      message: err?.message ?? 'Unknown error',
    });
  }
});

app.post('/api/create-playlist', async (req, res) => {
  try {
    const { genre, albums } = req.body;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      spotifyApi.setAccessToken(authHeader.slice(7));
    } else if (spotifyAccessToken) {
      spotifyApi.setAccessToken(spotifyAccessToken);
    } else {
      return res.status(401).json({
        error: 'Not authenticated',
        message: 'Log in via GET /api/auth/url and visit the callback, or send Authorization: Bearer <access_token>',
      });
    }

    if (!genre || !Array.isArray(albums) || albums.length === 0) {
      return res.status(400).json({ error: 'Request body must include genre and a non-empty albums array' });
    }

    const playlistName = `[${genre}] Genre Primer`;
    const trackUris = [];
    const TRACKS_PER_ALBUM = 3;
    const ADD_TRACKS_CHUNK = 100;

    for (const item of albums) {
      try {
        const q = `artist:${(item.artist || '').trim()} album:${(item.album || '').trim()}`;
        const search = await spotifyApi.searchAlbums(q, { limit: 1 });
        const first = search?.body?.albums?.items?.[0];
        if (!first?.id) continue;

        const tracksRes = await spotifyApi.getAlbumTracks(first.id, { limit: 50 });
        const items = tracksRes?.body?.items || [];
        if (items.length === 0) continue;

        const urisToAdd = items.slice(0, TRACKS_PER_ALBUM).map((t) => t.uri).filter(Boolean);
        for (const uri of urisToAdd) trackUris.push(uri);
      } catch (e) {
        console.warn(`Spotify search skip: ${item.artist} - ${item.album}`, e.message);
      }
    }

    if (trackUris.length === 0) {
      return res.status(422).json({
        error: 'No matching tracks found',
        message: 'Could not resolve any albums to Spotify tracks. Try logging in again (token may have expired), or try a different genre.',
      });
    }

    const playlist = await spotifyApi.createPlaylist(playlistName, {
      description: `Genre primer: top ${genre} albums from AlbumOfTheYear.org`,
      public: true,
    });
    const playlistId = playlist?.body?.id;
    if (!playlistId) {
      return res.status(500).json({ error: 'Failed to create playlist' });
    }

    const createPlaylistToken = spotifyApi.getAccessToken();
    for (let i = 0; i < trackUris.length; i += ADD_TRACKS_CHUNK) {
      const chunk = trackUris.slice(i, i + ADD_TRACKS_CHUNK);
      await axios.post(
        `https://api.spotify.com/v1/playlists/${playlistId}/items`,
        { uris: chunk },
        {
          headers: {
            Authorization: `Bearer ${createPlaylistToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    const playlistUrl = playlist?.body?.external_urls?.spotify;
    res.status(201).json({
      playlistId,
      playlistName,
      trackCount: trackUris.length,
      playlistUrl: playlistUrl || `https://open.spotify.com/playlist/${playlistId}`,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    const spotifyMsg = err?.body?.error?.message ?? err?.body?.error ?? err?.message;
    console.error('Create playlist error:', status, spotifyMsg, err?.body);
    if (status === 403 && (spotifyMsg === 'Forbidden' || /not registered|insufficient/i.test(String(spotifyMsg)))) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Your Spotify user must be in this app’s allowlist. Dashboard → your app → Settings → Users and access: add the exact email you use to log in (Facebook email if you use Facebook). App owner needs Spotify Premium. GET /api/me with your token shows which account you’re using.',
        spotifyMessage: spotifyMsg,
      });
    }
    if (err?.body?.error?.message || err?.body?.error) {
      return res.status(status).json({
        error: err.body?.error?.message ?? err.body?.error,
        message: err.body?.error?.message ?? err.body?.error,
      });
    }
    res.status(500).json({
      error: 'Failed to create playlist',
      message: err?.message ?? 'Unknown error',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
