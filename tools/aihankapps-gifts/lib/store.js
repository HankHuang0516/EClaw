'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..', '..');
const CAMPAIGN_DIR = path.join(ROOT, 'campaigns');
const PROMO_DIR = path.join(ROOT, 'promo');
const PUBLIC_DIR = path.join(REPO, 'backend', 'public', 'AiHankApps');
const HOLD_FILE = path.join(ROOT, 'HOLD');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadGames() {
  return readJson(path.join(ROOT, 'games.json'));
}

function loadCalendar() {
  return readJson(path.join(ROOT, 'calendar.json'));
}

function loadCampaigns(dir = CAMPAIGN_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort()
    .map(name => {
      const campaign = readJson(path.join(dir, name));
      if (`${campaign.id}.json` !== name) throw new Error(`campaign_file_name_mismatch:${name}`);
      return campaign;
    });
}

function saveCampaign(campaign, dir = CAMPAIGN_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${campaign.id}.json`);
  fs.writeFileSync(file, JSON.stringify(campaign, null, 2) + '\n');
  return file;
}

// A HOLD file stops drafting, approval and delivery. Its text is the reason shown to the operator.
function holdReason(file = HOLD_FILE) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').trim() || 'HOLD file present';
}

// Key-sorted JSON, so a hash does not depend on the order fields were written in.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = {
  ROOT, REPO, CAMPAIGN_DIR, PROMO_DIR, PUBLIC_DIR, HOLD_FILE,
  readJson, loadGames, loadCalendar, loadCampaigns, saveCampaign, holdReason, canonical, sha256
};
