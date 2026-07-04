import axios from 'axios';

const BASE_URL = 'https://financialmodelingprep.com';

class FMPClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 15000,
    });
  }

  async get(endpoint, params = {}) {
    const response = await this.client.get(endpoint, {
      params: { ...params, apikey: this.apiKey },
    });
    return response.data;
  }

  // Screen for large-cap US stocks (replaces S&P 500 list + profile)
  async getStockScreener({ minMarketCap = 10e9, minVolume = 1_000_000, limit = 250 } = {}) {
    return this.get('/stable/company-screener', {
      marketCapMoreThan: minMarketCap,
      volumeMoreThan: minVolume,
      country: 'US',
      isEtf: false,
      isFund: false,
      isActivelyTrading: true,
      limit,
    });
  }

  // Historical earnings with consensus EPS estimates
  async getEarningsHistory(symbol, limit = 40) {
    return this.get('/stable/earnings', { symbol, limit });
  }

  // Company profile (market cap, averageVolume, sector, etc.)
  async getProfile(symbol) {
    return this.get('/stable/profile', { symbol });
  }

  // Forward earnings calendar
  async getEarningsCalendar(from, to) {
    return this.get('/stable/earnings-calendar', { from, to });
  }
}

export default FMPClient;
