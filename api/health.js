export default function handler(req, res) {
  res.status(200).json({
    status: "online",
    service: "Shoxy Backend",
    version: "1.0.0"
  });
}
