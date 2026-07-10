/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

export const WEBAPP_BASE      = "https://contextmover.com";
export const CHROME_STORE_URL = "https://chromewebstore.google.com/detail/contextmover/"; // append extension ID when published

export const ROUTES = {
  home:      "/",
  dashboard: "/dashboard",
  login:     "/auth",
  signup:    "/auth?mode=signup",
  pricing:   "/pricing",
  docs:      "/docs",
  analytics: "/analytics",
  settings:  "/settings",
  vault:     "/settings/vault",
  agents:    "/settings/agents",
  prompts:   "/settings/prompts",
  privacy:   "/privacy",
  terms:     "/terms",
} as const;
