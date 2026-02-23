/**
 * Test: do we get popularity from GET /v1/tracks and does sort work?
 * Run: node test-popularity.js
 */
import dotenv from 'dotenv';
import axios from 'axios';
import SpotifyWebApi from 'spotify-web-api-node';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const tokenPath = path.join(__dirname, '.spotify-tokens.json');
let token;
try {
  const data = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  token = data.access_token;
} catch (e) {
  console.error('No token file or invalid JSON. Log in via the app first.');
  process.exit(1);
}

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI,
});
spotifyApi.setAccessToken(token);

// Use same album as chart (e.g. first from shoegaze)
const artist = 'Have a Nice Life';
const album = 'Deathconsciousness';

async function main() {
  console.log('1. Search album:', artist, '-', album);
  const q = `artist:${artist} album:${album}`;
  const search = await spotifyApi.searchAlbums(q, { limit: 1 });
  const first = search?.body?.albums?.items?.[0];
  if (!first?.id) {
    console.log('   No album found');
    return;
  }
  console.log('   Found album id:', first.id, first.name);

  console.log('\n2. Get album tracks (limit 50)');
  const tracksRes = await spotifyApi.getAlbumTracks(first.id, { limit: 50 });
  const items = tracksRes?.body?.items || [];
  console.log('   Tracks count:', items.length);
  const trackIds = items.map((t) => t.id).filter(Boolean);
  console.log('   First 5 track IDs:', trackIds.slice(0, 5));

  console.log('\n3. GET /v1/tracks/{id} for each (single-track works when ?ids= returns 403)');
  const toFetch = trackIds.slice(0, 10);
  const trackPromises = toFetch.map((id) =>
    axios.get(`https://api.spotify.com/v1/tracks/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.data).catch(() => null)
  );
  const fullTracks = (await Promise.all(trackPromises)).filter(Boolean);
  console.log('   Fetched', fullTracks.length, 'tracks');

  console.log('\n4. Each track: name, popularity, uri');
  fullTracks.forEach((t, i) => {
    if (!t) {
      console.log(`   [${i}] null`);
      return;
    }
    console.log(`   [${i}] popularity=${t.popularity ?? 'MISSING'} name="${t.name}" uri=${t.uri ?? 'MISSING'}`);
  });

  const withUri = fullTracks.filter((t) => t && t.uri);
  const byPopularity = withUri.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  console.log('\n5. After sort by popularity (desc), top 3:');
  byPopularity.slice(0, 3).forEach((t, i) => {
    console.log(`   ${i + 1}. popularity=${t.popularity} "${t.name}"`);
  });

  console.log('\n6. First 3 in album order (what we would use as fallback):');
  items.slice(0, 3).forEach((t, i) => {
    console.log(`   ${i + 1}. "${t.name}"`);
  });
}

main().catch((e) => {
  console.error('Error:', e.response?.data || e.message);
  process.exit(1);
});
