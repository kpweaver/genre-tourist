import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

const ZENROWS_API_KEY = process.env.ZENROWS_API_KEY;
// Let's test with a classic genre
const TEST_GENRE = 'shoegaze';
const TARGET_URL = `https://rateyourmusic.com/charts/top/album/all-time/g:${TEST_GENRE}/`;

const ZENROWS_BASE = 'https://api.zenrows.com/v1/';

async function runTest() {
  if (!ZENROWS_API_KEY) {
    console.error('❌ ZENROWS_API_KEY is not set in .env');
    return;
  }
  console.log(`🚀 Starting test scrape for: ${TEST_GENRE}... (ZenRows)`);

  const params = new URLSearchParams({
    apikey: ZENROWS_API_KEY,
    url: TARGET_URL,
    js_render: 'true',
    antibot: 'true',
    premium_proxy: 'true',
    proxy_country: 'us',
    wait_for: '.chart_row_list .obj_chart_albums',
  });

  try {
    const response = await axios.get(`${ZENROWS_BASE}?${params.toString()}`, {
      timeout: 120000, // 2 min for js_render + premium proxy
    });
    const html = response.data;
    const $ = cheerio.load(html);

    const albums = [];

    // These selectors target the standard RYM chart row structure
    $('.chart_row_list .obj_chart_albums').each((i, el) => {
      if (i < 10) { // Just get the top 10
        const artist = $(el).find('.chart_row_artist').text().trim();
        const album = $(el).find('.chart_row_album').text().trim();
        
        if (artist && album) {
          albums.push({ artist, album });
        }
      }
    });

    if (albums.length > 0) {
      console.log('✅ Success! Found these albums:');
      console.table(albums);
    } else {
      console.error('❌ Scrape successful but no albums found. Check selectors or RYM layout.');
    }
  } catch (error) {
    console.error('❌ Test failed!');
    console.error(error.response ? error.response.data : error.message);
  }
}

runTest().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});