/**
 * gps-recommendations.js
 * GET /api/gps/recommendations?lat=&lng=
 * Returns mock nearby recommendations (restaurants, parking, attractions)
 * based on provided GPS coordinates.
 *
 * Auth: deviceId + botSecret (or deviceSecret)
 */

'use strict';

const console_log = console.log.bind(console);
const console_error = console.error.bind(console);

console_log('[GpsRec] Module loading');

// ---------------------------------------------------------------------------
// Mock data pools (Taiwan-flavoured for realism)
// ---------------------------------------------------------------------------

const RESTAURANTS = [
  {
    id: 'r001',
    name: '鼎泰豐 (信義店)',
    name_en: 'Din Tai Fung (Xinyi)',
    emoji: '🥟',
    category: 'restaurant',
    cuisine: 'Dumplings · Taiwanese',
    rating: 4.8,
    reviews: 2847,
    price_level: '$$$',
    address: '台北市大安區信義路二段194號',
    address_en: 'No. 194, Sec. 2, Xinyi Rd, Da\'an, Taipei',
    phone: '02-2321-8928',
    hours: '10:00 AM – 9:00 PM',
    base_distance_m: 320,
    lat_offset: 0.0029,
    lng_offset: 0.0011,
  },
  {
    id: 'r002',
    name: 'CoCo壹番屋',
    name_en: 'CoCo Ichibanya',
    emoji: '🍛',
    category: 'restaurant',
    cuisine: 'Curry Rice · Japanese',
    rating: 4.3,
    reviews: 1234,
    price_level: '$$',
    address: '台北市中正區忠孝西路一段36號',
    address_en: 'No. 36, Sec. 1, Zhongxiao W. Rd, Zhongzheng, Taipei',
    phone: '02-2312-4567',
    hours: '11:00 AM – 10:00 PM',
    base_distance_m: 180,
    lat_offset: -0.0016,
    lng_offset: 0.0023,
  },
  {
    id: 'r003',
    name: '林東芳牛肉麵',
    name_en: 'Lin Dong Fang Beef Noodle',
    emoji: '🍜',
    category: 'restaurant',
    cuisine: 'Beef Noodle · Local',
    rating: 4.7,
    reviews: 3981,
    price_level: '$',
    address: '台北市中山區八德路二段322號',
    address_en: 'No. 322, Sec. 2, Bade Rd, Zhongshan, Taipei',
    phone: '02-2752-2556',
    hours: '11:00 AM – 2:00 AM',
    base_distance_m: 450,
    lat_offset: 0.0041,
    lng_offset: -0.0008,
  },
  {
    id: 'r004',
    name: '饒河街夜市',
    name_en: 'Raohe Street Night Market',
    emoji: '🌃',
    category: 'restaurant',
    cuisine: 'Night Market · Street Food',
    rating: 4.6,
    reviews: 5621,
    price_level: '$',
    address: '台北市松山區饒河街',
    address_en: 'Raohe St, Songshan, Taipei',
    phone: null,
    hours: '5:00 PM – 12:00 AM',
    base_distance_m: 680,
    lat_offset: 0.0062,
    lng_offset: 0.0031,
  },
  {
    id: 'r005',
    name: '阜杭豆漿',
    name_en: 'Fuhang Soy Milk',
    emoji: '🥛',
    category: 'restaurant',
    cuisine: 'Breakfast · Taiwanese',
    rating: 4.5,
    reviews: 8203,
    price_level: '$',
    address: '台北市中正區忠孝東路一段108號2樓',
    address_en: '2F, No. 108, Sec. 1, Zhongxiao E. Rd, Zhongzheng, Taipei',
    phone: '02-2392-2175',
    hours: '5:30 AM – 12:30 PM',
    base_distance_m: 230,
    lat_offset: -0.0021,
    lng_offset: 0.0017,
  },
  {
    id: 'r006',
    name: '好記擔擔麵',
    name_en: 'Haoji Dan Dan Noodles',
    emoji: '🍝',
    category: 'restaurant',
    cuisine: 'Noodles · Sichuan',
    rating: 4.4,
    reviews: 976,
    price_level: '$$',
    address: '台北市大安區復興南路一段107巷5弄1號',
    address_en: 'No. 1, Aly. 5, Ln. 107, Sec. 1, Fuxing S. Rd, Da\'an, Taipei',
    phone: '02-2771-0098',
    hours: '11:30 AM – 8:30 PM',
    base_distance_m: 395,
    lat_offset: 0.0036,
    lng_offset: -0.0028,
  },
];

