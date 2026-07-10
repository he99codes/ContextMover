-- Add a column to store a snippet of the DOM when a scraper fails.
ALTER TABLE public.scraper_bug_reports
ADD COLUMN dom_snippet TEXT;

-- Add a comment to describe the new column.
COMMENT ON COLUMN public.scraper_bug_reports.dom_snippet IS 'A snippet of the DOM outerHTML around the point of failure for debugging.';
