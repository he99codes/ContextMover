"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Force dynamic rendering - this layout uses Supabase auth
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ADMIN_EMAIL = "priyanshu2164@gmail.com";
const supabase = createClient();

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.email === ADMIN_EMAIL) {
        setAuthorized(true);
      } else {
        routerRef.current.replace("/");
      }
    });
  }, []);

  if (!authorized) return null;
  return <>{children}</>;
}
