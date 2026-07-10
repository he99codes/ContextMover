"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// [SECURITY] Read from env — must match ADMIN_EMAIL server-side guard in /api/admin/_guard.ts.
// Falls back to a nonsense value so the check always fails safely if the var is missing.
const ADMIN_EMAIL = (process.env.NEXT_PUBLIC_ADMIN_EMAIL ?? "").toLowerCase();
const supabase = createClient();

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.email?.toLowerCase() === ADMIN_EMAIL) {
        setAuthorized(true);
      } else {
        routerRef.current.replace("/");
      }
    });
  }, []);

  if (!authorized) return null;
  return <>{children}</>;
}
