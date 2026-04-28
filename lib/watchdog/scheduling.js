// lib/watchdog/scheduling.js
import { log } from '../logger/Logger.js';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export class DailyScheduler {
  constructor() {
    this._lastRunDates = {};
  }

  shouldRun(jobName, hourUTC, now = new Date()) {
    const currentHour = now.getUTCHours();
    if (currentHour < hourUTC) return false;
    const todayStr = now.toISOString().slice(0, 10);
    return this._lastRunDates[jobName] !== todayStr;
  }

  markRun(jobName, now = new Date()) {
    this._lastRunDates[jobName] = now.toISOString().slice(0, 10);
  }

  isWeeklyDay(dayName, now = new Date()) {
    return DAY_NAMES[now.getUTCDay()] === dayName.toLowerCase();
  }

  getState() {
    return { ...this._lastRunDates };
  }

  loadState(state) {
    if (state && typeof state === 'object') {
      this._lastRunDates = { ...state };
    }
  }
}
