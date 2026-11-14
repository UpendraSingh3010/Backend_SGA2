/**
 * Mongoose plugin: clean JSON output for API responses.
 * `_id` -> `id`, removes `__v` and `passwordHash`, and runs an optional extra transform.
 */
module.exports = function toJSONPlugin(schema, { extra } = {}) {
  schema.set('toJSON', {
    versionKey: false,
    transform(doc, ret) {
      const { _id, passwordHash, ...rest } = ret; // eslint-disable-line no-unused-vars
      const out = _id !== undefined ? { id: String(_id), ...rest } : rest;
      return extra ? extra(out) : out;
    },
  });
};