const PARKING_LOTS = [
  {
    id: 'p001',
    name: '台北市立停車場 (中正)',
    name_en: 'Taipei City Parking (Zhongzheng)',
    emoji: '🅿️',
    category: 'parking',
    available_spaces: 47,
    total_spaces: 200,
    rate: 'NT$40/hr',
    rate_en: 'NT$40/hr',
    address: '台北市中正區公園路15號',
    address_en: 'No. 15, Gongyuan Rd, Zhongzheng, Taipei',
    hours: '24hr',
    base_distance_m: 150,
    lat_offset: -0.0014,
    lng_offset: 0.0019,
  },
  {
    id: 'p002',
    name: '信義停車場 B2',
    name_en: 'Xinyi Parking B2',
    emoji: '🚗',
    category: 'parking',
    available_spaces: 12,
    total_spaces: 80,
    rate: 'NT$50/hr',
    rate_en: 'NT$50/hr',
    address: '台北市大安區信義路三段150號B2',
    address_en: 'B2, No. 150, Sec. 3, Xinyi Rd, Da\'an, Taipei',
    hours: '7:00 AM – 11:00 PM',
    base_distance_m: 280,
    lat_offset: 0.0025,
    lng_offset: 0.0014,
  },
  {
    id: 'p003',
    name: '大安森林公園停車場',
    name_en: "Da'an Forest Park Parking",
    emoji: '🌳',
    category: 'parking',
    available_spaces: 89,
    total_spaces: 300,
    rate: 'NT$30/hr',
    rate_en: 'NT$30/hr',
    address: '台北市大安區新生南路二段1號',
    address_en: 'No. 1, Sec. 2, Xinsheng S. Rd, Da\'an, Taipei',
    hours: '24hr',
    base_distance_m: 520,
    lat_offset: 0.0047,
    lng_offset: -0.0033,
  },
  {
    id: 'p004',
    name: '捷運台北101停車場',
    name_en: 'MRT Taipei 101 Parking',
    emoji: '🏢',
    category: 'parking',
    available_spaces: 0,
    total_spaces: 150,
    rate: 'NT$60/hr',
    rate_en: 'NT$60/hr',
    address: '台北市信義區市府路45號',
    address_en: 'No. 45, Shifu Rd, Xinyi, Taipei',
    hours: '6:00 AM – 12:00 AM',
    base_distance_m: 710,
    lat_offset: 0.0064,
    lng_offset: 0.0052,
  },
];

const ATTRACTIONS = [
  {
    id: 'a001',
    name: '中正紀念堂',
    name_en: 'Chiang Kai-shek Memorial Hall',
    emoji: '🏛️',
    category: 'attraction',
    subcategory: 'Monument · History',
    rating: 4.7,
    reviews: 41230,
    admission: 'Free',
    address: '台北市中正區中山南路21號',
    address_en: 'No. 21, Zhongshan S. Rd, Zhongzheng, Taipei',
    hours: '9:00 AM – 6:00 PM (closed Mon)',
    base_distance_m: 410,
    lat_offset: 0.0037,
    lng_offset: -0.0009,
  },
  {
    id: 'a002',
    name: '大安森林公園',
    name_en: "Da'an Forest Park",
    emoji: '🌲',
    category: 'attraction',
    subcategory: 'Park · Nature',
    rating: 4.6,
    reviews: 22840,
    admission: 'Free',
    address: '台北市大安區新生南路二段',
    address_en: 'Sec. 2, Xinsheng S. Rd, Da\'an, Taipei',
    hours: '24hr',
    base_distance_m: 550,
    lat_offset: 0.0049,
    lng_offset: -0.0031,
  },
  {
    id: 'a003',
    name: '台北101',
    name_en: 'Taipei 101',
    emoji: '🗼',
    category: 'attraction',
    subcategory: 'Landmark · Shopping',
    rating: 4.8,
    reviews: 63517,
    admission: 'NT$600 (observatory)',
    address: '台北市信義區市府路45號',
    address_en: 'No. 45, Shifu Rd, Xinyi, Taipei',
    hours: '9:00 AM – 10:00 PM',
    base_distance_m: 730,
    lat_offset: 0.0066,
    lng_offset: 0.0055,
  },
  {
    id: 'a004',
    name: '龍山寺',
    name_en: 'Longshan Temple',
    emoji: '⛩️',
    category: 'attraction',
    subcategory: 'Temple · Culture',
    rating: 4.6,
    reviews: 34120,
    admission: 'Free',
    address: '台北市萬華區廣州街211號',
    address_en: 'No. 211, Guangzhou St, Wanhua, Taipei',
    hours: '6:00 AM – 10:00 PM',
    base_distance_m: 890,
    lat_offset: 0.0080,
    lng_offset: -0.0060,
  },
];

