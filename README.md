# PEAD Trader

Post-Earnings Announcement Drift — backtest engine + live signal dashboard.

## Stack
- **Backend**: Node.js + Express + SQLite (better-sqlite3)
- **Frontend**: React + Recharts
- **Data**: Financial Modeling Prep (FMP) API
- **Strategy**: Academic PEAD spec — concordant filter, 60-day hold, flat 10% sizing

---

## Setup

### 1. Get FMP API Key
Sign up at https://financialmodelingprep.com  
The Starter plan (~$25/month) covers everything you need:
- Historical earnings with consensus EPS
- Historical OHLCV prices
- S&P 500 constituents
- Company profiles

### 2. Backend

```bash
cd backend
cp .env.example .env
# Edit .env and add your FMP API key
npm install
npm run dev
```

Backend runs on http://localhost:3001

### 3. Frontend

```bash
cd frontend
npm install
npm start
```

Frontend runs on http://localhost:3000

---

## Workflow

### Step 1 — Universe tab
Click **Build / Refresh Universe**.  
This fetches all S&P 500 stocks, filters by market cap ≥$10B and avg volume ≥1M, and stores the top 50 by market cap.  
Takes 3–5 minutes.

### Step 2 — Data Load tab
Set your date range (default: 2018–2024) and click **Load Data**.  
This fetches earnings history + price data for every stock in the universe and generates concordant PEAD signals.  
Takes 10–20 minutes (API rate limits). Data is cached in SQLite — won't re-fetch on repeat runs.

### Step 3 — Backtest tab
Set parameters and click **Run Backtest**.  
- Hold period: 60 trading days (academic default)
- Position size: 10% of capital
- No stops, no take profits

Results appear immediately in the Results tab.

### Step 4 — Results tab
- Equity curve
- Return distribution histogram
- Full trade log (symbol, entry/exit dates & prices, return %, P&L)
- All historical runs saved for comparison

---

## Architecture

```
backend/
  src/
    api/
      fmp.js          — FMP API wrapper
      routes.js       — Express routes
    data/
      db.js           — SQLite schema + queries
    engine/
      universe.js     — Dynamic stock selection
      signals.js      — Earnings surprise + concordant filter
      backtest.js     — P&L simulation + metrics
    index.js          — Server entry

frontend/
  src/
    pages/
      Universe.js     — Universe management
      DataLoader.js   — Data load + signal viewer
      Backtest.js     — Run configuration
      Results.js      — Equity curve + trade log
    App.js
    api.js            — Axios API client
```

---

## Signal Logic

1. Fetch historical earnings: actual EPS vs consensus EPS
2. Calculate surprise %: `(actual - estimate) / |estimate| * 100`
3. Determine reaction day:
   - BMO (before market open): same session
   - AMC (after market close): next session
4. Measure reaction: `(reaction_open - prev_close) / prev_close * 100`
5. Concordant filter:
   - LONG: surprise > +1% AND reaction > +0.5%
   - SHORT: surprise < -1% AND reaction < -0.5%
   - NO_TRADE: surprise and reaction disagree

---

## Phase 2 — Live Trading (IG)
IG has a REST + streaming API. Once you've validated the backtest results, the next step is:
1. Wire the earnings calendar endpoint to generate forward signals
2. Connect to IG API for position management
3. Add a live Signals monitor tab

---

## Disclaimer
For research and educational purposes. Not financial advice. Backtest results are historical and not predictive of future performance.
