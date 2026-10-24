'use strict';

// ZIP code locations and distances, for "Calebs near you".

const fs = require('node:fs');
const path = require('node:path');

const ZIP_FILE = path.join(__dirname, '..', 'data', 'us-zip-centroids.csv');
const EARTH_RADIUS_MILES = 3958.8;

let zips = null;

// Loads the ZIP code table on first use: zip -> { lat, lon }.
function zipTable() {
  if (!zips) {
    zips = new Map();
    for (const line of fs.readFileSync(ZIP_FILE, 'utf8').split('\n').slice(1)) {
      const [zip, lat, lon] = line.split(',');
      if (zip) zips.set(zip, { lat: Number(lat), lon: Number(lon) });
    }
  }
  return zips;
}

// Normalizes what a member typed as a ZIP or postal code. US ZIP+4 codes are
// shortened to five digits; Canadian postal codes are upper-cased as "A1A 1A1".
function normalizePostalCode(input) {
  const s = String(input ?? '').trim().toUpperCase();
  const us = s.match(/^(\d{5})(?:-?\d{4})?$/);
  if (us) return us[1];
  const ca = s.replace(/\s+/g, '').match(/^([A-Z]\d[A-Z])(\d[A-Z]\d)$/);
  if (ca) return `${ca[1]} ${ca[2]}`;
  return s;
}

// The location of a US ZIP code, or null when it isn't one we know.
function locate(postalCode) {
  return zipTable().get(postalCode) || null;
}

// Great-circle distance in miles.
function distanceMiles(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

module.exports = { normalizePostalCode, locate, distanceMiles };
