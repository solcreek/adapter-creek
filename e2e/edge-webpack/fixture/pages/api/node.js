export default function handler(req, res) { res.json({ route: "pages-node", header: req.headers["x-from-mw"] ?? null }); }
