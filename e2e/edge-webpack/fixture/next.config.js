// serverSourceMaps writes .js.map files beside the server chunks, which the
// worker bundle must leave out.
module.exports = { experimental: { serverSourceMaps: true } };
