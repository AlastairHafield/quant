import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

export const getUniverse = () => api.get('/universe').then(r => r.data);
export const buildUniverse = () => api.post('/universe/build').then(r => r.data);
export const removeStock = (symbol) => api.delete(`/universe/${symbol}`).then(r => r.data);

export const loadData = (body) => api.post('/data/load', body).then(r => r.data);
export const getSignals = (params) => api.get('/signals', { params }).then(r => r.data);

export const runBacktest = (body) => api.post('/backtest/run', body).then(r => r.data);
export const getBacktestRuns = () => api.get('/backtest/runs').then(r => r.data);
export const getBacktestTrades = (id) => api.get(`/backtest/runs/${id}/trades`).then(r => r.data);

export const runSDBacktest = (body) => api.post('/sd/backtest/run', body).then(r => r.data);
export const getSDBacktestRuns = () => api.get('/sd/backtest/runs').then(r => r.data);
export const getSDBacktestTrades = (id) => api.get(`/sd/backtest/runs/${id}/trades`).then(r => r.data);
export const parsePineScript = (body) => api.post('/sd/parse-pinescript', body).then(r => r.data);

export const runMRBacktest = (body) => api.post('/mr/backtest/run', body).then(r => r.data);
export const runMRSweep = (body) => api.post('/mr/sweep/run', body).then(r => r.data);
export const getMRRuns = () => api.get('/mr/backtest/runs').then(r => r.data);
export const getMRTrades = (id) => api.get(`/mr/backtest/runs/${id}/trades`).then(r => r.data);
export const getMRSweep = (sweepId) => api.get(`/mr/sweeps/${sweepId}`).then(r => r.data);

export const runORBBacktest = (body) => api.post('/orb/backtest/run', body).then(r => r.data);
export const runORBSweep = (body) => api.post('/orb/sweep/run', body).then(r => r.data);
export const getORBRuns = () => api.get('/orb/backtest/runs').then(r => r.data);
export const getORBTrades = (id) => api.get(`/orb/backtest/runs/${id}/trades`).then(r => r.data);

// gex-breakout worker runs as a separate Heroku dyno with no public routing of its
// own, so it pushes its status to the backend and we read it back from there.
export const getGexBreakoutStatus = () => api.get('/gex-breakout/status').then(r => r.data);
export const getORBSweep = (sweepId) => api.get(`/orb/sweeps/${sweepId}`).then(r => r.data);
