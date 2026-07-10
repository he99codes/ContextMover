-- Enable Row Level Security on the platform_configs table
ALTER TABLE public.platform_configs ENABLE ROW LEVEL SECURITY;

-- Drop any existing policies to ensure a clean slate
DROP POLICY IF EXISTS "Allow public read access to platform configs" ON public.platform_configs;

-- Create a new policy to allow public read-only access
CREATE POLICY "Allow public read access to platform configs"
ON public.platform_configs
FOR SELECT
USING (true);
