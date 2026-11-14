const { Schema } = require('mongoose');
const { isValidLatLng } = require('../geo');

/** GeoJSON Point: { type: 'Point', coordinates: [lng, lat] } */
module.exports = new Schema(
  {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (c) => Array.isArray(c) && c.length === 2 && isValidLatLng(c[1], c[0]),
        message: 'coordinates must be [longitude, latitude] within valid ranges',
      },
    },
  },
  { _id: false }
);
