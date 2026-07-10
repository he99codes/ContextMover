/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { cache } from "react";
import { createClient } from "./server";

/**
 * React cache() deduplicates this call within a single request, so layout +
 * page both calling getCachedUser() results in exactly ONE Supabase round-trip.
 */
export const getCachedUser = cache(async () => {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});
