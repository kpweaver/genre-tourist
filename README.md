# GenreTourist

Full-stack application with React frontend and Express backend.

## Setup

1. Install dependencies for all projects:
   ```bash
   npm run install:all
   ```

2. Configure environment variables:
   - Copy `.env` file in the `server` folder and fill in your API keys:
     - `SPOTIFY_CLIENT_ID`
     - `SPOTIFY_CLIENT_SECRET`
     - `SCRAPERAPI_KEY`
     - `SUPABASE_URL`
     - `SUPABASE_SERVICE_ROLE_KEY`

## Development

Start both frontend and backend concurrently:
```bash
npm run dev
```

Or start them separately:
```bash
npm run dev:client  # Frontend on http://localhost:3000
npm run dev:server  # Backend on http://localhost:5000
```

## Project Structure

```
GenreTourist/
├── client/          # React + Vite + Tailwind CSS frontend
├── server/          # Express backend
└── package.json     # Root package.json with concurrently scripts
```
