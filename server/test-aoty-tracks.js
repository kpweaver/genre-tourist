/**
 * Test AOTY album track scraper: run with node test-aoty-tracks.js
 * Requires: npm install playwright-extra puppeteer-extra-plugin-stealth (if not already)
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const AOTY_BASE = 'https://www.albumoftheyear.org';
const TEST_PATH = '/album/142290-molchat-doma--etazhi.php'; // Molchat Doma - Etazhi

async function main() {
  const url = `${AOTY_BASE}${TEST_PATH}`;
  console.log('Fetching', url);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise((r) => setTimeout(r, 2000));

  const result = await page.evaluate(() => {
    const out = { tableRows: [], byRating: [] };
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tr'));
      const parsed = rows.map((tr) => {
        const tds = tr.querySelectorAll('td');
        return Array.from(tds).map((td) => (td.textContent || '').trim());
      }).filter((row) => row.length >= 3);
      if (parsed.length >= 2 && /^\d+$/.test(parsed[0][0])) {
        out.tableRows = parsed;
        const withRating = parsed.map((row) => {
          const nameAndDuration = row[1] || '';
          const name = nameAndDuration.replace(/\d{1,2}:\d{2}$/, '').trim();
          const rating = parseInt(row[2], 10) || 0;
          return { name, rating };
        }).filter((x) => x.name);
        withRating.sort((a, b) => b.rating - a.rating);
        out.byRating = withRating.map((x) => x.name);
        break;
      }
    }
    return out;
  });

  console.log('Track table rows:', result.tableRows?.length);
  console.log('Top 3 by AOTY rating:', result.byRating?.slice(0, 3) || 'none');
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
