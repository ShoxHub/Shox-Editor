import { AI_TEAM } from "./backend/models.js";

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const models = Object.entries(AI_TEAM).map(([role, config]) => ({
    role,
    name: config.name,
    provider: config.provider,
    model: config.model,
    enabled: config.enabled
  }));

  return res.status(200).json({
    success: true,
    team: models
  });
}
