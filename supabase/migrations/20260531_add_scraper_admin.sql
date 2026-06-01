-- Create platform_configs table
CREATE TABLE IF NOT EXISTS platform_configs (
  platform_id TEXT PRIMARY KEY,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  selectors JSONB,
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT
);

-- Create scraper_bug_reports table
CREATE TABLE IF NOT EXISTS scraper_bug_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id TEXT,
  error_message TEXT,
  href TEXT,
  user_id UUID,
  reported_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'new' -- e.g., 'new', 'acknowledged', 'resolved'
);

-- Seed initial data from hardcoded selectors
-- This will be done in a separate step after creating the API
