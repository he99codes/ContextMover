CREATE OR REPLACE FUNCTION get_user_plan(p_user_id uuid)
RETURNS text
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COALESCE(
    (SELECT plan FROM subscriptions
     WHERE user_id = p_user_id
     AND (
       status IN ('active', 'authenticated', 'trialing')
       OR (status = 'cancelled'
           AND COALESCE(current_period_end, current_end) IS NOT NULL
           AND COALESCE(current_period_end, current_end) > now())
     )
     ORDER BY created_at DESC
     LIMIT 1),
    (SELECT plan FROM users WHERE id = p_user_id AND is_pro = true LIMIT 1),
    'free'
  );
$$;
