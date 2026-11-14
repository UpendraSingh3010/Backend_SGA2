/**
 * Offline mock geocoder - deterministic results for a few known places.
 * Used by the automated tests and for demos without internet access
 * (GEO_PROVIDER=mock).
 */
const PLACES = [
  { keys: ['connaught place'], lat: 28.6315, lng: 77.2167, name: 'Connaught Place, New Delhi, India' },
  { keys: ['india gate'], lat: 28.6129, lng: 77.2295, name: 'India Gate, New Delhi, India' },
  { keys: ['karol bagh'], lat: 28.6519, lng: 77.1909, name: 'Karol Bagh, New Delhi, India' },
  { keys: ['saket'], lat: 28.5245, lng: 77.2066, name: 'Saket, New Delhi, India' },
  { keys: ['cyber city', 'gurugram', 'gurgaon'], lat: 28.495, lng: 77.089, name: 'Cyber City, Gurugram, India' },
  { keys: ['noida'], lat: 28.5708, lng: 77.3261, name: 'Sector 18, Noida, India' },
  { keys: ['new delhi', 'delhi'], lat: 28.6139, lng: 77.209, name: 'New Delhi, Delhi, India' },
  { keys: ['mumbai'], lat: 19.076, lng: 72.8777, name: 'Mumbai, Maharashtra, India' },
  { keys: ['bengaluru', 'bangalore'], lat: 12.9716, lng: 77.5946, name: 'Bengaluru, Karnataka, India' },
];

module.exports = {
  name: 'mock',

  async geocode(address) {
    const q = String(address).toLowerCase();
    const place = PLACES.find((p) => p.keys.some((k) => q.includes(k)));
    if (!place) return null;
    return { lat: place.lat, lng: place.lng, displayName: place.name, provider: 'mock' };
  },

  async reverse(lat, lng) {
    // Nearest known place by simple squared distance
    let best = null;
    let bestD = Infinity;
    for (const p of PLACES) {
      const d = (p.lat - lat) ** 2 + (p.lng - lng) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return { lat, lng, displayName: `Near ${best.name}`, provider: 'mock' };
  },
};