// ---------------------------------------------------------------------------
// Helper: compute jittered distance based on lat/lng offset from user
// ---------------------------------------------------------------------------
function computeDistance(userLat, userLng, itemLatOffset, itemLngOffset, baseDistanceM) {
    // Simulate distance variation based on user coords (deterministic but varies by location)
    const seed = Math.abs(Math.sin((userLat * 1000 + itemLatOffset * 10000) * (userLng * 1000 + itemLngOffset * 10000)));
    const jitter = Math.floor(seed * 100) - 50; // ±50m jitter
    return Math.max(50, baseDistanceM + jitter);
}

function walkMinutes(distanceM) {
    return Math.max(1, Math.round(distanceM / 80)); // ~80m/min walking pace
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------
module.exports = function gpsRecommendations(app, { safeEqual, devices }) {
    console_log('[GpsRec] Registering GET /api/gps/recommendations');

    /**
     * GET /api/gps/recommendations
     * Query params:
     *   lat         {number} required — user latitude
     *   lng         {number} required — user longitude
     *   deviceId    {string} required — for auth
     *   botSecret   {string} required — bot authentication
     *   deviceSecret{string} optional — alternative auth
     *   limit       {number} optional — max items per category (default 3)
     *   categories  {string} optional — comma-separated: restaurant,parking,attraction (default: all)
     *
     * Response:
     * {
     *   success: true,
     *   userLocation: { lat, lng },
     *   results: {
     *     restaurants: [...],
     *     parking: [...],
     *     attractions: [...]
     *   },
     *   totalCount: number,
     *   generatedAt: ISO timestamp
     * }
     */
    app.get('/api/gps/recommendations', (req, res) => {
        console_log('[GpsRec] GET /api/gps/recommendations called', {
            lat: req.query.lat,
            lng: req.query.lng,
            deviceId: req.query.deviceId,
            categories: req.query.categories,
            limit: req.query.limit,
        });

        // --- Auth ---
        const { deviceId, deviceSecret, botSecret } = req.query;

        if (!deviceId) {
            console_log('[GpsRec] Auth failed: missing deviceId');
            return res.status(400).json({ success: false, error: 'deviceId is required' });
        }

        const device = devices[deviceId];
        if (!device) {
            console_log('[GpsRec] Auth failed: device not found', { deviceId });
            return res.status(404).json({ success: false, error: 'Device not found' });
        }

        const secretOk = deviceSecret && device.deviceSecret && safeEqual(device.deviceSecret, deviceSecret);
        const botOk = botSecret && Object.values(device.entities || {}).some(
            e => e.botSecret && safeEqual(e.botSecret, botSecret)
        );

        if (!secretOk && !botOk) {
            console_log('[GpsRec] Auth failed: invalid credentials', { deviceId, hasDeviceSecret: !!deviceSecret, hasBotSecret: !!botSecret });
            return res.status(403).json({ success: false, error: 'Invalid credentials' });
        }

        // --- Validate lat/lng ---
        const lat = parseFloat(req.query.lat);
        const lng = parseFloat(req.query.lng);

        if (isNaN(lat) || isNaN(lng)) {
            console_log('[GpsRec] Validation failed: invalid lat/lng', { lat: req.query.lat, lng: req.query.lng });
            return res.status(400).json({ success: false, error: 'lat and lng must be valid numbers' });
        }

        if (lat < -90 || lat > 90) {
            console_log('[GpsRec] Validation failed: lat out of range', { lat });
            return res.status(400).json({ success: false, error: 'lat must be between -90 and 90' });
        }

        if (lng < -180 || lng > 180) {
            console_log('[GpsRec] Validation failed: lng out of range', { lng });
            return res.status(400).json({ success: false, error: 'lng must be between -180 and 180' });
        }

        // --- Parse options ---
        const limit = Math.min(10, Math.max(1, parseInt(req.query.limit) || 3));
        const requestedCategories = req.query.categories
            ? req.query.categories.split(',').map(c => c.trim().toLowerCase())
            : ['restaurant', 'parking', 'attraction'];

        console_log('[GpsRec] Building recommendations', { lat, lng, limit, requestedCategories });

        // --- Build results ---
        const results = {};
        let totalCount = 0;

        if (requestedCategories.includes('restaurant')) {
            results.restaurants = RESTAURANTS.map(r => {
                const distM = computeDistance(lat, lng, r.lat_offset, r.lng_offset, r.base_distance_m);
                return {
                    id: r.id,
                    name: r.name,
                    name_en: r.name_en,
                    emoji: r.emoji,
                    category: r.category,
                    cuisine: r.cuisine,
                    rating: r.rating,
                    reviews: r.reviews,
                    price_level: r.price_level,
                    address: r.address,
                    address_en: r.address_en,
                    phone: r.phone,
                    hours: r.hours,
                    distance_m: distM,
                    walk_minutes: walkMinutes(distM),
                    lat: lat + r.lat_offset,
                    lng: lng + r.lng_offset,
                };
            })
            .sort((a, b) => a.distance_m - b.distance_m)
            .slice(0, limit);

            totalCount += results.restaurants.length;
            console_log('[GpsRec] Restaurants built', { count: results.restaurants.length });
        }

        if (requestedCategories.includes('parking')) {
            results.parking = PARKING_LOTS.map(p => {
                const distM = computeDistance(lat, lng, p.lat_offset, p.lng_offset, p.base_distance_m);
                const status = p.available_spaces === 0 ? 'full' : p.available_spaces < 20 ? 'limited' : 'available';
                return {
                    id: p.id,
                    name: p.name,
                    name_en: p.name_en,
                    emoji: p.emoji,
                    category: p.category,
                    available_spaces: p.available_spaces,
                    total_spaces: p.total_spaces,
                    status,
                    rate: p.rate,
                    address: p.address,
                    address_en: p.address_en,
                    hours: p.hours,
                    distance_m: distM,
                    walk_minutes: walkMinutes(distM),
                    lat: lat + p.lat_offset,
                    lng: lng + p.lng_offset,
                };
            })
            .sort((a, b) => a.distance_m - b.distance_m)
            .slice(0, limit);

            totalCount += results.parking.length;
            console_log('[GpsRec] Parking built', { count: results.parking.length });
        }

        if (requestedCategories.includes('attraction')) {
            results.attractions = ATTRACTIONS.map(a => {
                const distM = computeDistance(lat, lng, a.lat_offset, a.lng_offset, a.base_distance_m);
                return {
                    id: a.id,
                    name: a.name,
                    name_en: a.name_en,
                    emoji: a.emoji,
                    category: a.category,
                    subcategory: a.subcategory,
                    rating: a.rating,
                    reviews: a.reviews,
                    admission: a.admission,
                    address: a.address,
                    address_en: a.address_en,
                    hours: a.hours,
                    distance_m: distM,
                    walk_minutes: walkMinutes(distM),
                    lat: lat + a.lat_offset,
                    lng: lng + a.lng_offset,
                };
            })
            .sort((a, b) => a.distance_m - b.distance_m)
            .slice(0, limit);

            totalCount += results.attractions.length;
            console_log('[GpsRec] Attractions built', { count: results.attractions.length });
        }

        const payload = {
            success: true,
            userLocation: { lat, lng },
            results,
            totalCount,
            generatedAt: new Date().toISOString(),
        };

        console_log('[GpsRec] Response ready', { totalCount, categories: Object.keys(results) });
        return res.json(payload);
    });

    console_log('[GpsRec] GET /api/gps/recommendations registered successfully');
};
