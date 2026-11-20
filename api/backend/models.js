
// Shoxy - Central AI Model Configuration
// No API keys belong in this file.

export const AI_TEAM = {
  builder: {
    name: "Builder",
    provider: "openrouter",
    model: "x-ai/grok-4.6",
    enabled: true
  },

  checker: {
    name: "Checker",
    provider: "openrouter",
    model: "google/gemini-3.7-flash",
    enabled: true
  },

  critic: {
    name: "Critic",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5",
    enabled: true
  },

  lite: {
    name: "Lite",
    provider: "openrouter",
    model: "google/gemini-3.5-flash-lite",
    enabled: true
  }
};

export function getTeamConfig() {
  return AI_TEAM;
}
