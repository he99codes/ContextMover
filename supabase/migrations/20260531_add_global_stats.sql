-- Create the global_stats table
CREATE TABLE IF NOT EXISTS global_stats (
  id INT PRIMARY KEY DEFAULT 1,
  total_migrations BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT single_row_check CHECK (id = 1)
);

-- Insert the initial row if it doesn't exist
INSERT INTO global_stats (id, total_migrations)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- Create a function to increment the total_migrations count
CREATE OR REPLACE FUNCTION increment_total_migrations(increment_value INT)
RETURNS void AS $$
  UPDATE global_stats
  SET total_migrations = total_migrations + increment_value
  WHERE id = 1;
$$ LANGUAGE sql VOLATILE;
